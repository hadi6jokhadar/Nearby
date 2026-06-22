#!/usr/bin/env node
/**
 * build.mjs — Production build script for Nearby.
 *
 * Usage:
 *   node build.mjs          → Windows only  (works on any OS)
 *   node build.mjs --all    → Windows + macOS  (macOS build requires running on a Mac)
 *   node build.mjs --mac    → macOS only  (must run on macOS)
 *   node build.mjs --win    → Windows only
 *
 * Output: release/
 */

import { execSync }             from 'child_process';
import { rmSync, existsSync }   from 'fs';
import { join }                 from 'path';
import { fileURLToPath }        from 'url';
import { platform }             from 'os';
import { performance }          from 'perf_hooks';

const ROOT    = fileURLToPath(new URL('.', import.meta.url));
const IS_MAC  = platform() === 'darwin';
const args    = process.argv.slice(2);
const wantMac = args.includes('--mac') || args.includes('--all');
const wantWin = args.includes('--win') || args.includes('--all') || args.length === 0;

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

// ─── preflight ────────────────────────────────────────────────────────────────

if (wantMac && !IS_MAC) {
  fail('macOS builds require running this script on a Mac.');
  fail('You can build Windows installers from any OS, but .dmg packaging uses Apple\'s toolchain.');
  process.stdout.write('\nRun without --mac / --all, or use a Mac or a CI runner with macOS.\n\n');
  process.exit(1);
}

process.stdout.write('\n\x1b[1mNearby — production build\x1b[0m\n');
process.stdout.write(`Platform: ${platform()} | Targets: ${[wantWin && 'win', wantMac && 'mac'].filter(Boolean).join(' + ')}\n`);

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

if (wantWin) run('npx electron-builder --win', 'Electron-builder — Windows (.exe NSIS)');
if (wantMac) run('npx electron-builder --mac', 'Electron-builder — macOS (.dmg)');

// ─── summary ──────────────────────────────────────────────────────────────────

const elapsed = ((performance.now() - total) / 1000).toFixed(1);

process.stdout.write(`\n\x1b[1m\x1b[32m✓ Build complete\x1b[0m in ${elapsed}s\n`);
process.stdout.write(`  Output → \x1b[4mrelease/\x1b[0m\n\n`);

if (wantWin) {
  process.stdout.write('  Windows : release/Nearby Setup 1.0.0.exe\n');
}
if (wantMac) {
  process.stdout.write('  macOS   : release/Nearby-1.0.0.dmg\n');
}
process.stdout.write('\n');
