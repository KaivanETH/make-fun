# make.fun — entry monorepo

Single repository for all make.fun bounty entries of this account.
Older entries live in their own repositories and are left untouched.

## Layout

- `main` (this branch): index + `entries/<slug>/` — readable sources of every entry.
- Branch `<slug>` (one per bounty): **the committed entry exactly as submitted** —
  only that entry's files at the repository root (plus `LICENSE`, MIT/BSD), so the
  whole tree stays within the competition's byte caps. Submissions always point at
  `repo@commit` on that branch, never at `main`.

## Entries

| Bounty | Branch | Status |
|---|---|---|
| _(next bounty goes here)_ | | |

## Rules of the road

1. Never mix two bounties' files in one submitted commit — caps count the whole tree.
2. Repo created 2026-11-16; make.fun requires a repo created *after* a competition
   opens, so competitions opening after 2026-11-16 need their own fresh repo.
3. Do not rewrite history of already-submitted commits.