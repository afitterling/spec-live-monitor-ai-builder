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

/** Numbered requirements ("3. …", "11a. …") with their continuation lines, as { n, text }. */
function numbered(body) {
  const items = [];
  for (const line of body.split("\n")) {
    const m = /^(\d+[a-z]?)\.\s+(.+)$/.exec(line);
    if (m) items.push({ n: m[1], text: m[2].trim() });
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1].text += " " + line.trim();
    else if (/^\S/.test(line) && !/^#/.test(line)) continue;
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
    reqs: numbered(requirementBody),
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
 * `toolUses` (see toolUse()); their outcome (failed or not) comes from the
 * matching tool result. Nothing else of a call or its result is kept.
 */
function collectTokens(toolUses = []) {
  const seenTools = new Set();
  const failed = new Map();
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
    const agentFile = agent ? basename(file, ".jsonl") : null;
    for (const line of lines) {
      if (line.includes('"tool_result"')) {
        try {
          for (const c of JSON.parse(line).message?.content ?? []) {
            if (c?.type === "tool_result" && c.tool_use_id) failed.set(c.tool_use_id, c.is_error === true);
          }
        } catch {}
        continue;
      }
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
        toolUses.push(toolUse(c, o.timestamp, session, agentFile));
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
  for (const u of toolUses) if (failed.has(u.id)) u.failed = failed.get(u.id);
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

// ---------------------------------------------------------------- agent actions

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "ctx_read", "ctx_tree", "ctx_glob", "Glob", "Grep", "ctx_search"]);
const SHELL_TOOLS = new Set(["Bash", "ctx_shell"]);
/** "FR-031 §3", "NFR-030" — how code comments and commits cite the specs. */
const SPEC_REF = /\b(N?FR-\d{3})(?:\s?§\s?(\d+[a-z]?))?/g;

/** What a shell command does, as a fixed label: the command itself never leaves the machine. */
const COMMANDS = [
  [/\bsst (deploy|remove)\b|\bdeploy(:\w+)?\b/, "deploy"],
  [/\bvitest\b|\bnpm (run )?test\b|\bxcodebuild\b[^|;&]*\btest\b/, "tests"],
  [/cdp\.mjs|-check\.js/, "browser check"],
  [/\btsc\b|\btypecheck\b/, "typecheck"],
  [/\bxcodegen\b|\bxcodebuild\b|\bnpm run build\b|vite:build/, "build"],
  [/\bgit commit\b/, "commit"],
  [/\bgit push\b/, "push to git"],
  [/\bpush\.mjs\b|\bnpm run push\b/, "status push"],
  [/\bnpm (ci|install|i)\b/, "install"],
  [/\bgit (status|diff|log|show)\b/, "git look-up"],
  [/\bnpm run dev\b|\bsst dev\b/, "dev server"],
];
const commandLabel = (cmd) => (COMMANDS.find(([re]) => re.test(cmd)) ?? [null, "shell"])[1];

const repoPath = (file) => {
  if (typeof file !== "string") return null;
  const rel = relative(ROOT, file);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : null;
};

/**
 * One tool call, reduced to what the status page may show: tool name, kind,
 * repository paths, spec IDs and § numbers written by an edit, the command
 * label of a shell call, and for spec files which criteria an edit ticked
 * (kept as text only until they are matched to their index).
 */
function toolUse(c, at, session, agentFile) {
  const name = String(c.name ?? "").split("__").pop().slice(0, 40);
  const input = c.input ?? {};
  const use = { id: c.id, at, name, session, agent: agentFile, kind: "other" };
  if (EDIT_TOOLS.has(name)) {
    use.kind = name === "Write" ? "write" : "edit";
    use.path = repoPath(input.file_path ?? input.notebook_path);
    const written = [input.new_string, input.content, input.new_source, ...(input.edits ?? []).map((e) => e?.new_string)]
      .filter((t) => typeof t === "string")
      .join("\n");
    const before = [input.old_string, ...(input.edits ?? []).map((e) => e?.old_string)].filter((t) => typeof t === "string").join("\n");
    const refs = new Map();
    for (const m of written.matchAll(SPEC_REF)) refs.set(`${m[1]}§${m[2] ?? ""}`, { id: m[1], sec: m[2] ?? null });
    use.refs = [...refs.values()].slice(0, 12);
    if (use.path && /^specs\/(FRs|NFRs)\//.test(use.path)) {
      use.ticked = [...written.matchAll(/^- \[[xX]\] (.+)$/gm)]
        .map((m) => m[1].trim())
        .filter((t) => before.includes(`- [ ] ${t}`));
    }
  } else if (READ_TOOLS.has(name)) {
    use.kind = name.includes("search") || name === "Grep" || name.includes("glob") || name === "Glob" ? "search" : "read";
    use.path = repoPath(input.file_path ?? input.path ?? (Array.isArray(input.paths) ? input.paths[0] : null));
  } else if (SHELL_TOOLS.has(name)) {
    use.kind = "shell";
    use.label = typeof input.command === "string" ? commandLabel(input.command) : "shell";
  } else if (name === "Agent" || name === "Task") {
    use.kind = "subagent";
  }
  return use;
}

// ---------------------------------------------------------------- working on
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
  const specByFile = new Map(specs.map((s) => [s.file, s]));
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

  const live = liveWork(specs, toolUses, specByFile, known, now);

  const base = {
    live,
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

/** The agent counts as working on a spec when it touched it this recently. */
const FOCUS_MS = 15 * 60 * 1000;
const HALF_LIFE_MS = 3 * 60 * 1000;
const FEED_SIZE = 30;

/**
 * Live view of the latest session: what the agent does right now, in which
 * spec and which numbered requirement (§), and a feed of its last actions.
 *
 * Evidence per action, strongest first: an edit that writes "FR-031 §3"
 * (requirement 3 of FR-031), an edit that writes a spec ID, reading or editing
 * the spec file itself, editing a file whose code cites the spec.
 */
function liveWork(specs, toolUses, specByFile, known, now) {
  const last = toolUses.reduce((m, u) => (u.at && u.at > (m?.at ?? "") ? u : m), null);
  if (!last) return null;
  const session = last.session;
  const uses = toolUses.filter((u) => u.session === session && u.at).sort((a, b) => (a.at < b.at ? -1 : 1));

  const citedCache = new Map();
  const citedBy = (path) => {
    if (!citedCache.has(path)) {
      let ids = [];
      try {
        const abs = join(ROOT, path);
        if (statSync(abs).size < 2_000_000) ids = [...new Set(readFileSync(abs, "utf8").match(/\bN?FR-\d{3}\b/g) ?? [])].filter((id) => known.has(id));
      } catch {}
      citedCache.set(path, ids);
    }
    return citedCache.get(path);
  };

  /** Spec links of one action: [{ id, sec, how }]. */
  const linksOf = (u) => {
    const own = u.path ? specByFile.get(u.path) : null;
    if (own) return [{ id: own.id, sec: null, how: "spec" }];
    const refs = (u.refs ?? []).filter((r) => known.has(r.id)).map((r) => ({ ...r, how: r.sec ? "section" : "id" }));
    if (refs.length) return refs;
    if (u.kind === "edit" || u.kind === "write") return citedBy(u.path ?? "").slice(0, 4).map((id) => ({ id, sec: null, how: "file" }));
    return [];
  };

  // Focus: weigh the links of the last FOCUS_MS; an action loses half its
  // weight every HALF_LIFE_MS, so the headline follows the current step.
  const WEIGHT = { section: 3, id: 2, spec: 2, file: 0.5 };
  const focus = new Map();
  const ticked = [];
  for (const u of uses) {
    const age = now - Date.parse(u.at);
    const own = u.path ? specByFile.get(u.path) : null;
    for (const t of u.ticked ?? []) {
      const index = own?.criteria.findIndex((c) => c.text === t) ?? -1;
      if (own && index >= 0) ticked.push({ id: own.id, index, at: u.at });
    }
    if (age > FOCUS_MS) continue;
    const fresh = 0.5 ** (age / HALF_LIFE_MS);
    for (const l of linksOf(u)) {
      const f = focus.get(l.id) ?? { id: l.id, score: 0, lastAt: null, secs: new Map(), files: new Map() };
      f.score += WEIGHT[l.how] * fresh;
      if ((f.lastAt ?? "") < u.at) f.lastAt = u.at;
      if (l.sec) {
        const s = f.secs.get(l.sec) ?? { sec: l.sec, count: 0, lastAt: null };
        s.count++;
        s.lastAt = u.at;
        f.secs.set(l.sec, s);
      }
      if (u.path && (u.kind === "edit" || u.kind === "write")) f.files.set(u.path, u.at);
      focus.set(l.id, f);
    }
  }
  const ranked = [...focus.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((f) => {
      const spec = specs.find((s) => s.id === f.id);
      return {
        id: f.id,
        score: Math.round(f.score * 100) / 100,
        lastAt: f.lastAt,
        secs: [...f.secs.values()]
          .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
          .slice(0, 5)
          .map((s) => ({ ...s, text: spec?.reqs.find((r) => r.n === s.sec)?.text ?? null })),
        files: [...f.files].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 4).map(([path]) => path),
      };
    });

  // Feed: newest first, repeated identical actions folded into one row.
  const feed = [];
  for (const u of [...uses].reverse()) {
    const links = linksOf(u).filter((l) => l.how !== "file" || u.kind !== "read");
    const prev = feed[feed.length - 1];
    const key = `${u.kind}|${u.name}|${u.path ?? ""}|${u.label ?? ""}`;
    if (prev && prev.key === key && prev.agent === !!u.agent) {
      prev.count++;
      for (const l of links) if (!prev.specs.some((p) => p.id === l.id && p.sec === l.sec)) prev.specs.push({ id: l.id, sec: l.sec });
      continue;
    }
    if (feed.length >= FEED_SIZE) break;
    feed.push({
      key,
      at: u.at,
      kind: u.kind,
      tool: u.name,
      path: u.path ?? null,
      label: u.label ?? null,
      agent: !!u.agent,
      count: 1,
      // true: failed · false: finished · null: no result yet (still running)
      failed: u.failed ?? null,
      specs: links.slice(0, 6).map((l) => ({ id: l.id, sec: l.sec })),
    });
  }
  const agentsActive = new Set(uses.filter((u) => u.agent && now - Date.parse(u.at) < 2 * 60 * 1000).map((u) => u.agent)).size;

  return {
    session: session.slice(0, 8),
    active: now - Date.parse(last.at) < ACTIVE_MS,
    lastAt: last.at,
    running: feed[0]?.failed === null && feed[0]?.kind === "shell" ? feed[0].label : null,
    agentsActive,
    focus: ranked,
    feed: feed.map(({ key, ...f }) => f),
    ticked: ticked.filter((t) => now - Date.parse(t.at) < RECENT_MS).slice(-10).reverse(),
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
    version: 3,
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
