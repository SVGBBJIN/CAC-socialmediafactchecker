import Foundation

#if canImport(CryptoKit)
import CryptoKit
#elseif canImport(Crypto)
import Crypto
#endif

#if canImport(CryptoKit) || canImport(Crypto)

/// Reads credentials from an AES-256-GCM encrypted blob shipped in the app bundle.
///
/// # Threat model — read this before trusting it
///
/// This raises the cost of extracting the key from "run `strings` on the binary" to
/// "attach a debugger, or read the unwrap key out of the binary and run the same
/// derivation". It does **not** make the key secret from someone holding the device.
/// It cannot: the app must be able to decrypt without user input, so everything needed
/// to decrypt ships alongside the ciphertext. That is a property of client-side
/// secrets in general, not a weakness of this implementation.
///
/// What it does buy, and why it is worth having:
/// - The plaintext key is never in source control, never in a diff, never in a build log.
/// - It is not recoverable from a casual bundle dump or an App Store IPA unzip.
/// - Rotating the key is a resource swap, not a code change.
///
/// **The actual fix is to not ship the key at all**: proxy Gemini and Groq through a
/// backend that holds the provider keys and authenticates the app. Then the only thing
/// on-device is a revocable per-install token, and a leak costs one user rather than
/// the whole account's quota. ``ChainedSecretStore`` is shaped to make that migration a
/// configuration change — see docs/SECRETS.md.
public struct EncryptedSecretsBundle: SecretStore {
    private let ciphertext: Data
    // Held as raw material rather than a `SymmetricKey`, which isn't `Sendable`. The
    // key is derived at the point of use.
    private let keySeed: Data
    private let salt: String

    /// - Parameters:
    ///   - ciphertext: contents of `secrets.enc` — a combined AES-GCM sealed box.
    ///   - keySeed: the split seed reassembled by ``SecretsKeySeed``.
    ///   - salt: bound into the derived key so a blob lifted from this app can't be
    ///     decrypted by another one that happens to embed the same seed.
    public init(ciphertext: Data, keySeed: Data, salt: String) {
        self.ciphertext = ciphertext
        self.keySeed = keySeed
        self.salt = salt
    }

    /// Loads `secrets.enc` from a bundle.
    public init(
        bundle: Bundle = .main,
        resource: String = "secrets",
        extension ext: String = "enc",
        keySeed: Data,
        salt: String? = nil
    ) throws {
        guard let url = bundle.url(forResource: resource, withExtension: ext),
              let data = try? Data(contentsOf: url) else {
            throw ExtractionError.missingCredential(name: "\(resource).\(ext)")
        }
        // Default the salt to the bundle identifier: it is stable across launches and
        // differs between the app and any other binary that copies the blob.
        let effectiveSalt = salt ?? bundle.bundleIdentifier ?? "app.seer"
        self.init(ciphertext: data, keySeed: keySeed, salt: effectiveSalt)
    }

    static func deriveKey(seed: Data, salt: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: seed),
            salt: Data(salt.utf8),
            info: Data("seer.secrets.v1".utf8),
            outputByteCount: 32
        )
    }

    public func secret(named name: SecretName) throws -> String {
        let values = try decryptAll()
        guard let value = values[name.rawValue] else {
            throw ExtractionError.missingCredential(name: name.rawValue)
        }
        return value
    }

    /// Decrypts the blob into its name/value pairs.
    public func decryptAll() throws -> [String: String] {
        do {
            let box = try AES.GCM.SealedBox(combined: ciphertext)
            let plaintext = try AES.GCM.open(box, using: Self.deriveKey(seed: keySeed, salt: salt))
            return try JSONDecoder().decode([String: String].self, from: plaintext)
        } catch is DecodingError {
            throw ExtractionError.malformedResponse("secrets blob decrypted but is not a string dictionary")
        } catch {
            // A wrong seed and a corrupt file are indistinguishable here by design —
            // AES-GCM authentication failure carries no detail.
            throw ExtractionError.malformedResponse(
                "could not decrypt secrets blob (wrong key seed, or the file is damaged)"
            )
        }
    }

    /// Produces the blob. Used by the `seer-secrets` tool and by round-trip tests.
    public static func seal(_ values: [String: String], keySeed: Data, salt: String) throws -> Data {
        let plaintext = try JSONEncoder().encode(values)
        let box = try AES.GCM.seal(plaintext, using: deriveKey(seed: keySeed, salt: salt))
        guard let combined = box.combined else {
            throw ExtractionError.malformedResponse("failed to serialise sealed box")
        }
        return combined
    }
}

/// Reassembles the key seed from two halves that are XORed together.
///
/// The halves are emitted as separate generated constants so neither is a usable key
/// on its own and neither appears verbatim in the binary's data section. Again:
/// obfuscation, not secrecy — see the note on ``EncryptedSecretsBundle``.
public enum SecretsKeySeed {
    public static func reassemble(_ maskA: [UInt8], _ maskB: [UInt8]) -> Data {
        precondition(maskA.count == maskB.count, "key seed halves must be the same length")
        return Data(zip(maskA, maskB).map { $0 ^ $1 })
    }
}

#endif
