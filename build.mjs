#!/usr/bin/env node
/**
 * build.mjs — Production build script for Nearby.
 *
 * Usage:
 *   node build.mjs                   → Windows only  (works on any OS)
 *   node build.mjs --all             → Windows + macOS  (macOS build requires running on a Mac)
 *   node build.mjs --mac             → macOS only  (must run on macOS)
 *   node build.mjs --win             → Windows only
 *   node build.mjs --win --publish   → build + upload to GitHub Releases (requires GH_TOKEN)
 *
 * Output: release/
 */

import { execSync }               from 'child_process';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join }                   from 'path';
import { fileURLToPath }          from 'url';
import { platform }               from 'os';
import { performance }            from 'perf_hooks';

const ROOT    = fileURLToPath(new URL('.', import.meta.url));
const pkg     = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;
const IS_MAC  = platform() === 'darwin';
const args         = process.argv.slice(2);
const wantPublish  = args.includes('--publish');
const platformArgs = args.filter((a) => a !== '--publish');
const wantMac      = platformArgs.includes('--mac') || platformArgs.includes('--all');
const wantWin      = platformArgs.includes('--win') || platformArgs.includes('--all') || platformArgs.length === 0;

// ─── helpers ──────────────────────────────────────────────────────────────────

function step(label) {
  process.stdout.write(`\n\x1b[1m▶ ${label}\x1b[0m\n`);
}

function ok(label, seconds) {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${label} \x1b[2m(${seconds}s)\x1b[0m\n`);
}

function warn(msg) {
  process.stdout.write(`\x1b[33m⚠\x1b[0m  ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\x1b[31m✗\x1b[0m  ${msg}\n`);
}

function run(cmd, label) {
  step(label);
  const t = performance.now();
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    ok(label, ((performance.now() - t) / 1000).toFixed(1));
  } catch (err) {
    fail(`${label} failed`);
    process.exit(1);
  }
}

// ─── GH_TOKEN ─────────────────────────────────────────────────────────────────
// process.env only contains variables that were present when this terminal
// session started. If GH_TOKEN was added to Windows user environment after
// the terminal opened, we read it directly from the registry so the user
// never has to restart their terminal or set it manually per-session.

function resolveGHToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  if (platform() === 'win32') {
    try {
      const out = execSync('reg query "HKCU\\Environment" /v GH_TOKEN 2>nul', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const match = out.match(/GH_TOKEN\s+REG_SZ\s+(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }

  return null;
}

if (wantPublish) {
  const token = resolveGHToken();
  if (!token) {
    fail('GH_TOKEN not found in process env or Windows user environment.');
    fail('Add it via: Start → "Edit environment variables" → New → GH_TOKEN');
    fail('Then open a new terminal, or set it inline:  $env:GH_TOKEN = "ghp_..."');
    process.exit(1);
  }
  process.env.GH_TOKEN = token; // make it available to electron-builder subprocess
}

// ─── preflight ────────────────────────────────────────────────────────────────

if (wantMac && !IS_MAC) {
  fail('macOS builds require running this script on a Mac.');
  fail('You can build Windows installers from any OS, but .dmg packaging uses Apple\'s toolchain.');
  process.stdout.write('\nRun without --mac / --all, or use a Mac or a CI runner with macOS.\n\n');
  process.exit(1);
}

process.stdout.write('\n\x1b[1mNearby — production build\x1b[0m\n');
process.stdout.write(`Platform : ${platform()}\n`);
process.stdout.write(`Targets  : ${[wantWin && 'win', wantMac && 'mac'].filter(Boolean).join(' + ')}\n`);
process.stdout.write(`Publish  : ${wantPublish ? 'yes → GitHub Releases' : 'no (local only)'}\n`);

// ─── clean ────────────────────────────────────────────────────────────────────

const distDir = join(ROOT, 'dist');
if (existsSync(distDir)) {
  step('Cleaning dist/');
  rmSync(distDir, { recursive: true, force: true });
  ok('Clean', '0.0');
}

// ─── build ────────────────────────────────────────────────────────────────────

const total = performance.now();

run('npm run build', 'Vite — compile renderer');

const publishFlag = wantPublish ? ' --publish always' : '';
if (wantWin) run(`npx electron-builder --win${publishFlag}`, 'Electron-builder — Windows (.exe NSIS)');
if (wantMac) run(`npx electron-builder --mac${publishFlag}`, 'Electron-builder — macOS (.dmg)');

// ─── summary ──────────────────────────────────────────────────────────────────

const elapsed = ((performance.now() - total) / 1000).toFixed(1);

process.stdout.write(`\n\x1b[1m\x1b[32m✓ Build complete\x1b[0m in ${elapsed}s\n`);
process.stdout.write(`  Output → \x1b[4mrelease/\x1b[0m\n\n`);

if (wantWin) process.stdout.write(`  Windows : release/Nearby Setup ${VERSION}.exe\n`);
if (wantMac) process.stdout.write(`  macOS   : release/Nearby-${VERSION}.dmg\n`);
if (wantPublish) process.stdout.write(`  GitHub  : https://github.com/${pkg.build?.publish?.owner}/${pkg.build?.publish?.repo}/releases/tag/v${VERSION}\n`);
process.stdout.write('\n');
