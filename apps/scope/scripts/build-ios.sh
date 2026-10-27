#!/usr/bin/env bash
# Builds Scope for iOS.
#   DEVELOPMENT_TEAM=<team> BUILD_NUMBER=<n> scripts/build-ios.sh ipa        # signed development IPA
#   scripts/build-ios.sh simulator                                           # arm64 simulator .app, signed to run locally
# Output: build/ios/Scope.ipa or build/ios/Scope-simulator.app
set -euo pipefail
mode="${1:-ipa}"
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
out="$app_dir/build/ios"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export SCOPE_BUILD_NUMBER="${BUILD_NUMBER:-1}"
export SCOPE_IOS_TEAM_ID="${DEVELOPMENT_TEAM:-}"
export EXPO_NO_GIT_STATUS=1 CI=1 NODE_ENV=production
mkdir -p "$out"
cd "$app_dir"

npx expo prebuild --clean --platform ios --no-install >"$out/prebuild.log" 2>&1 || { tail -40 "$out/prebuild.log"; exit 1; }
(cd ios && pod install >"$out/pods.log" 2>&1) || { tail -40 "$out/pods.log"; exit 1; }

workspace="$(ls -d ios/*.xcworkspace | head -1)"
scheme="$(basename "$workspace" .xcworkspace)"

if [ "$mode" = simulator ]; then
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -destination "generic/platform=iOS Simulator" -derivedDataPath "$out/sim-derived" \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build >"$out/xcodebuild-sim.log" 2>&1 || { grep -E 'error:|BUILD FAILED' "$out/xcodebuild-sim.log" | head -40; exit 1; }
  rm -rf "$out/Scope-simulator.app"
  cp -R "$out/sim-derived/Build/Products/Release-iphonesimulator/$scheme.app" "$out/Scope-simulator.app"
  echo "$out/Scope-simulator.app"
  exit 0
fi

[ -n "$SCOPE_IOS_TEAM_ID" ] || { echo "Set DEVELOPMENT_TEAM for a signed build" >&2; exit 1; }
rm -rf "$out/Scope.xcarchive" "$out/export"
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -destination generic/platform=iOS -archivePath "$out/Scope.xcarchive" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$SCOPE_IOS_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  archive >"$out/xcodebuild.log" 2>&1 || { grep -E 'error:|BUILD FAILED|ARCHIVE FAILED' "$out/xcodebuild.log" | head -40; exit 1; }
cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${EXPORT_METHOD:-debugging}</string>
  <key>teamID</key><string>$SCOPE_IOS_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/Scope.xcarchive" -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" -allowProvisioningUpdates >"$out/export.log" 2>&1 || { tail -30 "$out/export.log"; exit 1; }
cp "$(ls "$out"/export/*.ipa | head -1)" "$out/Scope.ipa"
echo "$out/Scope.ipa"
