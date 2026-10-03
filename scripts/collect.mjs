// Collects the build status of editr into one JSON document:
//   - every spec in ../specs (status, group, requirements, acceptance criteria,
//     Rebuild section, platforms, commits that name it)
//   - test counts of both clients
//   - token usage and models of the Claude Code sessions in this project
//     (numbers, model names and timestamps only: no conversation content)
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

function collectTokens() {
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
  const latest = [...messages.values()].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return {
    source: "Claude Code session transcripts of this project (usage numbers only)",
    total,
    currentModel: latest?.model ?? null,
    lastActivity: latest?.at ?? null,
    byModel: [...byModel].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.output - a.output),
    sessions: [...sessions.values()]
      .map((s) => ({ ...s, models: [...s.models] }))
      .sort((a, b) => (a.last < b.last ? 1 : -1)),
    byHour: [...byHour].map(([hour, t]) => ({ hour, ...t })).sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

// ---------------------------------------------------------------- all

/**
 * What is being worked on now: specs whose file has uncommitted changes, else
 * the specs of the latest commit that named any.
 */
function workingOn(specs, commits) {
  // Every file, also inside new folders, so a single edit shows up.
  const changed = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  // Paths only, newest change first: the fine-grained view of the work in progress.
  const files = changed
    .map((f) => f.replace(/^"|"$/g, ""))
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(join(ROOT, f)).mtimeMs;
      } catch {}
      return { path: f, changedAt: mtime ? new Date(mtime).toISOString() : null };
    })
    .sort((a, b) => (a.changedAt ?? "") < (b.changedAt ?? "") ? 1 : -1)
    .slice(0, 25);
  const base = { changedFiles: changed.length, files };
  const byFile = specs.filter((s) => changed.some((f) => f === s.file || f.endsWith(basename(s.file))));
  if (byFile.length) return { reason: "uncommitted changes", ids: byFile.map((s) => s.id), ...base };
  const last = commits.find((c) => c.specs.length);
  return { reason: last ? `last commit ${last.hash}` : "none", ids: last?.specs ?? [], since: last?.date ?? null, ...base };
}

export function collect() {
  const { commits, bySpec } = collectCommits();
  const specs = collectSpecs(bySpec);
  return {
    workingOn: workingOn(specs, commits),
    version: 1,
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
    tokens: collectTokens(),
    commits: commits.slice(0, 40),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(collect(), null, 2) + "\n");
}
