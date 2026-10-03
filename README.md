# editr-status

Read-only build status page for the editr rebuild. It lists every spec with its
acceptance-criteria coverage, overall progress, what is being worked on, and
token usage and model, and follows the work live.

This is a development tool, not part of the product.

## How it works

- **StatusSite** — Remix on Lambda behind CloudFront (SST v3, AWS `eu-central-1`).
  It only reads; it accepts no input and writes nowhere.
- **StatusData** — private S3 bucket holding one document, `data.json`.
- `npm run push` collects the status from the local repository (specs, commits,
  uncommitted files) and the Claude Code transcripts and uploads it as
  `data.json`. The open page polls for new data.

The collector expects to sit in the `sst-dev/` folder of the editr repository
and reads the product specs from `../specs`.

## Commands

Node >= 22, npm.

```sh
npm install
npm run dev         # Remix on http://localhost:5299
npm run typecheck   # tsc --noEmit
npm run build       # remix vite:build
npm run deploy      # sst deploy --stage dev
npm run collect     # collect the status locally
npm run push        # collect and upload data.json to the deployed bucket
```

Deploy once before the first push: the bucket name comes from the deploy
outputs in `.sst/outputs.json`.

## Specs

The tool's own specs are in `specs/development-tools/`:

- [DEV-001](specs/development-tools/DEV-001-build-status-page.md) — Build status page
- [DEV-002](specs/development-tools/DEV-002-live-status-push.md) — Live status push
