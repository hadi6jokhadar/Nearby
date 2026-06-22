Release a new version of Nearby: bumps the version, builds the Windows installer, publishes to GitHub Releases, and commits + tags the release. The auto-updater in running apps will pick up the new version within 10 s of each user's next launch.

**Usage:** `/release` · `/release patch` · `/release minor` · `/release major` · `/release 1.2.3`
Default when no argument: `patch`

---

## Step 1 — Read current config

Read `package.json`. Extract and note:
- `version` — current semver string
- `build.publish.owner` — GitHub owner
- `build.publish.repo` — GitHub repo name

---

## Step 2 — Preflight: one-time GitHub setup

Run all checks below. Stop and report clearly if any fails.

### 2a — Owner placeholder
If `build.publish.owner` is still `"YOUR_GITHUB_USERNAME"`:
- Ask: *"What is your GitHub username or organization name?"*
- Update `package.json` `build.publish.owner` with the answer.
- Re-read `owner` from the updated value.

### 2b — GH_TOKEN
Run: `echo $env:GH_TOKEN`

If the output is empty or the literal string `$env:GH_TOKEN`:
- Tell the user:
  ```
  GH_TOKEN is not set. Create a token at https://github.com/settings/tokens
  with the "repo" scope, then run in your terminal:

      $env:GH_TOKEN = "ghp_your_token_here"

  Then re-run /release.
  ```
- Stop. Do not proceed without a token.

### 2c — GitHub repo exists
Run: `gh repo view {owner}/{repo} --json name 2>&1`

If it exits with an error (repo not found):
- Ask: *"GitHub repo '{owner}/{repo}' doesn't exist yet. Create it as a public repo?"*
- If yes: run `gh repo create {owner}/{repo} --public --description "Floating team presence widget — no cloud required"`
- If no: stop.

### 2d — Git remote
Run: `git remote get-url origin 2>&1`

If no remote named `origin`:
- Run: `git remote add origin https://github.com/{owner}/{repo}.git`

---

## Step 3 — Determine new version

Parse the argument passed to this command (`$ARGUMENTS`):

| Argument | Action |
|----------|--------|
| `major`  | Increment major, reset minor + patch to 0 |
| `minor`  | Increment minor, reset patch to 0 |
| `patch` or empty | Increment patch |
| `x.y.z` (semver) | Use exactly as-is, validate it is > current version |

Calculate `NEW_VERSION`.

Run `npm version {NEW_VERSION} --no-git-tag-version` — this updates both `package.json` and `package-lock.json` without creating a git commit or tag.

Confirm: *"Bumping $CURRENT → $NEW_VERSION. Continue?"* — if user says no, stop.

---

## Step 4 — Build and publish

Run:
```
node build.mjs --win --publish
```

This:
1. Compiles the React renderer with Vite
2. Packages the Windows NSIS installer via electron-builder
3. Uploads `Nearby Setup {version}.exe` and `latest.yml` to a new GitHub Release (draft → published automatically)

Watch for errors and report them clearly if the build fails.

---

## Step 5 — Commit, tag, push

Run each command and confirm success before proceeding to the next:

```
git add package.json package-lock.json
git commit -m "chore: release v{NEW_VERSION}"
git tag v{NEW_VERSION}
git push origin master
git push origin v{NEW_VERSION}
```

If `git push` fails because there is no upstream set, run:
```
git push --set-upstream origin master
git push origin v{NEW_VERSION}
```

---

## Step 6 — Done

Print a success summary:

```
✓ Nearby v{NEW_VERSION} released

  Installer : release/Nearby Setup {NEW_VERSION}.exe
  GitHub    : https://github.com/{owner}/{repo}/releases/tag/v{NEW_VERSION}

Users on older versions will be notified automatically within 10 s of their next launch.
```
