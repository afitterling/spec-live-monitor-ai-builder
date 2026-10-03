/// <reference path="./.sst/platform/config.d.ts" />

/**
 * editr-status — read-only build status of the editr rebuild.
 *
 *   StatusSite   Remix on Lambda behind CloudFront: lists every spec with its
 *                coverage, overall progress, what is being worked on, tokens
 *                and model. Polls for new data while the page is open.
 *   StatusData   private S3 bucket holding one document, data.json, written by
 *                `npm run push` (scripts/push.mjs) from the developer's machine.
 *
 * The site only reads; nothing in it accepts input or writes anywhere.
 */

const PROJECT = "editr-status";
const REGION = "eu-central-1";

export default $config({
  app(input) {
    const stage = input?.stage ?? "";
    return {
      name: PROJECT,
      home: "aws",
      removal: stage === "production" ? "retain" : "remove",
      providers: {
        aws: { region: REGION, defaultTags: { tags: { Project: PROJECT, Stage: stage, ManagedBy: "SST" } } },
      },
    };
  },
  async run() {
    const data = new sst.aws.Bucket("StatusData");

    const site = new sst.aws.Remix("StatusSite", {
      // Read access to the one status document, nothing else (no `*` actions).
      permissions: [{ actions: ["s3:GetObject"], resources: [$interpolate`${data.arn}/data.json`] }],
      environment: { STATUS_BUCKET: data.name },
      server: { architecture: "arm64", memory: "512 MB" },
    });

    return { url: site.url, bucket: data.name };
  },
});
