// The raw status document, for scripts and debugging.
import { json } from "@remix-run/node";
import { loadStatus } from "../lib/status.server";

export async function loader() {
  const status = await loadStatus();
  if (!status) return json({ error: "No status pushed yet." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return json(status, { headers: { "Cache-Control": "no-store" } });
}
