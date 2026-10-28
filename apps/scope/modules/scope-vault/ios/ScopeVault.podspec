Pod::Spec.new do |s|
  s.name           = 'ScopeVault'
  s.version        = '1.0.0'
  s.summary        = 'Secure Enclave key and HPKE for the Scope vault.'
  s.description    = 'Holds a P-256 key in the Secure Enclave (software key on the simulator) and re-seals the vault key to the metaserver.'
  s.author         = 'da-facility'
  s.homepage       = 'https://github.com/da-facility/t3-code'
  s.platforms      = { :ios => '18.0' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit', 'LocalAuthentication', 'Security'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
