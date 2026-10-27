import CryptoKit
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

// The phone's vault key: a P-256 key-agreement key in the Secure Enclave, usable only after
// Face ID (biometryCurrentSet). Simulators have no Secure Enclave, so they get a software key in
// the Keychain instead; `isHardwareBacked` tells the two apart. The vault key K never leaves
// this file: `unlock` opens the hub's wrapped copy and re-seals it to the hub's ephemeral key.

private let keychainService = "io.dafacility.scope.vault"
private let keychainAccount = "vault-key"
private let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
private let infoWrappedKey = Data("scope/vault-key/v1".utf8)
private let infoUnlock = Data("scope/unlock/v1".utf8)

enum ScopeVaultError: Error, CustomStringConvertible {
  case keychain(OSStatus)
  case noKey
  case badInput(String)

  var description: String {
    switch self {
    case .keychain(let status): return "Keychain error \(status)"
    case .noKey: return "This phone has no vault key yet."
    case .badInput(let what): return "Invalid \(what)"
    }
  }
}

private enum StoredKey {
  case enclave(SecureEnclave.P256.KeyAgreement.PrivateKey)
  case software(P256.KeyAgreement.PrivateKey)

  var publicKey: P256.KeyAgreement.PublicKey {
    switch self {
    case .enclave(let key): return key.publicKey
    case .software(let key): return key.publicKey
    }
  }
}

private func readBlob() throws -> (Data, Bool)? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: keychainAccount,
    kSecReturnData as String: true,
    kSecReturnAttributes as String: true,
  ]
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  if status == errSecItemNotFound { return nil }
  guard status == errSecSuccess, let attributes = item as? [String: Any],
    let data = attributes[kSecValueData as String] as? Data
  else { throw ScopeVaultError.keychain(status) }
  let label = attributes[kSecAttrLabel as String] as? String
  return (data, label == "enclave")
}

private func writeBlob(_ data: Data, enclave: Bool) throws {
  deleteBlob()
  let attributes: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: keychainAccount,
    kSecAttrLabel as String: enclave ? "enclave" : "software",
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    kSecValueData as String: data,
  ]
  let status = SecItemAdd(attributes as CFDictionary, nil)
  guard status == errSecSuccess else { throw ScopeVaultError.keychain(status) }
}

private func deleteBlob() {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: keychainAccount,
  ]
  SecItemDelete(query as CFDictionary)
}

private func loadKey(context: LAContext?) throws -> StoredKey? {
  guard let (blob, enclave) = try readBlob() else { return nil }
  if enclave {
    return .enclave(
      try SecureEnclave.P256.KeyAgreement.PrivateKey(
        dataRepresentation: blob, authenticationContext: context))
  }
  return .software(try P256.KeyAgreement.PrivateKey(rawRepresentation: blob))
}

private func createKey() throws -> StoredKey {
  if SecureEnclave.isAvailable {
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet], &error)
    else { throw error!.takeRetainedValue() as Error }
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    try writeBlob(key.dataRepresentation, enclave: true)
    return .enclave(key)
  }
  let key = P256.KeyAgreement.PrivateKey()
  try writeBlob(key.rawRepresentation, enclave: false)
  return .software(key)
}

private func decode(_ base64: String, _ what: String) throws -> Data {
  guard let data = Data(base64Encoded: base64) else { throw ScopeVaultError.badInput(what) }
  return data
}

public class ScopeVaultModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScopeVault")

    Function("isHardwareBacked") { () -> Bool in
      SecureEnclave.isAvailable
    }

    // Returns the public key (uncompressed SEC1, base64), creating the key on first use.
    AsyncFunction("ensureKey") { () -> String in
      let key = try loadKey(context: nil) ?? createKey()
      return key.publicKey.x963Representation.base64EncodedString()
    }

    AsyncFunction("resetKey") { () -> String in
      deleteBlob()
      return try createKey().publicKey.x963Representation.base64EncodedString()
    }

    // Opens the hub's wrapped vault key with Face ID and seals it to the hub's ephemeral key.
    AsyncFunction("unlock") {
      (deviceId: String, wrappedEnc: String, wrappedCt: String, hubPublicKey: String, challengeId: String, reason: String)
        async throws -> [String: String] in
      let context = LAContext()
      context.localizedReason = reason
      guard let key = try loadKey(context: context) else { throw ScopeVaultError.noKey }
      if case .software = key {
        // The simulator's software key still asks for the device passcode or biometrics when available.
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
          try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        }
      }
      let encapsulated = try decode(wrappedEnc, "wrapped key")
      let ciphertext = try decode(wrappedCt, "wrapped key")
      var vaultKey: Data
      switch key {
      case .enclave(let privateKey):
        var recipient = try HPKE.Recipient(
          privateKey: privateKey, ciphersuite: suite, info: infoWrappedKey, encapsulatedKey: encapsulated)
        vaultKey = try recipient.open(ciphertext, authenticating: Data(deviceId.utf8))
      case .software(let privateKey):
        var recipient = try HPKE.Recipient(
          privateKey: privateKey, ciphersuite: suite, info: infoWrappedKey, encapsulatedKey: encapsulated)
        vaultKey = try recipient.open(ciphertext, authenticating: Data(deviceId.utf8))
      }
      defer { vaultKey.resetBytes(in: 0..<vaultKey.count) }
      let hubKey = try P256.KeyAgreement.PublicKey(x963Representation: try decode(hubPublicKey, "hub key"))
      var sender = try HPKE.Sender(recipientKey: hubKey, ciphersuite: suite, info: infoUnlock)
      let sealed = try sender.seal(vaultKey, authenticating: Data(challengeId.utf8))
      return ["enc": sender.encapsulatedKey.base64EncodedString(), "ct": sealed.base64EncodedString()]
    }
  }
}
