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
  criteria: { done: boolean; text: string }[];
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

export interface Status {
  version: number;
  generatedAt: string;
  workingOn: {
    reason: string;
    ids: string[];
    since?: string | null;
    changedFiles: number;
    files?: { path: string; changedAt: string | null }[];
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
    currentModel: string | null;
    lastActivity: string | null;
    byModel: (Tokens & { model: string })[];
    sessions: (Tokens & { id: string; agentMessages: number; first: string; last: string; models: string[] })[];
    byHour: (Tokens & { hour: string })[];
  };
  commits: Commit[];
}
