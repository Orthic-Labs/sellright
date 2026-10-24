const team = "6KLGD3LLKF";

export default {
  schema: 1,
  app: "sellright",
  // The only right-release target is the iOS admin app, so the release version is its MARKETING_VERSION
  // (ios/project.yml); keep the two in step. The server packages deploy through their own scripts.
  version: "0.2.0",
  packageManager: "pnpm",
  deps: { workdirs: [".", "packages/admin"] },
  // Everything the iOS archive reads: the XcodeGen spec, sources, widget, shared code and assets live under ios/.
  buildInputs: { include: ["ios/**", "right-release.config.mjs"], required: ["ios/project.yml", "right-release.config.mjs"] },
  // The hosted workflows are the web and server pipeline, not the iOS app's: the iOS app builds, signs and uploads only
  // through right-release on the Mac. right-release refuses any of them that reaches a secret but GITHUB_TOKEN, runs
  // release machinery or names the IPA or archive (@rightkit/release hosted-workflow-policy.mjs).
  hostedWorkflows: {
    policy: "declared-unrelated",
    files: {
      "ci.yml": {
        reason: "Web and server CI: lint, typecheck, tests, the Postgres-backed API suite, and the release, verify-appliance and verify-update jobs that push server images to ghcr.io with GITHUB_TOKEN; its iOS job only runs swift test on copied model sources",
        idToken: "cosign keyless signing of the server images pushed to ghcr.io (release, verify-update)",
      },
      "codeql.yml": "CodeQL code scanning for the TypeScript packages",
      "refresh-dependencies.yml": "Manual pnpm dependency refresh: runs the web verify and audit, then commits refreshed manifests and lockfiles; touches nothing under ios/",
    },
  },
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
