// Ad-hoc sign the packed app (no Apple Developer ID): Apple Silicon refuses to run unsigned code, and a
// consistent signature lets macOS keep the app's permissions across launches. Runs before dmg/zip.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // node-pty's helper must be executable (npm may install it without the bit).
  execFileSync('/bin/sh', ['-c', `find "${app}/Contents/Resources/app/node_modules/node-pty" -name spawn-helper -exec chmod 755 {} +`], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
