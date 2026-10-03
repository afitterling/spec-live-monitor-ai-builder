// Shape of data.json, written by scripts/collect.mjs.

export interface Points {
  done: number;
  total: number;
}

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  specs: string[];
}

export interface Spec {
  id: string;
  kind: "FR" | "NFR";
  title: string;
  status: string;
  group: string;
  source: string;
  updated: string;
  file: string;
  requirements: number;
  /** Numbered requirements; absent in documents before version 3. */
  reqs?: { n: string; text: string }[];
  criteria:{ done: boolean; text: string; blocked?: boolean }[];
  /** Open criteria: waiting for the owner or a third party, and doable by the agent. */
  open?: { blocked: number; workable: number };
  rebuild: string[];
  started: boolean;
  platforms: { web: boolean; ipad: boolean };
  commits: Commit[];
  lastCommit: string | null;
  points: Points;
}

export interface Summary {
  specs: number;
  implemented: number;
  started: number;
  superseded: number;
  points: Points;
  coverage: number;
  requirements: number;
}

export interface Tokens {
  messages: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface WorkSpec {
  id: string;
  score: number;
  /** The spec file itself has uncommitted changes. */
  specFile: boolean;
  /** Changed files its Rebuild section names. */
  named: number;
  /** Changed files that cite its ID. */
  cited: number;
  files: number;
  lastChange: string | null;
}

/** The agent's tool calls in this project: names and counts only. */
export interface Activity {
  active: boolean;
  lastAt: string | null;
  lastTool: string | null;
  session: string | null;
  windowMin: number;
  calls: number;
  tools: { name: string; count: number }[];
  edited: number;
}

export interface SpecRef {
  id: string;
  /** Requirement number, from "FR-031 §3"; null when only the spec is named. */
  sec: string | null;
}

/** One action of the agent, or several identical ones in a row. */
export interface FeedItem {
  at: string;
  kind: "edit" | "write" | "read" | "search" | "shell" | "subagent" | "other";
  tool: string;
  path: string | null;
  /** Shell calls: what the command does ("tests", "deploy" …), never the command. */
  label: string | null;
  agent: boolean;
  count: number;
  /** true failed · false finished · null still running */
  failed: boolean | null;
  specs: SpecRef[];
}

export interface Focus {
  id: string;
  score: number;
  lastAt: string | null;
  secs: { sec: string; count: number; lastAt: string; text: string | null }[];
  files: string[];
}

/** What the agent does now in the latest session (version 3). */
export interface Live {
  session: string;
  active: boolean;
  lastAt: string;
  running: string | null;
  agentsActive: number;
  focus: Focus[];
  feed: FeedItem[];
  ticked: { id: string; index: number; at: string }[];
}

export interface EtaWindow {
  key: string;
  usedPct: number;
  resetsAt: string | null;
  lenH: number;
  usedOutput: number;
  pctPerMOutput: number | null;
  neededPct: number | null;
  pctPerWorkH: number | null;
  waitH: number;
}

/** Estimate for the criteria the agent can still meet on its own (version 3). */
export interface Eta {
  /** Open criteria the agent can meet on its own; the estimate covers these. */
  remaining: number;
  /** Open criteria that wait for the owner or a third party; absent in older data. */
  blocked?: number;
  blockedSpecs?: { id: string; count: number }[];
  workableSpecs?: { id: string; count: number }[];
  remainingFr: number;
  remainingNfr: number;
  done: number;
  workH: number;
  days: number;
  hoursPerDay: number | null;
  pace: number | null;
  recentPace: number | null;
  recentTicks: number;
  workLeftH: number | null;
  workLeftRecentH: number | null;
  outputPerWorkH: number | null;
  perCriterion: { output: number; input: number } | null;
  needed: { output: number; input: number } | null;
  withoutLimits: string | null;
  withLimits: string | null;
  waitH: number;
  limited: boolean;
  windows: EtaWindow[];
}

export interface Bug {
  number: number;
  title: string;
  state: "open" | "closed";
  /** Labels besides "bug". */
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  assignees: string[];
  /** Spec IDs named in the title or text. */
  specs: string[];
}

/** Bug tickets of the GitHub repository (DEV-003). */
export interface Bugs {
  repo: string | null;
  label: string;
  error: string | null;
  fetchedAt: string | null;
  items: Bug[];
}

export interface Status {
  version: number;
  bugs?: Bugs;
  generatedAt: string;
  eta?: Eta | null;
  workingOn: {
    /** uncommitted: changes linked to specs · unlinked: changes, none linked · idle: nothing uncommitted. Absent in version 1. */
    mode?: "uncommitted" | "unlinked" | "idle";
    reason: string;
    ids: string[];
    since?: string | null;
    changedFiles: number;
    unlinkedFiles?: number;
    files?: { path: string; changedAt: string | null; specs?: string[]; agentAt?: string | null }[];
    /** Specs linked to the uncommitted files, strongest evidence first. */
    specs?: WorkSpec[];
    activity?: Activity;
    lastDone?: { hash: string; subject: string; date: string; ids: string[] } | null;
    live?: Live | null;
  };
  repo: { name: string; branch: string; head: string; dirty: number };
  summary: {
    all: Summary;
    fr: Summary;
    nfr: Summary;
    groups: (Summary & { key: string; kind: string; name: string; ids: string[] })[];
  };
  specs: Spec[];
  tests: {
    web: { files: number; cases: number };
    ipad: { files: number; cases: number };
    browser: { files: number; checks: number };
  };
  tokens: {
    source: string;
    total: Tokens;
    /** Share of the plan's usage limits used, as last seen by the status line. Absent in older documents. */
    limits?: { at: string; windows: { key: string; usedPct: number; resetsAt: string | null }[] } | null;
    currentModel: string | null;
    lastActivity: string | null;
    byModel: (Tokens & { model: string })[];
    sessions: (Tokens & { id: string; agentMessages: number; first: string; last: string; models: string[] })[];
    byHour: (Tokens & { hour: string })[];
  };
  commits: Commit[];
}
