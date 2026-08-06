# Worktrees and disk

Every coding session gets its own **git worktree** — a separate working
directory sharing one `.git`. Two sessions on the same repository never see each
other's edits, never fight over the index, and never need a second clone.

This is also where your disk goes, so it is worth understanding.

## The shape

```
~/projects/myapp                 the repository you registered
~/worktrees/myapp-fix-login      a session working on `fix-login`
~/worktrees/myapp-add-metrics    another session, another branch
~/worktrees/myapp-ask-checkout   shared, read-only, for ask-mode sessions
```

`paths.worktreesDir` in `~/.opensession/config.json` decides where they live
(`OPENSESSION_WORKTREES_DIR` overrides it; the default is
`~/.opensession/worktrees`). One directory per session branch.

Creating a worktree installs dependencies — a repo-owned
`.opensession/setup.sh` or your configured `worktreeSetup`/`depsInstall`
command when present, plain `bun install` when there is a `package.json` — so a
session starts with dependencies already installed rather than spending its
first two minutes on `bun install`.

That script is half of a small convention: commit `.opensession/setup.sh` and
`.opensession/start.sh` to a repo and every worktree of it provisions itself
and can boot its dev server on demand — which is also what lets an agent open
its own change in a browser. See
[repo-lifecycle.md](repo-lifecycle.md).

## Modes

**`code` sessions** get their own worktree on their own branch. They can commit
and open a pull request. This is the default and the one that costs disk.

**`ask` sessions** are read-only, and share a single per-repo checkout
(`<repo>-ask-checkout`) pinned to the default branch. There is no point cutting a
fresh worktree for a session that cannot write, and a shared one keeps the cost
at one copy no matter how many questions you ask.

**Attached repos.** A session can attach additional repositories; each gets its
own isolated worktree, branched to match the session's primary branch so a
cross-repo change lines up. Attaching never reuses another repo's main checkout.

## The shared-checkout exception

A repository can be marked as a *shared checkout*, meaning its sessions all work
directly in the main clone instead of getting worktrees. Open Session's own
repository is configured this way, so that sessions improving Open Session are
editing the thing that is running.

It is a deliberate trade and it has sharp edges. In a shared checkout:

- **Only `add` → `commit` → `push`.** Never `git reset --hard`,
  `git checkout .`, `git revert`, or switching branches. Any of those yanks the
  working tree out from under the running server *and* every other session.
- **Stage specific files, never `git add -A`.** Other sessions have uncommitted
  work in the same tree; a broad `add` sweeps it into your commit.
- **Commit and push often.** Unpushed work is the only thing that cannot be
  recovered.

If you do not need sessions to edit the running server, do not use this mode.

## What cleans up on its own

A background sweep (`src/server/disk-gc.ts`) runs hourly:

- **Cold caches** — Rust `target/` build caches in worktrees untouched for more
  than 7 days are reclaimed unconditionally.
- **Disk pressure** — above 80% usage it reclaims the stalest caches until back
  under 70%, oldest first, and never touches a cache built in the last few hours.

Two safety properties are worth knowing, because they are what make an automatic
deleter safe to run at all:

- It reads `/proc` to check whether anything is using a path, and **skips the
  entire sweep** if it cannot — it would rather reclaim nothing than delete a
  directory out from under a live build.
- It only ever removes *regenerable* things — today that means Rust `target/`
  build caches. It does not delete worktrees, branches or commits, and it
  deliberately leaves `node_modules` alone (hardlinked into a shared store, so
  deleting a worktree's copy frees almost nothing).

Disable with `OPENSESSION_DISK_GC=0`.

Worktrees of archived sessions are swept separately after two weeks idle —
never with uncommitted changes or unpushed commits — and a removed worktree can
be revived: the branch still exists, so reopening the session re-creates the
directory.

## What does not clean up

**Worktrees for sessions you never archived.** They are cheap individually and
expensive in aggregate. `opensession doctor` will not nag you about this; check
your worktrees directory occasionally.

**The repository's own history.** If a clone is large, every worktree shares it
— that part is fine. What is not shared is anything the build produces.

In practice the disk hogs, in order:

1. **Rust `target/` directories.** These dwarf everything else — hundreds of
   gigabytes across a handful of worktrees is normal. If you build Rust, this is
   the only entry that matters. A shared `sccache` and `CARGO_TARGET_DIR` help
   more than any cleanup policy.
2. **Build output** — `dist`, `.next`, `build`.
3. **`node_modules`** — which looks worse than it is, because package managers
   hardlink into a shared store. Measuring with `du` counts each hardlink and
   overstates it dramatically; do not chase this one.

## Cleaning up by hand

```sh
# what exists, and how big
du -sh ~/worktrees/* | sort -h | tail -20

# a specific one — always via git, so the worktree registry stays consistent
git -C ~/projects/myapp worktree remove ~/worktrees/myapp-old-branch

# forget worktrees whose directories are already gone
git -C ~/projects/myapp worktree prune
```

Deleting a worktree directory with `rm -rf` leaves git believing it still
exists. `git worktree prune` fixes that, but `git worktree remove` avoids it.

Never remove a worktree with a running session in it — check
`opensession status` first, or look for a live process with `lsof`/`fuser`.
