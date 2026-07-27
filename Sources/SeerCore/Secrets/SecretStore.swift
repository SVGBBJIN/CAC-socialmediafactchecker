import Foundation

/// Names of the credentials the pipeline needs. Referring to secrets by a typed name
/// rather than a raw string keeps a typo from silently reading an empty value.
public struct SecretName: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public static let geminiAPIKey: SecretName = "GEMINI_API_KEY"
    public static let groqAPIKey: SecretName = "GROQ_API_KEY"
    /// Facebook App token for Instagram's oEmbed endpoint. See docs/SPIKE-instagram.md
    /// — this one can't be obtained without Meta app review.
    public static let metaOEmbedToken: SecretName = "META_OEMBED_TOKEN"
}

/// Somewhere a credential can be read from.
public protocol SecretStore: Sendable {
    func secret(named name: SecretName) throws -> String
}

extension SecretStore {
    public func requireSecret(named name: SecretName) throws -> String {
        let value = try secret(named: name)
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ExtractionError.missingCredential(name: name.rawValue)
        }
        return value
    }
}

/// In-memory store. For tests and for the proxy-backed configuration, where the app
/// holds a short-lived token rather than a long-lived provider key.
public struct InMemorySecretStore: SecretStore {
    private let values: [String: String]
    public init(_ values: [SecretName: String]) {
        self.values = Dictionary(uniqueKeysWithValues: values.map { ($0.key.rawValue, $0.value) })
    }
    public func secret(named name: SecretName) throws -> String {
        guard let value = values[name.rawValue] else {
            throw ExtractionError.missingCredential(name: name.rawValue)
        }
        return value
    }
}

/// Reads from the process environment, then from the app's `Info.plist`.
///
/// This is the *development* path: `Secrets.xcconfig` (gitignored) feeds build
/// settings into `Info.plist`, so a debug build works without anyone pasting a key
/// into source. It is not the shipping path — anything in `Info.plist` is plaintext
/// in the app bundle. See ``EncryptedSecretsBundle`` and docs/SECRETS.md.
public struct EnvironmentSecretStore: SecretStore {
    private let environment: [String: String]
    /// Flattened to strings at init: `Info.plist` is `[String: Any]`, which isn't
    /// `Sendable`, and only string entries could be credentials anyway.
    private let infoValues: [String: String]

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        infoDictionary: [String: Any]? = Bundle.main.infoDictionary
    ) {
        self.environment = environment
        self.infoValues = (infoDictionary ?? [:]).compactMapValues { $0 as? String }
    }

    public func secret(named name: SecretName) throws -> String {
        if let value = environment[name.rawValue], !value.isEmpty { return value }
        if let value = infoValues[name.rawValue], !value.isEmpty { return value }
        throw ExtractionError.missingCredential(name: name.rawValue)
    }
}

/// Tries each store in order and returns the first hit.
///
/// The intended order on device is: Keychain (what we cached last launch) → encrypted
/// bundle (what shipped) → environment (debug only). The first successful read from a
/// non-Keychain store is written back to the Keychain, so the ciphertext is unwrapped
/// once per install rather than once per share.
public struct ChainedSecretStore: SecretStore {
    private let stores: [any SecretStore]
    private let cache: (any WritableSecretStore)?

    public init(stores: [any SecretStore], cachingInto cache: (any WritableSecretStore)? = nil) {
        self.stores = stores
        self.cache = cache
    }

    public func secret(named name: SecretName) throws -> String {
        var lastError: Error = ExtractionError.missingCredential(name: name.rawValue)
        for store in stores {
            do {
                let value = try store.requireSecret(named: name)
                if let cache, !(store is any WritableSecretStore) {
                    // Best-effort: a caching failure must not fail the read.
                    try? cache.store(value, named: name)
                }
                return value
            } catch {
                lastError = error
            }
        }
        throw lastError
    }
}

/// A store that can be written to as well as read.
public protocol WritableSecretStore: SecretStore {
    func store(_ value: String, named name: SecretName) throws
    func removeSecret(named name: SecretName) throws
}
