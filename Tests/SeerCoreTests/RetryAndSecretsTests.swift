import XCTest
@testable import SeerCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class RetryPolicyTests: XCTestCase {
    func testBackoffGrowsExponentiallyAndCaps() {
        let policy = RetryPolicy(maxRetries: 5, baseDelay: 1, maxDelay: 8)
        // randomness: 1 removes the jitter so the curve itself is testable.
        XCTAssertEqual(policy.delay(forAttempt: 1, randomness: 1), 1)
        XCTAssertEqual(policy.delay(forAttempt: 2, randomness: 1), 2)
        XCTAssertEqual(policy.delay(forAttempt: 3, randomness: 1), 4)
        XCTAssertEqual(policy.delay(forAttempt: 4, randomness: 1), 8)
        XCTAssertEqual(policy.delay(forAttempt: 5, randomness: 1), 8, "must cap at maxDelay")
    }

    func testJitterScalesTheDelay() {
        let policy = RetryPolicy(baseDelay: 4, maxDelay: 100)
        XCTAssertEqual(policy.delay(forAttempt: 1, randomness: 0), 0)
        XCTAssertEqual(policy.delay(forAttempt: 1, randomness: 0.5), 2)
    }

    func testStatusClassification() {
        XCTAssertEqual(retryDecision(forStatus: 429, retryAfter: 5), .retry(after: 5))
        XCTAssertEqual(retryDecision(forStatus: 503, retryAfter: nil), .retry(after: nil))
        XCTAssertEqual(retryDecision(forStatus: 408, retryAfter: nil), .retry(after: nil))
        // 404 must not be retried — on the Gemini path it means "no such model", which
        // is a signal to move to the next model, not to wait.
        XCTAssertEqual(retryDecision(forStatus: 404, retryAfter: nil), .fail)
        XCTAssertEqual(retryDecision(forStatus: 400, retryAfter: nil), .fail)
        XCTAssertEqual(retryDecision(forStatus: 401, retryAfter: nil), .fail)
    }

    func testCancellationIsNeverRetried() {
        XCTAssertFalse(isRetryableTransportError(CancellationError()))
        XCTAssertTrue(isRetryableTransportError(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        ))
        XCTAssertFalse(isRetryableTransportError(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL)
        ))
    }

    func testParsesNumericRetryAfterHeader() {
        let response = HTTPURLResponse(
            url: URL(string: "https://example.com")!, statusCode: 429,
            httpVersion: nil, headerFields: ["Retry-After": "12"]
        )!
        XCTAssertEqual(RetryingHTTPClient.retryAfterSeconds(from: response), 12)
    }

    func testExtractsUpstreamErrorMessage() {
        let body = Data(#"{"error":{"code":429,"message":"Quota exceeded for model"}}"#.utf8)
        XCTAssertEqual(
            RetryingHTTPClient.errorMessage(from: body, status: 429),
            "Quota exceeded for model"
        )
    }
}

final class RetryingHTTPClientTests: XCTestCase {
    private func makeClient(
        _ transport: StubTransport,
        sleeper: ImmediateSleeper,
        policy: RetryPolicy = RetryPolicy(maxRetries: 3, baseDelay: 1, maxDelay: 8, overallTimeout: 60)
    ) -> RetryingHTTPClient {
        RetryingHTTPClient(transport: transport, policy: policy, serviceName: "Test", sleeper: sleeper)
    }

    private var request: URLRequest { URLRequest(url: URL(string: "https://example.com/v1/thing")!) }

    func testRetriesTransientFailuresThenSucceeds() async throws {
        let transport = StubTransport([
            .error(503, message: "overloaded"),
            .error(503, message: "overloaded"),
            .ok(#"{"ok":true}"#),
        ])
        let sleeper = ImmediateSleeper()
        let data = try await makeClient(transport, sleeper: sleeper).send(request)

        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"ok":true}"#)
        let count = await transport.requestCount
        XCTAssertEqual(count, 3)
        let delays = await sleeper.recorded
        XCTAssertEqual(delays.count, 2, "one sleep per retry")
    }

    func testDoesNotRetryClientErrors() async {
        let transport = StubTransport([.error(400, message: "bad request")])
        _ = try? await makeClient(transport, sleeper: ImmediateSleeper()).send(request)
        let count = await transport.requestCount
        XCTAssertEqual(count, 1)
    }

