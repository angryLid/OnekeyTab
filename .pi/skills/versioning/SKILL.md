---
name: versioning
description: Release a new OnekeyTab version. Use when the user asks to release, bump the version, cut a release, or 发版 — pick the semver bump from the commit history and run pnpm release.
---

# Versioning OnekeyTab

Release a version by reading the history since the last tag, choosing the semver bump, and
letting `pnpm release` do the version bump, commit, and tag. The tag push (a host-side action
by the user) is what triggers the CI release workflow.

## Step 1 — Find the last release point

Run `git tag -l 'v*' --sort=-v:refname | head -1` to get the latest release tag (for example
`v0.13.1`). If no tag exists, treat the repo start as the release point and diff against the
empty tree.

## Step 2 — Choose the bump

List everything since that tag with `git log <tag>..HEAD --oneline`, and classify each commit:

- **New user-facing functionality** (a feature the user can do that they could not before) →
  bump **minor** (`y+1`, z resets). One feature is enough — the bump takes the highest tier.
- **Everything else** — fixes, refactors, docs, chores, CI → bump **patch** (`z+1`).
- **Breaking change** (workflow or settings behavior removed/changed incompatibly) → bump
  **major**, but state the reason and confirm with the user before proceeding.

Completion criterion: you can name the tier (major/minor/patch) and quote the commits that
decide it. If the tier is genuinely ambiguous, present the classification to the user and let
them pick.

## Step 3 — Preconditions

All must hold before releasing (each is checkable):

- Working tree is clean (`git status --porcelain` is empty) — `pnpm release` refuses otherwise.
- Current branch is `main`.
- The commits to be released are already pushed; a release tag should never point at history
  that exists only locally.

If any fails, stop and tell the user what to resolve — do not fix it yourself by committing
staged work unless the user asks.

## Step 4 — Release

Run `pnpm release <tier>` from Step 2. This bumps `package.json`, creates the release commit
(`chore(release): v<version>`), and tags it. Verify with `git log -1` and `git tag -l 'v*'`.

It does not push. End by giving the user the closing commands:

```bash
git push --follow-tags
```

Pushing the tag triggers the GitHub Actions release workflow (type check → test → version
guard → Chrome + Firefox zips → GitHub Release).
