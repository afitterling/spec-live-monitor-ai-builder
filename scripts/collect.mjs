// Collects the build status of editr into one JSON document:
//   - every spec in ../specs (status, group, requirements, acceptance criteria,
//     Rebuild section, platforms, commits that name it)
//   - test counts of both clients
//   - token usage and models of the Claude Code sessions in this project
//     (numbers, model names and timestamps only: no conversation content)
//   - what is being worked on: uncommitted files, the specs they belong to
//     with their open acceptance criteria, and the agent's recent tool calls
//     (tool names and repository paths only)
//   - how much of the plan's usage limits is used, in percent, as last seen by
//     the status line (scripts/statusline.mjs)
//   - recent commits
//
//   node scripts/collect.mjs            prints the JSON
//   import { collect } from "./collect.mjs"
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SPECS = join(ROOT, "specs");
// Claude Code keeps one transcript folder per working directory.
// Written by scripts/statusline.mjs.
const LIMITS = fileURLToPath(new URL("../.sst/limits.json", import.meta.url));
const TRANSCRIPTS = join(homedir(), ".claude", "projects", ROOT.replace(/\/+$/, "").replace(/[^A-Za-z0-9]/g, "-"));

function walk(dir, match) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name !== "node_modules" && !name.startsWith(".")) out.push(...walk(path, match));
    } else if (match(name)) out.push(path);
  }
  return out;
}

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- specs

function sections(text) {
  const out = {};
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    out[part.slice(0, nl).trim()] = part.slice(nl + 1);
  }
  return out;
}

/** Top-level bullets of a section, each with its continuation lines joined. */
function bullets(body) {
  const items = [];
  for (const line of (body ?? "").split("\n")) {
    if (/^- /.test(line)) items.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += " " + line.trim();
  }
  return items;
}

function parseSpec(path) {
  const text = readFileSync(path, "utf8");
  const head = /^# ((?:N?FR)-\d+)\s+[—-]\s+(.+)$/m.exec(text);
  if (!head) return null;
  const field = (name) => new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, "m").exec(text)?.[1].trim() ?? "";
  const sec = sections(text);
  const requirementBody = sec["Requirement"] ?? sec["Requirements"] ?? "";
  const criteria = [];
  for (const m of (sec["Acceptance criteria"] ?? "").matchAll(/^- \[( |x|X)\] (.+)$/gm)) {
    criteria.push({ done: m[1] !== " ", text: m[2].trim() });
  }
  const rebuild = bullets(sec["Rebuild"]);
  const rebuildText = rebuild.join("\n");
  const status = field("Status") || "Draft";
  return {
    id: head[1],
    kind: head[1].startsWith("NFR") ? "NFR" : "FR",
    title: head[2].trim(),
    status,
    group: field("Group") || "Other",
    source: field("Source"),
    updated: field("Last updated"),
    file: relative(ROOT, path),
    requirements: (requirementBody.match(/^\d+\.\s/gm) ?? []).length,
    criteria,
    rebuild,
    started: rebuild.length > 0 || status === "Implemented",
    platforms: {
      web: /\*\*(Web|Backend|Upload|Pool)/i.test(rebuildText) || /`sst\//.test(rebuildText),
      ipad: /\*\*iPad/i.test(rebuildText) || /`swift\//.test(rebuildText),
    },
  };
}

function collectSpecs(commitsBySpec) {
  const files = walk(SPECS, (n) => /^(N?FR)-\d+.*\.md$/.test(n));
  const specs = files.map(parseSpec).filter(Boolean);
  specs.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id, "en", { numeric: true }) : a.kind === "FR" ? -1 : 1));
  for (const s of specs) {
    const commits = commitsBySpec.get(s.id) ?? [];
    s.commits = commits.slice(0, 10);
    s.lastCommit = commits[0]?.date ?? null;
    const done = s.criteria.filter((c) => c.done).length;
    s.points = { done, total: s.criteria.length };
  }
  return specs;
}

