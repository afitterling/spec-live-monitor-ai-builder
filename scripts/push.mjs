// Collects the status and uploads it to the deployed stack's bucket, where the
// page reads it. Run after `npm run deploy` (which writes .sst/outputs.json).
//
//   node scripts/push.mjs                    push once
//   node scripts/push.mjs --quiet            no output (for hooks)
//   node scripts/push.mjs --quiet --throttle at most one push per THROTTLE_S
//                                            seconds (for per-tool-call hooks)
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { collect } from "./collect.mjs";

const quiet = process.argv.includes("--quiet");
const throttle = process.argv.includes("--throttle");
const THROTTLE_S = 3;
const outputsFile = new URL("../.sst/outputs.json", import.meta.url);
const stampFile = new URL("../.sst/last-push", import.meta.url);

if (!existsSync(outputsFile)) {
  if (!quiet) console.error("Not deployed yet: run `npm run deploy` first.");
  process.exit(quiet ? 0 : 1);
}
if (throttle && existsSync(stampFile) && Date.now() - statSync(stampFile).mtimeMs < THROTTLE_S * 1000) {
  process.exit(0);
}
writeFileSync(stampFile, new Date().toISOString());
const { bucket, url } = JSON.parse(readFileSync(outputsFile, "utf8"));
const status = collect();

await new S3Client({ region: "eu-central-1" }).send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: "data.json",
    Body: JSON.stringify(status),
    ContentType: "application/json",
    CacheControl: "no-store",
  }),
);

if (!quiet) {
  const a = status.summary.all;
  console.log(
    `pushed ${(a.coverage * 100).toFixed(1)} % (${a.points.done}/${a.points.total} criteria, ${a.implemented}/${a.specs} specs) → ${url}`,
  );
}
