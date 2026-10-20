// electron-builder afterSign hook: ad-hoc sign the macOS app (free, no Apple Developer account).
//
// Without any signature, Apple Silicon Macs refuse to open a downloaded app with "Stagelight is
// damaged and can't be opened". An ad-hoc signature turns that into the normal "unidentified
// developer" prompt, which people can get past with System Settings → Privacy & Security →
// Open Anyway. Only a paid Developer ID plus notarization removes the prompt entirely.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // --deep also signs the nested helpers, frameworks and the bundled uv binary.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
