# DEV-003 — Bug tickets from GitHub

- **Status:** Implemented
- **Group:** Development tools
- **Source:** Product owner request, 2026-10-03: read the bug tickets from GitHub and show them on the status page
- **Last updated:** 2026-10-03

The status page ([DEV-001](DEV-001-build-status-page.md)) lists the bug
tickets of the editr repository's GitHub issues next to the specs.

## Requirement

1. The push ([DEV-002](DEV-002-live-status-push.md)) **MUST** read the issues
   with the label `bug` (open and closed) of the repository's GitHub remote
   (`origin`) through the `gh` CLI and its own login. No GitHub token is stored
   by the tool.
2. GitHub **MUST** be asked at most once a minute; pushes in between reuse the
   last answer (`.sst/bugs.json`). When GitHub cannot be reached, the page
   **MUST** keep the last known list and say so.
3. The document **MUST** contain per ticket only: number, title, state, other
   labels, assignee logins, created / updated / closed time, issue URL and the
   spec IDs named in its title or text. The ticket text itself **MUST NOT**
   leave the machine: the repository is private and the page is public.
4. The page **MUST** show the bugs in a table with number (linking to the
   issue), title, state, linked specs, opened and updated time; filterable by
   open, closed and all (open by default) and sortable by every column like the
   other tables (DEV-001 §14a).
5. The navigation **MUST** show the number of open bugs and jump to the list.
6. The details of a spec **MUST** list the bugs that name it.
7. Without tickets the page **MUST** say that there are none, naming the
   repository and the label.

## Acceptance criteria

- [x] With no `bug` issues in `mindyourstep/editr` the page says so. *(Checked on 2026-10-03.)*
- [x] Two sample tickets show as one open by default and both under "All"; sorting by number ascending gives #3, #7. *(Checked locally in headless Chrome with a sample cache.)*
- [x] A ticket naming FR-024 shows the chip FR-024 and appears in the details of FR-024. *(Checked locally.)*
- [x] The pushed document holds no ticket text. *(By construction: the text is read only for spec IDs.)*

## Rebuild

- **Data:** `collectBugs()` in `sst-dev/scripts/collect.mjs` (gh CLI, 60 s cache in `.sst/bugs.json`).
- **Page:** `BugList` and the bug section of the spec details in `sst-dev/app/routes/_index.tsx`.
