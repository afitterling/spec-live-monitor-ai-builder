# DEV-001 — Build status page

- **Status:** Implemented
- **Group:** Development tools
- **Source:** Product owner request, 2026-10-03: a web page that lists the specs and shows live where the work stands, coverage and overall progress as x % of 100 %, token usage and model
- **Last updated:** 2026-10-03

A read-only web page, reachable on a public CDN URL, that shows the state of
the editr rebuild while the work goes on.

## Requirement

### Hosting

1. The page **MUST** be its own SST app in `sst-dev/` (name `editr-status`),
   separate from the product stack in `sst/`, deployed to AWS (eu-central-1)
   with `npm run deploy` (stage `dev`).
2. It **MUST** be a Remix app on Lambda behind CloudFront and be reachable on
   the CloudFront URL of the stage.
3. The page **MUST** be read-only: it accepts no input that changes anything,
   offers no form and writes nowhere.
4. The page **MUST NOT** be indexed (`noindex` meta tag and `X-Robots-Tag`),
   framed (`X-Frame-Options: DENY`) or cached (`Cache-Control: no-store`).
5. The server **MUST** only be allowed to read the one status document
   (`s3:GetObject` on `data.json`), no wider permission.

### Content

6. The page **MUST** list every spec found in `specs/FRs` and `specs/NFRs`, with
   ID, title, group, state (Done, Started, Open), the platforms named in its
   Rebuild section (Web, iPad), its acceptance criteria as `met / total` with a
   progress bar, and the time of the last commit that names it.
7. Clicking a spec **MUST** open its details: every acceptance criterion with
   its state, the Rebuild section, the commits that name it and the spec file.
8. The page **MUST** show overall progress as one percentage and one progress
   bar: acceptance criteria met ÷ all acceptance criteria, over all specs. It
   **MUST** also show the same figure for FRs and for NFRs, and per group.
9. A spec **MUST** count as Done when its status is `Implemented`, as Started
   when it has a Rebuild section, otherwise as Open.
10. The page **MUST** show what is being worked on now, and why:
    - every uncommitted file, linked to specs in three ways, strongest first:
      it is the spec file, a spec's Rebuild section names it, or it cites the
      spec ID;
    - the linked specs ranked by that evidence, open specs before finished
      ones, each with its state, criteria bar, the evidence in words and its
      unchecked acceptance criteria as the tasks left;
    - the agent's activity: active or idle (last tool call within 10 minutes),
      the last tool, tool calls per tool in the last hour, files it edited;
    - with nothing uncommitted, that no spec is in progress and which commit
      finished last, instead of presenting that commit as current work.
11. The page **MUST** show the model in use and the token usage of the Claude
    Code sessions of this project: output, input and cache tokens in total, per
    model and per session, and output tokens per hour.
11a. The page **MUST** show how much of the Claude plan's usage limits is
    used, in percent per window (5-hour, week), with the time to reset and the
    time the figures were read. They come from the Claude Code status line
    (`scripts/statusline.mjs`); without them the page says so.
12. Token figures **MUST** be numbers, model names and timestamps only; agent
    activity adds tool names and repository-relative paths of edited files,
    and spec links add spec IDs. No prompt, answer, file content, tool input
    other than that path, or tool output may leave the machine.
13. The page **MUST** show the number of test cases per suite (web, iPad,
    browser checks) and the most recent commits.
14. The list **MUST** be filterable by text, by kind (FR / NFR), by state and
    by group.
14a. Every table **MUST** sort by any column, ascending and descending, on
    click of the column header (`aria-sort` set). Sorting **MUST** be stable:
    rows with equal values keep the order of the document. Empty values go
    last. At phone width, where columns are hidden, a sort control **MUST**
    offer the same.
14b. The page **MUST** offer jumps to FRs, NFRs and every group (navigation,
    progress legend, group rows), each filtering the list and scrolling to it,
    an "Expand all" control, and `#<spec id>` links that open one spec. Open
    specs show every acceptance criterion as a checked or unchecked box.

### Live

15. While open, the page **MUST** reload its data at least every 15 seconds
    without a page reload, and show how long ago the data was produced.
16. When no data has arrived for 30 minutes, the page **MUST** show that the
    status is stale.
17. Before the first push the page **MUST** say that no status exists yet.

### Look

18. The page **SHOULD** use the editr colour tokens (NFR-002) and **MUST** work
    at phone width without horizontal page scrolling: two-column key figures,
    stacked group bars, touch-sized controls.

## Acceptance criteria

- [x] `npm run deploy` in `sst-dev` prints a CloudFront URL that serves the page. *(Stage `dev`: https://dwzt1hbkdp0b3.cloudfront.net)*
- [x] All 41 specs of the repository are listed with their criteria counts. *(Checked locally.)*
- [x] The overall percentage equals criteria met ÷ all criteria (27 / 183 = 14.8 % on 2026-10-03). *(Checked locally.)*
- [x] Opening FR-021 shows its four criteria, three of them met, and its Rebuild section. *(Checked locally.)*
- [x] After a push the open page shows the new figures within 15 seconds, without a reload. *(`sst-dev/scripts/check-live.js`)*
- [x] The response carries `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`.
- [x] At 390 px width the page does not scroll sideways. *(Checked locally.)*
- [x] Clicking a column header sorts ascending, again descending; within equal values the document order stays, in both directions. *(Checked in headless Chrome: title asc/desc, state asc/desc stable.)*
- [x] "NFRs" shows only the 12 NFRs; "Expand all" shows their criteria as checked and unchecked boxes; `#FR-021` opens FR-021, also on a hash change. *(Checked in headless Chrome.)*
- [x] "Working on now" ranks FR-024 first while its files are being changed, with its five open criteria as tasks. *(Checked locally on 2026-10-03.)*
- [x] The usage limits show the 5-hour and weekly percentage with reset time. *(Checked locally: 39 % / 19 %.)*
- [x] At 390 px width the sort control is shown and nothing scrolls sideways. *(Checked in headless Chrome.)*
- [x] The pushed document contains no conversation text. *(By construction: from the transcripts only usage numbers, model names, timestamps and session ids are read.)*

## Rebuild

- **Stack:** `sst-dev/sst.config.ts` (Bucket `StatusData`, Remix `StatusSite`).
- **Page:** `sst-dev/app/routes/_index.tsx`, `sst-dev/app/root.tsx`, `sst-dev/app/styles.css`; raw document at `/data.json` (`sst-dev/app/routes/data[.]json.ts`).
- **Live check:** `sst-dev/scripts/check-live.js`, run with the headless-Chrome driver `sst/test/browser/cdp.mjs`.
- **Limits:** `sst-dev/scripts/statusline.mjs`, the Claude Code status line, keeps the latest limits in `.sst/limits.json`.
- **Data:** `sst-dev/scripts/collect.mjs` builds the document; `sst-dev/app/lib/status.server.ts` reads it from S3, or collects it directly under `npm run dev`.