    func testGivesUpAfterMaxRetries() async {
        let transport = StubTransport(Array(repeating: .error(500), count: 10))
        let policy = RetryPolicy(maxRetries: 2, baseDelay: 1, maxDelay: 4, overallTimeout: 60)
        do {
            _ = try await makeClient(transport, sleeper: ImmediateSleeper(), policy: policy).send(request)
            XCTFail("expected failure")
        } catch {
            let count = await transport.requestCount
            XCTAssertEqual(count, 3, "initial attempt plus 2 retries")
        }
    }

    func testHonoursRetryAfterHeader() async throws {
        let transport = StubTransport([
            .error(429, message: "slow down", headers: ["Retry-After": "7"]),
            .ok("{}"),
        ])
        let sleeper = ImmediateSleeper()
        _ = try await makeClient(transport, sleeper: sleeper).send(request)
        let delays = await sleeper.recorded
        XCTAssertEqual(delays, [7], "server guidance should win over the backoff curve")
    }

    /// A hostile or mistaken `Retry-After` must not park a share extension for an hour.
    func testClampsAbsurdRetryAfter() async throws {
        let transport = StubTransport([
            .error(429, headers: ["Retry-After": "3600"]),
            .ok("{}"),
        ])
        let sleeper = ImmediateSleeper()
        let policy = RetryPolicy(maxRetries: 2, baseDelay: 1, maxDelay: 8, overallTimeout: 60)
        _ = try await makeClient(transport, sleeper: sleeper, policy: policy).send(request)
        let delays = await sleeper.recorded
        XCTAssertEqual(delays, [8], "must clamp to maxDelay")
    }

    func testRetriesTransportTimeouts() async throws {
        let transport = StubTransport(
            [.ok("{}")],
            transportErrors: [NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)]
        )
        let data = try await makeClient(transport, sleeper: ImmediateSleeper()).send(request)
        XCTAssertEqual(String(data: data, encoding: .utf8), "{}")
    }
}

final class SecretStoreTests: XCTestCase {
    func testChainFallsThroughToTheNextStore() throws {
        let chain = ChainedSecretStore(stores: [
            InMemorySecretStore([:]),
            InMemorySecretStore([.geminiAPIKey: "from-second"]),
        ])
        XCTAssertEqual(try chain.secret(named: .geminiAPIKey), "from-second")
    }

    func testChainThrowsWhenNoStoreHasTheSecret() {
        let chain = ChainedSecretStore(stores: [InMemorySecretStore([:])])
        XCTAssertThrowsError(try chain.secret(named: .groqAPIKey)) { error in
            guard case ExtractionError.missingCredential(let name) = error else {
                return XCTFail("got \(error)")
            }
            XCTAssertEqual(name, "GROQ_API_KEY")
        }
    }

    /// A whitespace-only value is a misconfiguration, not a credential.
    func testBlankValuesAreTreatedAsMissing() {
        let store = InMemorySecretStore([.geminiAPIKey: "   "])
        XCTAssertThrowsError(try store.requireSecret(named: .geminiAPIKey))
    }

    func testEnvironmentStorePrefersEnvironmentOverInfoPlist() throws {
        let store = EnvironmentSecretStore(
            environment: ["GEMINI_API_KEY": "from-env"],
            infoDictionary: ["GEMINI_API_KEY": "from-plist"]
        )
        XCTAssertEqual(try store.secret(named: .geminiAPIKey), "from-env")
    }

    func testEnvironmentStoreFallsBackToInfoPlist() throws {
        let store = EnvironmentSecretStore(
            environment: [:], infoDictionary: ["GROQ_API_KEY": "from-plist"]
        )
        XCTAssertEqual(try store.secret(named: .groqAPIKey), "from-plist")
    }

    /// The one that matters: no credential is ever written into source. This test
    /// walks the committed tree looking for anything shaped like a provider key.
    func testNoCredentialsAreCommittedToSource() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // SeerCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // repo root

        // Google API keys are `AIza` + 35 chars; Groq keys are `gsk_` + base62.
        let patterns = ["AIza[0-9A-Za-z_-]{35}", "gsk_[0-9A-Za-z]{20,}", "sk-[0-9A-Za-z]{32,}"]
        let regexes = try patterns.map { try NSRegularExpression(pattern: $0) }

