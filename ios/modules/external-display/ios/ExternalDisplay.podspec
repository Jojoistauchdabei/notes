Pod::Spec.new do |s|
  s.name           = 'ExternalDisplay'
  s.version        = '1.0.0'
  s.summary        = 'External display presentation mode'
  s.description    = 'Shows page content on an external display without UI chrome.'
  s.license        = 'MIT'
  s.author         = 'Federwerk'
  s.homepage       = 'https://federwerk.ponnet.org'
  s.platform       = :ios, '15.1'
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
