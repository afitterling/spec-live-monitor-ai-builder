// Claude Code status line command. Claude Code hands it the session state as
// JSON on stdin; for a Claude subscription that includes `rate_limits`: how
// much of each usage limit (5-hour window, week) is used, in percent, and when
// the window resets. This keeps the latest figures in .sst/limits.json, where
// scripts/collect.mjs picks them up (DEV-001 §11a), and prints a short status
// line. Percentages and timestamps only; it must never fail or print an error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../.sst/", import.meta.url);
const SHORT = { five_hour: "5h", seven_day: "7d" };

// Claude Code gives the reset time as Unix seconds.
const iso = (t) => {
  const ms = typeof t === "number" ? t * 1000 : Date.parse(t ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

let line = "";
try {
  const state = JSON.parse(readFileSync(0, "utf8"));
  const windows = Object.entries(state.rate_limits ?? {})
    .filter(([, w]) => typeof w?.used_percentage === "number")
    .map(([key, w]) => ({ key, usedPct: w.used_percentage, resetsAt: iso(w.resets_at) }));
  // Without limits in the input (API key, or before the first response) the
  // last known figures stay in place.
  if (windows.length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("limits.json", dir), JSON.stringify({ at: new Date().toISOString(), windows }));
  }
  line = [state.model?.display_name, ...windows.map((w) => `${SHORT[w.key] ?? w.key} ${Math.round(w.usedPct)} %`)]
    .filter(Boolean)
    .join(" · ");
} catch {}
console.log(line);
