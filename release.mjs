#!/usr/bin/env node
/**
 * release.mjs — Bump version, commit, tag, and push to trigger CI.
 *
 * GitHub Actions then builds, signs (Windows via SignPath, macOS via Apple),
 * and publishes both installers to GitHub Releases automatically.
 *
 * Usage:
 *   node release.mjs            → patch bump  (1.0.2 → 1.0.3)
 *   node release.mjs minor      → minor bump  (1.0.2 → 1.1.0)
 *   node release.mjs major      → major bump  (1.0.2 → 2.0.0)
 *   node release.mjs 1.2.3      → exact version
 *   node release.mjs --yes      → skip confirmation prompt
 */

import { execSync }      from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { join }          from 'path';

const ROOT     = fileURLToPath(new URL('.', import.meta.url));
const PKG_PATH = join(ROOT, 'package.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd, inherit = false) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: inherit ? 'inherit' : 'pipe',
  })?.trim();
}

function step(msg) { process.stdout.write(`\n\x1b[1m▶ ${msg}\x1b[0m\n`); }
function ok(msg)   { process.stdout.write(`\x1b[32m✓\x1b[0m  ${msg}\n`); }
function fail(msg) { process.stderr.write(`\x1b[31m✗\x1b[0m  ${msg}\n`); process.exit(1); }

function prompt(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function bumpVersion(current, arg) {
  if (arg && /^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [major, minor, patch] = current.split('.').map(Number);
  if (arg === 'major') return `${major + 1}.0.0`;
  if (arg === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;   // default: patch
}

// ── parse args ───────────────────────────────────────────────────────────────

const args      = process.argv.slice(2).filter(a => a !== '--yes');
const skipPrompt = process.argv.includes('--yes');
const bumpArg   = args[0];  // 'minor' | 'major' | '1.2.3' | undefined

// ── preflight ────────────────────────────────────────────────────────────────

const pkg        = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bumpArg);

if (oldVersion === newVersion) fail(`Already at version ${oldVersion}.`);

// Abort if working tree is dirty (package.json excluded — we'll update it)
const dirty = run('git status --porcelain')
  .split('\n')
  .filter(l => l.trim() && !l.match(/package(-lock)?\.json/));

if (dirty.length) {
  fail(`Uncommitted changes — commit or stash before releasing:\n\n  ${dirty.join('\n  ')}`);
}

// Warn if not on master
const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'master') {
  process.stdout.write(`\x1b[33m⚠\x1b[0m  Current branch is "${branch}", not "master".\n`);
}

// ── confirm ──────────────────────────────────────────────────────────────────

process.stdout.write(`\n\x1b[1mNearby — release\x1b[0m\n`);
process.stdout.write(`\n  ${oldVersion}  →  \x1b[1;32mv${newVersion}\x1b[0m\n`);
process.stdout.write(`\n  Will commit, tag, and push — GitHub Actions builds + signs + publishes.\n`);

if (!skipPrompt) {
  const answer = await prompt('\n  Continue? [Y/n] ');
  if (answer.toLowerCase() === 'n') {
    process.stdout.write('\nAborted.\n\n');
    process.exit(0);
  }
}

// ── bump version ─────────────────────────────────────────────────────────────

step('Bumping version');
// npm version updates both package.json and package-lock.json cleanly
run(`npm version ${newVersion} --no-git-tag-version`, false);
ok(`package.json + package-lock.json → ${newVersion}`);

// ── commit ───────────────────────────────────────────────────────────────────

step('Committing');
run('git add package.json package-lock.json');
run(`git commit -m "chore: bump to v${newVersion}"`);
ok(`chore: bump to v${newVersion}`);

// ── tag ──────────────────────────────────────────────────────────────────────

step(`Tagging v${newVersion}`);

// Remove stale local tag if it exists
const localTags = run('git tag').split('\n');
if (localTags.includes(`v${newVersion}`)) {
  run(`git tag -d v${newVersion}`);
  process.stdout.write(`  (removed stale local tag v${newVersion})\n`);
}

// Remove stale remote tag if it exists
try {
  run(`git push origin :refs/tags/v${newVersion}`);
  process.stdout.write(`  (removed stale remote tag v${newVersion})\n`);
} catch {}

run(`git tag v${newVersion}`);
ok(`v${newVersion}`);

// ── push ─────────────────────────────────────────────────────────────────────

step(`Pushing to origin`);
run(`git push origin ${branch}`, true);
run(`git push origin v${newVersion}`, true);

// ── done ─────────────────────────────────────────────────────────────────────

const remoteUrl = run('git remote get-url origin')
  .replace(/^git@github\.com:/, 'https://github.com/')
  .replace(/\.git$/, '');

process.stdout.write(`\n\x1b[1m\x1b[32m✓ Released v${newVersion}\x1b[0m\n`);
process.stdout.write(`\n  Actions : ${remoteUrl}/actions\n`);
process.stdout.write(`  Release : ${remoteUrl}/releases/tag/v${newVersion}\n\n`);
