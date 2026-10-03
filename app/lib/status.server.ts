// Where the status comes from: the pushed document in S3 when deployed, a
// fresh collection from the local repository under `npm run dev`.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Status } from "./types";

const s3 = new S3Client({});

export async function loadStatus(): Promise<Status | null> {
  const bucket = process.env.STATUS_BUCKET;
  if (!bucket) {
    const { collect } = await import("../../scripts/collect.mjs");
    return collect();
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "data.json" }));
    return JSON.parse(await res.Body!.transformToString("utf-8")) as Status;
  } catch (err) {
    if ((err as Error).name === "NoSuchKey") return null;
    throw err;
  }
}
