import type { ExpoConfig } from "expo/config";

/**
 * Scope: the fleet's phone app, built from a copy of apps/mobile. One variant.
 * No T3 Connect, Clerk, widgets or share extension; the fleet hub replaces
 * Connect for discovery and push. The Apple team comes from the environment
 * (SCOPE_IOS_TEAM_ID) so it never lands in the repo.
 */

const BUNDLE_IDENTIFIER = process.env.SCOPE_IOS_BUNDLE_ID?.trim() || "io.dafacility.fleetscope";
const APP_VERSION = process.env.SCOPE_VERSION ?? "1.0.0";
const BUILD_NUMBER = process.env.SCOPE_BUILD_NUMBER ?? "1";
const TEAM_ID = process.env.SCOPE_IOS_TEAM_ID?.trim();
/** "development" for device builds signed for development, "production" for ad hoc. */
const APS_ENVIRONMENT =
  process.env.SCOPE_APS_ENVIRONMENT === "production" ? "production" : "development";

const ASSETS = {
  icon: "./assets/scope/icon.png",
  splashIcon: "./assets/scope/splash.png",
  androidForeground: "./assets/scope/android-foreground.png",
  androidMonochrome: "./assets/scope/android-monochrome.png",
  androidBackgroundColor: "#0B1030",
  androidNotificationIcon: "./assets/android-notification-icon.png",
} as const;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const config: ExpoConfig = {
  name: "Scope",
  slug: "scope",
  platforms: ["ios", "android"],
  scheme: "scope",
  version: APP_VERSION,
  runtimeVersion: { policy: "appVersion" },
  orientation: "portrait",
  icon: ASSETS.icon,
  userInterfaceStyle: "automatic",
  updates: { enabled: false },
  ios: {
    icon: ASSETS.icon,
    supportsTablet: true,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    buildNumber: BUILD_NUMBER,
    ...(TEAM_ID ? { appleTeamId: TEAM_ID } : {}),
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${BUNDLE_IDENTIFIER}`],
      "aps-environment": APS_ENVIRONMENT,
      // Pending approvals break through Focus.
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
    infoPlist: {
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      // T3 servers and the hub are plain HTTP on the tailnet.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription:
        "Allow Scope to reach your hub and T3 servers on your tailnet.",
      NSFaceIDUsageDescription: "Scope uses Face ID to unlock your vault key.",
      NSPhotoLibraryAddUsageDescription: "Allow Scope to save images to your photo library.",
      UIBackgroundModes: ["audio", "remote-notification"],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: ASSETS.icon,
    package: "io.dafacility.fleetscope",
    adaptiveIcon: {
      backgroundColor: ASSETS.androidBackgroundColor,
      foregroundImage: ASSETS.androidForeground,
      monochromeImage: ASSETS.androidMonochrome,
    },
    predictiveBackGestureEnabled: true,
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  plugins: [
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: { fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold] },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-notifications",
      {
        icon: ASSETS.androidNotificationIcon,
        color: "#FFB23E",
        mode: APS_ENVIRONMENT,
      },
    ],
    "expo-web-browser",
    [
      "expo-audio",
      {
        microphonePermission: "Allow Scope to use your microphone for voice input.",
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow Scope to use the camera to scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: ASSETS.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#0B1030",
        imageWidth: 180,
        dark: { image: ASSETS.splashIcon, backgroundColor: "#0B1030" },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    ["expo-sensors", { motionPermission: false }],
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
  ],
  extra: {
    appVariant: "production",
    iosPersonalTeamBuild: false,
    // T3 Connect and Clerk are off in Scope; null keeps their code paths inert.
    relay: { url: null },
    clerk: { publishableKey: null, jwtTemplate: null },
    observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    apsEnvironment: APS_ENVIRONMENT,
    /** Optional default hub URL baked into a build, e.g. https://hub.example.ts.net. */
    defaultHubUrl: process.env.SCOPE_DEFAULT_HUB_URL ?? null,
  },
  experiments: {
    reactCompiler: true,
  },
};

export default config;
