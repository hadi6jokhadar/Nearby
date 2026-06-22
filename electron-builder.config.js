const { execSync } = require('child_process');

// Resolve APPLE_TEAM_ID from env or auto-detect from the signing certificate in Keychain
function resolveTeamId() {
  if (process.env.APPLE_TEAM_ID) return process.env.APPLE_TEAM_ID;
  try {
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf-8' });
    const match = out.match(/Developer ID Application:.+\(([A-Z0-9]+)\)/);
    if (match) return match[1];
  } catch {}
  return undefined;
}

const teamId = resolveTeamId();

module.exports = {
  appId: 'com.yousale.nearby',
  productName: 'Nearby',
  files: ['electron.js', 'server.js', 'preload.js', 'logger.js', 'dist/**/*'],
  directories: { output: 'release' },
  win: {
    target: 'nsis',
    icon: 'src/assets/Nearby.ico',
  },
  mac: {
    target: 'dmg',
    icon: 'src/assets/Nearby.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'entitlements.mac.plist',
    entitlementsInherit: 'entitlements.mac.plist',
    notarize: teamId ? { teamId } : false,
    protocols: { name: 'nearby', schemes: ['nearby'] },
  },
  linux: {
    target: 'AppImage',
    icon: 'src/assets/Nearby.png',
  },
  protocols: { name: 'nearby', schemes: ['nearby'] },
  publish: {
    provider: 'github',
    owner: 'hadi6jokhadar',
    repo: 'Nearby',
    releaseType: 'release',
  },
};