        let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey]
        )
        var offenders: [String] = []

        while let url = enumerator?.nextObject() as? URL {
            let path = url.path
            if path.contains("/.build/") || path.contains("/.git/") {
                enumerator?.skipDescendants()
                continue
            }
            guard ["swift", "plist", "json", "md", "xcconfig", "yml", "yaml", "sh"]
                .contains(url.pathExtension) else { continue }
            guard let contents = try? String(contentsOf: url, encoding: .utf8) else { continue }

            let range = NSRange(contents.startIndex..., in: contents)
            for regex in regexes where regex.firstMatch(in: contents, range: range) != nil {
                offenders.append(path.replacingOccurrences(of: root.path, with: ""))
            }
        }

        XCTAssertTrue(
            offenders.isEmpty,
            "credential-shaped strings found in committed files: \(offenders.joined(separator: ", "))"
        )
    }
}

#if canImport(CryptoKit) || canImport(Crypto)
final class EncryptedSecretsTests: XCTestCase {
    private let seed = Data((0..<32).map { UInt8($0) })

    func testSealAndOpenRoundTrip() throws {
        let values = ["GEMINI_API_KEY": "the-real-key", "GROQ_API_KEY": "another-key"]
        let blob = try EncryptedSecretsBundle.seal(values, keySeed: seed, salt: "com.example.seer")

        let bundle = EncryptedSecretsBundle(ciphertext: blob, keySeed: seed, salt: "com.example.seer")
        XCTAssertEqual(try bundle.decryptAll(), values)
        XCTAssertEqual(try bundle.secret(named: .geminiAPIKey), "the-real-key")
    }

    /// The plaintext must not be recoverable from the blob by inspection — this is the
    /// minimum bar for "encrypted rather than hardcoded".
    func testPlaintextDoesNotAppearInTheCiphertext() throws {
        let blob = try EncryptedSecretsBundle.seal(
            ["GEMINI_API_KEY": "SUPERSECRETVALUE"], keySeed: seed, salt: "com.example.seer"
        )
        let asText = String(decoding: blob, as: UTF8.self)
        XCTAssertFalse(asText.contains("SUPERSECRETVALUE"))
        XCTAssertFalse(asText.contains("GEMINI_API_KEY"))
    }

    func testWrongSeedFailsToDecrypt() throws {
        let blob = try EncryptedSecretsBundle.seal(
            ["GEMINI_API_KEY": "k"], keySeed: seed, salt: "com.example.seer"
        )
        let wrong = EncryptedSecretsBundle(
            ciphertext: blob, keySeed: Data(repeating: 9, count: 32), salt: "com.example.seer"
        )
        XCTAssertThrowsError(try wrong.decryptAll())
    }

    /// The salt binds the blob to one app, so lifting `secrets.enc` out of this bundle
    /// and dropping it into another one doesn't work.
    func testSaltBindsTheBlobToTheApp() throws {
        let blob = try EncryptedSecretsBundle.seal(
            ["GEMINI_API_KEY": "k"], keySeed: seed, salt: "com.example.seer"
        )
        let otherApp = EncryptedSecretsBundle(
            ciphertext: blob, keySeed: seed, salt: "com.attacker.app"
        )
        XCTAssertThrowsError(try otherApp.decryptAll())
    }

    /// AES-GCM is authenticated: a flipped byte must fail, not decrypt to garbage.
    func testTamperedCiphertextIsRejected() throws {
        var blob = try EncryptedSecretsBundle.seal(
            ["GEMINI_API_KEY": "k"], keySeed: seed, salt: "com.example.seer"
        )
        blob[blob.count - 1] ^= 0xFF
        let bundle = EncryptedSecretsBundle(ciphertext: blob, keySeed: seed, salt: "com.example.seer")
        XCTAssertThrowsError(try bundle.decryptAll())
    }

    func testKeySeedReassemblesFromSplitHalves() {
        let maskA: [UInt8] = (0..<32).map { _ in UInt8.random(in: 0...255) }
        let original = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let maskB = zip(original, maskA).map { $0 ^ $1 }

        XCTAssertEqual(SecretsKeySeed.reassemble(maskA, maskB), original)
        // Neither half is the seed on its own.
        XCTAssertNotEqual(Data(maskA), original)
        XCTAssertNotEqual(Data(maskB), original)
    }
}
#endif
