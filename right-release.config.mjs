const team = "6KLGD3LLKF";

export default {
  schema: 1,
  app: "sellright",
  // The only right-release target is the iOS admin app, so the release version is its MARKETING_VERSION
  // (ios/project.yml); keep the two in step. The server packages deploy through their own scripts.
  version: "0.2.0",
  packageManager: "pnpm",
  deps: { workdirs: [".", "packages/admin"] },
  targets: {
    ios: {
      // Shared iOS recipe (bogusyogi/rightkit#349, rightkit docs/IOS-PACKAGE-RECIPE.md). Archive/export need the GUI session on the Mac.
      signed: true,
      signingContract: "ios-xcodebuild-archive-automatic-v1",
      iosPackage: {
        project: "ios/SellRightAdmin.xcodeproj",
        projectSpec: "ios/project.yml",
        scheme: "SellRightAdmin",
        configuration: "Release",
        teamId: team,
        bundleId: "app.sellright.ios.admin",
        exportMethod: "app-store-connect",
        signing: "automatic",
        buildNumber: "date",
        cleanup: { derivedData: true },
        checks: { plist: { ITSAppUsesNonExemptEncryption: false } },
        archive: "build/ios/SellRightAdmin.xcarchive",
        ipa: "build/ios/export/SellRightAdmin.ipa",
      },
      artifacts: ["build/ios/export/SellRightAdmin.ipa"],
      // TestFlight: the app id is looked up from the bundle id with the shared Keychain key.
      distribution: { provider: "app-store-connect", bundleId: "app.sellright.ios.admin", track: "testflight", groups: ["Internal"] },
    },
  },
};
