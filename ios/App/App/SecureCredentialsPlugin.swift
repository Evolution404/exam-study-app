import Capacitor
import Foundation
import Security

@objc(SecureCredentialsPlugin)
public final class SecureCredentialsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureCredentialsPlugin"
    public let jsName = "SecureCredentials"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.evolution404.shijuan.credentials"

    private func query(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A credential key is required", "INVALID_KEY")
            return
        }

        var request = query(for: key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Unable to read secure credential", "KEYCHAIN_READ_FAILED")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value") else {
            call.reject("A credential key and value are required", "INVALID_CREDENTIAL")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("Unable to encode secure credential", "KEYCHAIN_ENCODING_FAILED")
            return
        }

        let itemQuery = query(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd((itemQuery.merging(attributes) { _, new in new }) as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(itemQuery as CFDictionary, attributes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                call.reject("Unable to update secure credential", "KEYCHAIN_WRITE_FAILED")
                return
            }
        } else if status != errSecSuccess {
            call.reject("Unable to save secure credential", "KEYCHAIN_WRITE_FAILED")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A credential key is required", "INVALID_KEY")
            return
        }
        let status = SecItemDelete(query(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Unable to remove secure credential", "KEYCHAIN_REMOVE_FAILED")
            return
        }
        call.resolve()
    }
}
