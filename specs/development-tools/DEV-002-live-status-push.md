# DEV-002 — Live status push

- **Status:** Implemented
- **Group:** Development tools
- **Source:** Product owner request, 2026-10-03: the status page follows the real work live
- **Last updated:** 2026-10-03

Keeps the status page ([DEV-001](DEV-001-build-status-page.md)) current while
work continues in the repository, without redeploying the page.

## Requirement

1. `npm run push` in `sst-dev` **MUST** collect the status from the local
   repository and Claude Code transcripts and upload it as `data.json` to the
   deployed stack's bucket. The bucket is taken from the deploy outputs
   (`.sst/outputs.json`); before the first deploy the push **MUST** fail with a
   clear message.
2. A push **MUST** run automatically, so the page follows the work in fine steps:
   - after every Claude Code tool call in this project (`PostToolUse` hook),
     at most once every 3 seconds,
   - before every shell command (`PreToolUse` hook on `Bash` and the lean-ctx
     shell), so a running test, build or deploy shows as running,
   - at the end of every Claude Code turn (`Stop` hook), always, and
   - after every commit in the repository (git `post-commit` hook).
2a. The page **MUST** list the uncommitted files (paths only, newest change
   first), so a single edit shows up.
3. An automatic push **MUST** run in the background and **MUST NOT** fail,
   slow down or print into the commit or the session; errors are ignored.
4. Pushing **MUST** only send the status document of DEV-001 §12: no
   conversation content, no file content, no secrets.
5. A push **MUST NOT** redeploy the stack; only `npm run deploy` changes the page
   itself.

## Acceptance criteria

- [x] `npm run push` prints the overall percentage and the page URL.
- [x] A commit updates the page within a minute. *(Commit `d362698` was on the page within 25 s.)*
- [x] The end of a Claude Code turn updates the token figures on the page. *(The tool-call hook already pushes within seconds.)*
- [x] With the stack not deployed, the hooks do nothing and report nothing. *(`push.mjs --quiet` exits 0 without `.sst/outputs.json`.)*

## Rebuild

- **Push:** `sst-dev/scripts/push.mjs` (`--quiet` for hooks, `--throttle` for per-tool-call pushes).
- **Status line:** `statusLine` in the same `.claude/settings.local.json` runs `sst-dev/scripts/statusline.mjs`, which records the usage limits for the next push.
- **Hooks:** Claude Code `PreToolUse` (shell tools), `PostToolUse` (throttled) and `Stop` in `.claude/settings.local.json`, git `post-commit` in `.git/hooks/`, all running `sst-dev/scripts/push.mjs` in the background. Both hook locations are machine-local and not committed.
