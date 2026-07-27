import Foundation

#if canImport(Security)
import Security

/// Keychain-backed credential storage.
///
/// Items are written with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
/// - *AfterFirstUnlock* because the share extension can be invoked while the device is
///   locked, and `WhenUnlocked` would fail there.
/// - *ThisDeviceOnly* so the key never rides an iCloud Keychain sync or an encrypted
///   backup onto another device.
///
/// An access group lets the host app and the share extension share one item; without
/// it each target keeps its own copy and unwraps the ciphertext separately.
public struct KeychainSecretStore: WritableSecretStore {
    private let service: String
    private let accessGroup: String?

    public init(service: String = "app.seer.credentials", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(for name: SecretName) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name.rawValue,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    public func secret(named name: SecretName) throws -> String {
        var query = baseQuery(for: name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                throw ExtractionError.missingCredential(name: name.rawValue)
            }
            return value
        case errSecItemNotFound:
            throw ExtractionError.missingCredential(name: name.rawValue)
        default:
            throw KeychainError(status: status, operation: "read \(name.rawValue)")
        }
    }

    public func store(_ value: String, named name: SecretName) throws {
        guard let data = value.data(using: .utf8) else {
            throw ExtractionError.missingCredential(name: name.rawValue)
        }
        let query = baseQuery(for: name)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus, operation: "update \(name.rawValue)")
        }

        let addStatus = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError(status: addStatus, operation: "add \(name.rawValue)")
        }
    }

    public func removeSecret(named name: SecretName) throws {
        let status = SecItemDelete(baseQuery(for: name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status, operation: "delete \(name.rawValue)")
        }
    }
}

public struct KeychainError: Error, LocalizedError {
    public let status: OSStatus
    public let operation: String
    public var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Keychain \(operation) failed: \(message)"
    }
}

#endif
