// The APK's versionCode comes from the GitHub Actions run number, so every
// build installs over the last one (Android refuses a same-or-lower code).
// The iPhone build is made on the Mac in Xcode; App Store Connect refuses a
// build number it has seen, so IOS_BUILD_NUMBER is raised for each upload.
module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: Number(process.env.GITHUB_RUN_NUMBER || 1) },
  ios: { ...config.ios, buildNumber: String(process.env.IOS_BUILD_NUMBER || 1) },
});
