// The APK's versionCode comes from the GitHub Actions run number, so every
// build installs over the last one (Android refuses a same-or-lower code).
module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: Number(process.env.GITHUB_RUN_NUMBER || 1) },
});