function summarise(specs) {
  const sum = (list) => {
    const done = list.reduce((n, s) => n + s.points.done, 0);
    const total = list.reduce((n, s) => n + s.points.total, 0);
    return {
      specs: list.length,
      implemented: list.filter((s) => s.status === "Implemented").length,
      started: list.filter((s) => s.started).length,
      superseded: list.filter((s) => /superseded/i.test(s.status)).length,
      points: { done, total },
      coverage: total ? done / total : 0,
      requirements: list.reduce((n, s) => n + s.requirements, 0),
    };
  };
  const groups = [];
  for (const s of specs) {
    const key = `${s.kind}:${s.group}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, kind: s.kind, name: s.group, ids: [] }));
    g.ids.push(s.id);
  }
  return {
    all: sum(specs),
    fr: sum(specs.filter((s) => s.kind === "FR")),
    nfr: sum(specs.filter((s) => s.kind === "NFR")),
    groups: groups.map((g) => ({ ...g, ...sum(specs.filter((s) => g.ids.includes(s.id))) })),
  };
}

// ---------------------------------------------------------------- git

function collectCommits() {
  const log = git("log", "--max-count=400", "--format=%h%x09%cI%x09%s");
  const commits = log
    ? log.split("\n").map((line) => {
        const [hash, date, ...rest] = line.split("\t");
        const subject = rest.join("\t");
        // Spec IDs lead the subject: "FR-001, FR-002: sign-in …"
        const prefix = subject.includes(":") ? subject.slice(0, subject.indexOf(":")) : "";
        const specs = [...prefix.matchAll(/\bN?FR-\d{3}\b/g)].map((m) => m[0]);
        return { hash, date, subject, specs };
      })
    : [];
  const bySpec = new Map();
  for (const c of commits) for (const id of c.specs) bySpec.set(id, [...(bySpec.get(id) ?? []), c]);
  return { commits, bySpec };
}

// ---------------------------------------------------------------- tests

function collectTests() {
  const count = (files, re) => files.reduce((n, f) => n + (readFileSync(f, "utf8").match(re) ?? []).length, 0);
  const webFiles = walk(join(ROOT, "sst", "test"), (n) => n.endsWith(".test.ts"));
  const iosFiles = walk(join(ROOT, "swift", "EditrTests"), (n) => n.endsWith(".swift"));
  const browserFiles = walk(join(ROOT, "sst", "test", "browser"), (n) => n.endsWith("-check.js"));
  return {
    web: { files: webFiles.length, cases: count(webFiles, /^\s*it\(\s*["'`]/gm) },
    ipad: { files: iosFiles.length, cases: count(iosFiles, /^\s*func test\w*\(/gm) },
    browser: { files: browserFiles.length, checks: count(browserFiles, /checks\[\s*["'`]/g) },
  };
}

// ---------------------------------------------------------------- tokens

/**
 * Token usage of the transcripts. Tool calls of the assistant are added to
 * `toolUses` as { at, name, session, path? }: the tool name, and for edits the
 * repository path of the file. Nothing else of the call is kept.
 */
function collectTokens(toolUses = []) {
  const seenTools = new Set();
  const files = walk(TRANSCRIPTS, (n) => n.endsWith(".jsonl"));
  // A message is written once per content block; the id makes it count once.
  const messages = new Map();
  const sessions = new Map();
  for (const file of files) {
    const agent = file.includes("/subagents/");
    const session = agent ? basename(join(file, "..", "..")) : basename(file, ".jsonl");
    let lines;
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = o.message;
      if (o.type !== "assistant" || !m?.usage || !m.id || !m.model || m.model.startsWith("<")) continue;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== "tool_use" || !c.id || seenTools.has(c.id)) continue;
        seenTools.add(c.id);
        // MCP tools are named mcp__<server>__<tool>; the tool part is enough.
        const use = { at: o.timestamp, name: String(c.name ?? "").split("__").pop().slice(0, 40), session };
        const file = EDIT_TOOLS.has(c.name) ? c.input?.file_path ?? c.input?.notebook_path : null;
        if (typeof file === "string") {
          const rel = relative(ROOT, file);
          if (rel && !rel.startsWith("..") && !rel.startsWith("/")) use.path = rel;
        }
        toolUses.push(use);
      }
      const u = m.usage;
      messages.set(m.id, {
        model: m.model,
        session,
        agent,
        at: o.timestamp,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      });
    }
  }

  const zero = () => ({ messages: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const add = (t, m) => {
    t.messages++;
    t.input += m.input;
    t.output += m.output;
    t.cacheWrite += m.cacheWrite;
    t.cacheRead += m.cacheRead;
  };
  const total = zero();
  const byModel = new Map();
  const byHour = new Map();
  for (const m of messages.values()) {
    add(total, m);
    if (!byModel.has(m.model)) byModel.set(m.model, zero());
    add(byModel.get(m.model), m);
    const s = sessions.get(m.session) ?? { id: m.session.slice(0, 8), ...zero(), agentMessages: 0, first: m.at, last: m.at, models: new Set() };
    add(s, m);
    if (m.agent) s.agentMessages++;
    s.models.add(m.model);
    if (m.at < s.first) s.first = m.at;
    if (m.at > s.last) s.last = m.at;
    sessions.set(m.session, s);
    const hour = (m.at ?? "").slice(0, 13);
    if (hour) {
      if (!byHour.has(hour)) byHour.set(hour, zero());
      add(byHour.get(hour), m);
    }
  }
  let limits = null;
  try {
    const l = JSON.parse(readFileSync(LIMITS, "utf8"));
    limits = { at: l.at, windows: l.windows.map(({ key, usedPct, resetsAt }) => ({ key, usedPct, resetsAt })) };
  } catch {}
  const latest = [...messages.values()].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return {
    source: "Claude Code session transcripts of this project (usage numbers only)",
    total,
    limits,
    currentModel: latest?.model ?? null,
    lastActivity: latest?.at ?? null,
    byModel: [...byModel].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.output - a.output),
    sessions: [...sessions.values()]
      .map((s) => ({ ...s, models: [...s.models] }))
      .sort((a, b) => (a.last < b.last ? 1 : -1)),
    byHour: [...byHour].map(([hour, t]) => ({ hour, ...t })).sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

// ---------------------------------------------------------------- working on

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const SPEC_ID = /\b(?:N?FR)-\d{3}\b/g;
/** The agent counts as active when its last tool call is this recent. */
const ACTIVE_MS = 10 * 60 * 1000;
const RECENT_MS = 60 * 60 * 1000;

/**
 * What is being worked on now, and how sure that is.
 *
 * Every uncommitted file is linked to specs in three ways, strongest first:
 * it is the spec file itself, a spec's Rebuild section names it, or the file
 * cites the spec ID (code comments cite the requirement they implement). The
 * specs are ranked by that evidence; their open acceptance criteria are the
 * tasks still to do. Without uncommitted changes nothing is in progress, and
 * the page says which commit finished last.
 */
function workingOn(specs, commits, toolUses) {
  const now = Date.now();
  const known = new Set(specs.map((s) => s.id));
  // Every file, also inside new folders, so a single edit shows up.
  const changed = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    // A rename shows as "old -> new".
    .map((f) => f.split(" -> ").pop());

  const recent = toolUses.filter((u) => u.at && now - Date.parse(u.at) < RECENT_MS);
  const agentEdits = new Map();
  for (const u of recent) if (u.path && (agentEdits.get(u.path) ?? "") < u.at) agentEdits.set(u.path, u.at);

  const files = changed
    .map((f) => {
      const abs = join(ROOT, f);
      let mtime = 0;
      let cited = [];
      const own = specs.find((s) => s.file === f);
      try {
        const st = statSync(abs);
        mtime = st.mtimeMs;
        // Only the IDs are kept, never the content.
        if (!own && st.isFile() && st.size < 2_000_000) {
          cited = [...new Set(readFileSync(abs, "utf8").match(SPEC_ID) ?? [])].filter((id) => known.has(id));
        }
      } catch {}
      const named = specs.filter((s) => s.rebuild.some((r) => r.includes(f))).map((s) => s.id);
      return {
        path: f,
        changedAt: mtime ? new Date(mtime).toISOString() : null,
        specFile: own?.id ?? null,
        named,
        cited,
        specs: [...new Set([own?.id, ...named, ...cited].filter(Boolean))],
        agentAt: agentEdits.get(f) ?? null,
      };
    })
    .sort((a, b) => ((a.changedAt ?? "") < (b.changedAt ?? "") ? 1 : -1));

  const ranked = new Map();
  for (const f of files) {
    const add = (id, key, weight) => {
      const r = ranked.get(id) ?? { id, score: 0, specFile: false, named: 0, cited: 0, files: 0, lastChange: null };
      if (key === "specFile") r.specFile = true;
      else r[key]++;
      r.score += weight;
      ranked.set(id, r);
    };
    if (f.specFile) add(f.specFile, "specFile", 3);
    for (const id of f.named) add(id, "named", 2);
    for (const id of f.cited) add(id, "cited", 1);
    for (const id of f.specs) {
      const r = ranked.get(id);
      r.files++;
      if ((r.lastChange ?? "") < (f.changedAt ?? "")) r.lastChange = f.changedAt;
    }
  }
  // Open work before finished specs whose files are touched again.
  const finished = new Set(specs.filter((s) => s.status === "Implemented").map((s) => s.id));
  const inProgress = [...ranked.values()]
    .sort(
      (a, b) =>
        Number(finished.has(a.id)) - Number(finished.has(b.id)) ||
        b.score - a.score ||
        ((a.lastChange ?? "") < (b.lastChange ?? "") ? 1 : -1),
    )
    .slice(0, 8);

  const last = toolUses.reduce((m, u) => (u.at && u.at > (m?.at ?? "") ? u : m), null);
  const counts = new Map();
  for (const u of recent) counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
  const activity = {
    active: !!last && now - Date.parse(last.at) < ACTIVE_MS,
    lastAt: last?.at ?? null,
    lastTool: last?.name ?? null,
    session: last?.session.slice(0, 8) ?? null,
    windowMin: RECENT_MS / 60000,
    calls: recent.length,
    tools: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    edited: agentEdits.size,
  };

  const base = {
    changedFiles: changed.length,
    unlinkedFiles: files.filter((f) => !f.specs.length).length,
    files: files.slice(0, 40).map(({ path, changedAt, specs: ids, agentAt }) => ({ path, changedAt, specs: ids, agentAt })),
    specs: inProgress,
    activity,
  };
  if (inProgress.length) return { mode: "uncommitted", reason: "uncommitted changes", ids: inProgress.map((r) => r.id), ...base };
  const lastCommit = commits.find((c) => c.specs.length);
  return {
    mode: changed.length ? "unlinked" : "idle",
    reason: lastCommit ? `last commit ${lastCommit.hash}` : "none",
    ids: [],
    lastDone: lastCommit ? { hash: lastCommit.hash, subject: lastCommit.subject, date: lastCommit.date, ids: lastCommit.specs } : null,
    ...base,
  };
}

// ---------------------------------------------------------------- all

export function collect() {
  const { commits, bySpec } = collectCommits();
  const specs = collectSpecs(bySpec);
  const toolUses = [];
  const tokens = collectTokens(toolUses);
  return {
    workingOn: workingOn(specs, commits, toolUses),
    version: 2,
    generatedAt: new Date().toISOString(),
    repo: {
      name: "editr",
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      head: git("rev-parse", "--short", "HEAD"),
      dirty: git("status", "--porcelain").split("\n").filter(Boolean).length,
    },
    summary: summarise(specs),
    specs,
    tests: collectTests(),
    tokens,
    commits: commits.slice(0, 40),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(collect(), null, 2) + "\n");
}
