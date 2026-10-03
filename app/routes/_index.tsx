// The status page: every spec with its coverage, overall progress, what is
// being worked on, tests, tokens, usage limits and model. Re-reads the status
// every 15 s. Every table sorts by any column, stable, ascending or descending.
import { json, type HeadersFunction } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadStatus } from "../lib/status.server";
import type { Spec, Status, Tokens, WorkSpec } from "../lib/types";

const POLL_MS = 15_000;
/** No push for this long: nobody is working right now. */
const STALE_MS = 30 * 60 * 1000;

export async function loader() {
  return json({ status: await loadStatus() }, { headers: { "Cache-Control": "no-store" } });
}

// Keep the root's security headers; Remix uses only the deepest route's headers.
export const headers: HeadersFunction = ({ parentHeaders }) => {
  const out = new Headers(parentHeaders);
  out.set("Cache-Control", "no-store");
  return out;
};

// ---------------------------------------------------------------- helpers

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 1000) / 10 : 0);

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)} k` : n.toLocaleString("en");

const inputTotal = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead;

/** Time until a moment, for limit resets: "in 2 h 10 min". */
function until(iso: string | null | undefined, now: number) {
  if (!iso) return "–";
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `in ${Math.round(m / 1440)} d`;
}

function ago(iso: string | null | undefined, now: number) {
  if (!iso) return "–";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

type State = "Implemented" | "Started" | "Draft" | "Superseded";

const stateOf = (s: Spec): State =>
  /superseded/i.test(s.status) ? "Superseded" : s.status === "Implemented" ? "Implemented" : s.started ? "Started" : "Draft";

const stateLabel: Record<State, string> = { Implemented: "Done", Started: "Started", Draft: "Open", Superseded: "Superseded" };
const stateRank: Record<State, number> = { Draft: 0, Started: 1, Implemented: 2, Superseded: 3 };

/** Names of the usage-limit windows Claude Code reports. */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "Week",
  seven_day_opus: "Week, Opus",
  seven_day_sonnet: "Week, Sonnet",
};
const limitName = (key: string) => LIMIT_NAMES[key] ?? key.replace(/_/g, " ");

// ---------------------------------------------------------------- sorting

type Dir = "asc" | "desc";
type Sort<K extends string> = { key: K; dir: Dir } | null;
type SortValue = string | number | null;

/**
 * Sorts rows by one column. Stable in both directions: rows with equal values
 * keep their original order. Empty values go last either way. With no column
 * chosen the rows keep the order of the document.
 */
function useSort<T, K extends string>(rows: T[], keys: Record<K, (r: T) => SortValue>, initial: Sort<K> = null) {
  const [sort, setSort] = useState<Sort<K>>(initial);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = keys[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows
      .map((r, i) => ({ r, i, v: get(r) }))
      .sort((a, b) => {
        if (a.v === b.v) return a.i - b.i;
        if (a.v === null) return 1;
        if (b.v === null) return -1;
        const c =
          typeof a.v === "number" && typeof b.v === "number"
            ? a.v - b.v
            : String(a.v).localeCompare(String(b.v), "en", { numeric: true, sensitivity: "base" });
        return c * sign || a.i - b.i;
      })
      .map((x) => x.r);
  }, [rows, sort, keys]);
  // First click ascending, then it flips between ascending and descending.
  const toggle = (key: K) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  return { sorted, sort, setSort, toggle };
}

function SortTh<K extends string>({ k, label, sort, onSort, className }: {
  k: K; label: string; sort: Sort<K>; onSort: (k: K) => void; className?: string;
}) {
  const active = sort?.key === k;
  const dir = active ? sort.dir : null;
  return (
    <th className={className} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}>
      <button type="button" className={`sort${active ? " on" : ""}`} onClick={() => onSort(k)}
        title={`Sort by ${label}${dir === "asc" ? ", descending" : ", ascending"}`}>
        {label}
        <span className="arrow" aria-hidden="true">{dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}</span>
      </button>
    </th>
  );
}

type SpecKey = "id" | "title" | "group" | "state" | "platforms" | "criteria" | "last";
const SPEC_KEYS: Record<SpecKey, (s: Spec) => SortValue> = {
  // FRs before NFRs, then by number.
  id: (s) => `${s.kind === "FR" ? 0 : 1} ${s.id}`,
  title: (s) => s.title,
  group: (s) => s.group || null,
  state: (s) => stateRank[stateOf(s)],
  platforms: (s) => Number(s.platforms.web) + Number(s.platforms.ipad),
  criteria: (s) => (s.points.total ? s.points.done / s.points.total : null),
  last: (s) => (s.lastCommit ? Date.parse(s.lastCommit) : null),
};
const SPEC_LABELS: Record<SpecKey, string> = {
  id: "ID", title: "Title", group: "Group", state: "State", platforms: "Web / iPad", criteria: "Criteria", last: "Last commit",
};

type ModelRow = Status["tokens"]["byModel"][number];
type ModelKey = "model" | "messages" | "output" | "input";
const MODEL_KEYS: Record<ModelKey, (m: ModelRow) => SortValue> = {
  model: (m) => m.model, messages: (m) => m.messages, output: (m) => m.output, input: (m) => inputTotal(m),
};

type SessionRow = Status["tokens"]["sessions"][number];
type SessionKey = "id" | "messages" | "output" | "last";
const SESSION_KEYS: Record<SessionKey, (s: SessionRow) => SortValue> = {
  id: (s) => s.id, messages: (s) => s.messages, output: (s) => s.output, last: (s) => Date.parse(s.last),
};

/** Inline markdown of the spec files: `code`, **bold**, *em*, [text](link) → text. */
function Md({ text: raw }: { text: string }) {
  const out: ReactNode[] = [];
  // Links to other spec files make no sense here: keep their text only.
  const text = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\([^)]+\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={m.index}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={m.index}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={m.index}>{m[3]}</em>);
    else out.push(m[4]);
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function Bar({ done, total, ok, warn, big, label }: {
  done: number; total: number; ok?: boolean; warn?: boolean; big?: boolean; label?: string;
}) {
  const p = Math.min(100, pct(done, total));
  return (
    <div className={`bar${big ? " big" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label}>
      <span className={warn ? "warn" : ok ? "ok" : ""} style={{ width: `${p}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function StatusPage() {
  const { status } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [revalidator]);

  if (!status) {
    return (
      <div className="wrap">
        <header>
          <h1>editr — build status</h1>
          <span className="live"><span className="dot stale" />waiting for the first push</span>
        </header>
        <p className="dim">No status has been pushed yet. Run <code>npm run push</code> in <code>sst-dev</code>.</p>
      </div>
    );
  }
  return <Dashboard status={status as Status} now={now} />;
}

function Dashboard({ status: d, now }: { status: Status; now: number }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "FR" | "NFR">("all");
  const [state, setState] = useState<"all" | State>("all");
  const [group, setGroup] = useState<string | null>(null);

  const a = d.summary.all;
  const overall = pct(a.points.done, a.points.total);
  const stale = now - Date.parse(d.generatedAt) > STALE_MS;
  const working = new Set(d.workingOn.ids);
  const tok = d.tokens;
  const t = d.tests;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setState("all");
    setGroup(null);
  };

  /** Opens one spec and scrolls to it; also reachable as #FR-021 in the URL. */
  const jump = (id: string) => {
    clearFilters();
    setOpen((prev) => new Set(prev).add(id));
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    requestAnimationFrame(() =>
      document.querySelector(`tr.spec[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };

  /** Shows only FRs, only NFRs or one group in the list and scrolls to it. */
  const showList = (k: "all" | "FR" | "NFR", groupKey: string | null = null) => {
    clearFilters();
    setKind(k);
    setGroup(groupKey);
    requestAnimationFrame(() => document.getElementById("specs")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // A link like #FR-021 opens that spec, on load and when the hash changes.
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (d.specs.some((s) => s.id === id)) jump(id);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeGroup = d.summary.groups.find((g) => g.key === group) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return d.specs.filter(
      (s) =>
        (kind === "all" || s.kind === kind) &&
        (state === "all" || stateOf(s) === state) &&
        (!activeGroup || activeGroup.ids.includes(s.id)) &&
        (!q || `${s.id} ${s.title} ${s.group}`.toLowerCase().includes(q)),
    );
  }, [d.specs, query, kind, state, activeGroup]);
  const specSort = useSort(filtered, SPEC_KEYS);
  const shown = specSort.sorted;
  const allOpen = shown.length > 0 && shown.every((s) => open.has(s.id));
  const models = useSort(tok.byModel, MODEL_KEYS);
  const sessions = useSort(tok.sessions, SESSION_KEYS);

  const limits = tok.limits?.windows ?? [];
  const mainLimit = limits.find((w) => w.key === "five_hour") ?? limits[0];

  const kpis: [string, string, string][] = [
    ["Specs done", `${a.implemented} / ${a.specs}`, `${pct(a.implemented, a.specs)} % · ${a.started} started`],
    ["Criteria met", `${a.points.done} / ${a.points.total}`, `${a.requirements} numbered requirements`],
    ["Tests", String(t.web.cases + t.ipad.cases + t.browser.checks), `web ${t.web.cases} · iPad ${t.ipad.cases} · browser ${t.browser.checks}`],
    ["Model", (tok.currentModel ?? "–").replace(/^claude-/, ""), `last activity ${ago(tok.lastActivity, now)}`],
    mainLimit
      ? [
          "Usage limit",
          `${Math.round(mainLimit.usedPct)} %`,
          [`${limitName(mainLimit.key)}, resets ${until(mainLimit.resetsAt, now)}`,
            ...limits.filter((w) => w !== mainLimit).map((w) => `${limitName(w.key)} ${Math.round(w.usedPct)} %`)].join(" · "),
        ]
      : ["Usage limit", "–", "no status line data yet"],
    ["Output tokens", fmt(tok.total.output), `${tok.total.messages} model responses`],
    ["Input tokens", fmt(inputTotal(tok.total)), `cache read ${fmt(tok.total.cacheRead)} · write ${fmt(tok.total.cacheWrite)}`],
  ];

  return (
    <div className="wrap">
      <header>
        <h1>editr — build status</h1>
        <span className="live" aria-live="polite">
          <span className={`dot${stale ? " stale" : ""}`} />
          updated {ago(d.generatedAt, now)}
        </span>
        <span className="dim">
          {d.repo.branch} @ {d.repo.head}
          {d.repo.dirty ? ` · ${d.repo.dirty} uncommitted` : ""}
        </span>
      </header>

      <nav className="jump" aria-label="Jump to">
        <a href="#overall">Progress</a>
        <button type="button" onClick={() => showList("FR")}>FRs ({d.summary.fr.specs})</button>
        <button type="button" onClick={() => showList("NFR")}>NFRs ({d.summary.nfr.specs})</button>
        <button type="button" onClick={() => showList("all")}>All specs</button>
        <a href="#tokTitle">Tokens &amp; limits</a>
        <a href="#comTitle">Commits</a>
      </nav>

      <section className="card hero" aria-labelledby="overall">
        <div className="hero-row">
          <div>
            <div className="dim" id="overall">Overall progress — acceptance criteria met</div>
            <div className="pct">{overall.toFixed(1)} %</div>
          </div>
          <div className="dim">
            {a.points.done} of {a.points.total} acceptance criteria · {a.implemented} of {a.specs} specs done · {a.started} started
          </div>
        </div>
        <Bar done={a.points.done} total={a.points.total} big label="Overall progress" />
        <div className="legend">
          {(["fr", "nfr"] as const).map((k) => {
            const s = d.summary[k];
            return (
              <button type="button" className="link" key={k} onClick={() => showList(k === "fr" ? "FR" : "NFR")}>
                {k.toUpperCase()}: <b>{pct(s.points.done, s.points.total).toFixed(1)} %</b> ({s.points.done}/{s.points.total} criteria,{" "}
                {s.implemented}/{s.specs} done)
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid kpis" aria-label="Key figures">
        {kpis.map(([label, value, sub]) => (
          <div className="card kpi" key={label}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            <div className="sub">{sub}</div>
          </div>
        ))}
      </section>

      <WorkingOn d={d} now={now} jump={jump} />

      <div className="grid two">
        <section className="card" aria-labelledby="grpTitle">
          <h2 id="grpTitle">Coverage by group</h2>
          {d.summary.groups.map((g) => (
            <div className="group" key={g.key}>
              <button type="button" className="name link" onClick={() => showList(g.kind === "NFR" ? "NFR" : "FR", g.key)}
                title={`Show the ${g.kind}s of ${g.name}`}>
                <span className="pf on">{g.kind}</span> {g.name}
              </button>
              <Bar done={g.points.done} total={g.points.total} ok={g.implemented === g.specs} label={`${g.kind} ${g.name}`} />
              <div className="num">
                {pct(g.points.done, g.points.total).toFixed(0)} % · {g.implemented}/{g.specs}
              </div>
            </div>
          ))}
        </section>

        <section className="card" aria-labelledby="tokTitle">
          <h2 id="tokTitle">Token usage</h2>
          <h3 className="sub">Usage limits{tok.limits ? <span className="dim"> · as of {ago(tok.limits.at, now)}</span> : null}</h3>
          {limits.length === 0 ? (
            <div className="dim" style={{ marginBottom: 12, fontSize: 12 }}>
              No figures yet. They come from the Claude Code status line (<code>scripts/statusline.mjs</code>) and need a Claude subscription.
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              {limits.map((w) => (
                <div className="group" key={w.key}>
                  <div className="name">{limitName(w.key)}</div>
                  <Bar done={w.usedPct} total={100} warn={w.usedPct >= 80} label={`${limitName(w.key)} used`} />
                  <div className="num">{w.usedPct.toFixed(0)} % · {until(w.resetsAt, now)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <SortTh k="model" label="Model" sort={models.sort} onSort={models.toggle} />
                  <SortTh k="messages" label="Responses" sort={models.sort} onSort={models.toggle} className="num" />
                  <SortTh k="output" label="Output" sort={models.sort} onSort={models.toggle} className="num" />
                  <SortTh k="input" label="Input (incl. cache)" sort={models.sort} onSort={models.toggle} className="num" />
                </tr>
              </thead>
              <tbody>
                {models.sorted.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td className="num">{m.messages}</td>
                    <td className="num">{fmt(m.output)}</td>
                    <td className="num">{fmt(inputTotal(m))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <SortTh k="id" label="Session" sort={sessions.sort} onSort={sessions.toggle} />
                  <SortTh k="messages" label="Responses" sort={sessions.sort} onSort={sessions.toggle} className="num" />
                  <SortTh k="output" label="Output" sort={sessions.sort} onSort={sessions.toggle} className="num" />
                  <SortTh k="last" label="Last" sort={sessions.sort} onSort={sessions.toggle} className="num" />
                </tr>
              </thead>
              <tbody>
                {sessions.sorted.slice(0, 6).map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code>{s.id}</code>
                      {s.agentMessages ? <span className="dim"> +{s.agentMessages} agent</span> : null}
                    </td>
                    <td className="num">{s.messages}</td>
                    <td className="num">{fmt(s.output)}</td>
                    <td className="num">{ago(s.last, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
            {tok.source}{tok.sessions.length > 6 ? ` · top 6 of ${tok.sessions.length} sessions in the chosen order` : ""}
          </div>
        </section>
      </div>

      <section className="card" id="specs" aria-labelledby="specTitle" style={{ marginBottom: 12 }}>
        <h2 id="specTitle">
          {kind === "all" ? "All specs" : `${kind}s`}
          {activeGroup ? ` · ${activeGroup.name}` : ""} ({shown.length} of {d.specs.length})
        </h2>
        <div className="toolbar">
          <input type="search" placeholder="Filter by ID, title or group…" aria-label="Filter specs" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <div className="seg" role="group" aria-label="Kind">
            {(["all", "FR", "NFR"] as const).map((k) => (
              <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "all" ? "All" : k}</button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="State">
            {(["all", "Implemented", "Started", "Draft"] as const).map((s) => (
              <button type="button" key={s} aria-pressed={state === s} onClick={() => setState(s)}>
                {s === "all" ? "Any" : stateLabel[s]}
              </button>
            ))}
          </div>
          {activeGroup && (
            <button type="button" className="chip" onClick={() => setGroup(null)} aria-label={`Remove group filter ${activeGroup.name}`}>
              {activeGroup.kind} {activeGroup.name} ✕
            </button>
          )}
          <button type="button" className="btn" disabled={shown.length === 0}
            onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((s) => s.id)))}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          {/* The column headers sort on wide screens; on a phone some columns are hidden, so this does. */}
          <div className="sortbar show-sm">
            <select aria-label="Sort by" value={specSort.sort?.key ?? ""}
              onChange={(e) => {
                const key = e.target.value as SpecKey | "";
                specSort.setSort(key ? { key, dir: specSort.sort?.dir ?? "asc" } : null);
              }}>
              <option value="">File order</option>
              {(Object.keys(SPEC_LABELS) as SpecKey[]).map((k) => <option key={k} value={k}>{SPEC_LABELS[k]}</option>)}
            </select>
            <button type="button" className="btn" disabled={!specSort.sort}
              aria-label={specSort.sort?.dir === "desc" ? "Descending, switch to ascending" : "Ascending, switch to descending"}
              onClick={() => specSort.sort && specSort.toggle(specSort.sort.key)}>
              {specSort.sort?.dir === "desc" ? "▼ desc" : "▲ asc"}
            </button>
          </div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {(Object.keys(SPEC_LABELS) as SpecKey[]).map((k) => (
                  <SortTh key={k} k={k} label={SPEC_LABELS[k]} sort={specSort.sort} onSort={specSort.toggle}
                    className={k === "group" || k === "platforms" || k === "last" ? "hide-sm" : undefined} />
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={7} className="dim">No spec matches. <button type="button" className="link" onClick={clearFilters}>Clear filters</button></td></tr>
              )}
              {shown.map((s) => {
                const st = stateOf(s);
                const isOpen = open.has(s.id);
                return (
                  <Fragment key={s.id}>
                    <tr className={`spec${working.has(s.id) ? " working" : ""}`} data-id={s.id} tabIndex={0} aria-expanded={isOpen}
                      onClick={() => toggle(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(s.id);
                        }
                      }}>
                      <td className="id">{s.id}</td>
                      <td>{s.title}</td>
                      <td className="hide-sm dim">{s.group}</td>
                      <td><span className={`pill ${st}`}>{stateLabel[st]}</span></td>
                      <td className="hide-sm">
                        <span className={`pf${s.platforms.web ? " on" : ""}`}>Web</span>{" "}
                        <span className={`pf${s.platforms.ipad ? " on" : ""}`}>iPad</span>
                      </td>
                      <td>
                        <div className="cov">
                          <Bar done={s.points.done} total={s.points.total} ok={st === "Implemented"} label={`${s.id} criteria`} />
                          <span className="num">{s.points.done}/{s.points.total}</span>
                        </div>
                      </td>
                      <td className="hide-sm dim">{ago(s.lastCommit, now)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="detail">
                        <td colSpan={7}>
                          <div className="detail">
                            <h3>Acceptance criteria — {s.points.done} of {s.points.total} checked</h3>
                            <ul className="checks">
                              {s.criteria.length === 0 && <li className="dim">None listed.</li>}
                              {s.criteria.map((c, i) => (
                                <li key={i} className={c.done ? "done" : "open"}>
                                  <span className="box" role="img" aria-label={c.done ? "checked" : "unchecked"}>{c.done ? "✓" : ""}</span>
                                  <span><Md text={c.text} /></span>
                                </li>
                              ))}
                            </ul>
                            <h3>Rebuild</h3>
                            {s.rebuild.length ? (
                              <ul>{s.rebuild.map((r, i) => <li key={i}><Md text={r} /></li>)}</ul>
                            ) : (
                              <div className="dim">Not started.</div>
                            )}
                            {s.commits.length > 0 && (
                              <>
                                <h3>Commits</h3>
                                <ul>
                                  {s.commits.map((c) => (
                                    <li key={c.hash}><code>{c.hash}</code> {c.subject} <span className="dim">· {ago(c.date, now)}</span></li>
                                  ))}
                                </ul>
                              </>
                            )}
                            <h3>File</h3>
                            <div>
                              <code>{s.file}</code> · {s.requirements} numbered requirements · status <b>{s.status}</b>
                              {s.updated ? ` · updated ${s.updated}` : ""}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="actTitle">
          <h2 id="actTitle">Activity — output tokens per hour</h2>
          <Activity hours={tok.byHour} />
        </section>
        <section className="card" aria-labelledby="comTitle">
          <h2 id="comTitle">Recent commits</h2>
          <ul className="commits">
            {d.commits.slice(0, 25).map((c) => (
              <li key={c.hash}>
                <span className="h">{c.hash}</span>
                <span>{c.subject}</span>
                <span className="dim" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(c.date, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer>
        Read-only. Coverage = acceptance criteria ticked in the spec files ÷ all acceptance criteria. A spec counts as started once it has a
        Rebuild section, as done when its status is Implemented. Token figures come from the local Claude Code transcripts (numbers only);
        usage limits from the Claude Code status line.
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- working on

/** Why a spec counts as in progress, in words. */
function evidence(w: WorkSpec) {
  const out: string[] = [];
  if (w.specFile) out.push("spec file edited");
  if (w.named) out.push(`${w.named} file${w.named > 1 ? "s" : ""} of its Rebuild section`);
  if (w.cited) out.push(`cited in ${w.cited} changed file${w.cited > 1 ? "s" : ""}`);
  return out.join(" · ");
}

const MAX_TASKS = 6;

function WorkingOn({ d, now, jump }: { d: Status; now: number; jump: (id: string) => void }) {
  const w = d.workingOn;
  const act = w.activity;
  const [showAll, setShowAll] = useState(false);
  // Documents of version 1 carry only ids.
  const work: WorkSpec[] = w.specs ?? w.ids.map((id) => ({ id, score: 0, specFile: false, named: 0, cited: 0, files: 0, lastChange: null }));
  const mode = w.mode ?? (w.reason === "uncommitted changes" ? "uncommitted" : "idle");
  const list = showAll ? work : work.slice(0, 4);

  return (
    <section className="card" style={{ marginBottom: 12 }} aria-labelledby="nowTitle">
      <div className="now-head">
        <h2 id="nowTitle">Working on now</h2>
        {act && (
          <span className={`chip${act.active ? " live-chip" : ""}`}>
            <span className={`dot${act.active ? "" : " stale"}`} />
            {act.active ? "Agent active" : "Agent idle"} · last {act.lastTool ?? "action"} {ago(act.lastAt, now)}
          </span>
        )}
        {act && act.calls > 0 && (
          <span className="chip" title={`Tool calls in the last ${act.windowMin} minutes`}>
            {act.calls} tool calls / {act.windowMin} min: {act.tools.slice(0, 4).map((t) => `${t.name} ${t.count}`).join(", ")}
          </span>
        )}
        {act && act.edited > 0 && <span className="chip">{act.edited} files edited by the agent</span>}
      </div>

      {mode === "idle" && (
        <p className="dim" style={{ margin: "4px 0 0" }}>
          Nothing uncommitted, so no spec is in progress.
          {w.lastDone && (
            <>
              {" "}Last finished: {w.lastDone.ids.map((id) => (
                <button type="button" className="link" key={id} onClick={() => jump(id)}>{id}</button>
              )).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}{" "}
              in <code>{w.lastDone.hash}</code> {w.lastDone.subject.replace(/^[^:]*:\s*/, "")} · {ago(w.lastDone.date, now)}
            </>
          )}
        </p>
      )}
      {mode === "unlinked" && (
        <p className="dim" style={{ margin: "4px 0 0" }}>
          {w.changedFiles} uncommitted files, none of them linked to a spec (no spec file, no Rebuild entry, no cited ID).
        </p>
      )}

      {work.length > 0 && (
        <>
          <p className="dim" style={{ margin: "2px 0 10px", fontSize: 12 }}>
            Specs linked to the {w.changedFiles} uncommitted files, strongest link first. The open acceptance criteria are the tasks left.
          </p>
          <div className="tasks">
            {list.map((ws, i) => {
              const s = d.specs.find((x) => x.id === ws.id);
              if (!s) return null;
              const st = stateOf(s);
              const open = s.criteria.filter((c) => !c.done);
              return (
                <article className={`task${i === 0 ? " main" : ""}`} key={ws.id}>
                  <header>
                    <button type="button" className="link id" onClick={() => jump(s.id)}>{s.id}</button>
                    <span className="title">{s.title}</span>
                    <span className={`pill ${st}`}>{stateLabel[st]}</span>
                  </header>
                  <div className="cov">
                    <Bar done={s.points.done} total={s.points.total} ok={st === "Implemented"} label={`${s.id} criteria`} />
                    <span className="num">{s.points.done}/{s.points.total}</span>
                  </div>
                  <div className="why">
                    {evidence(ws) || "named in the last commit"}
                    {ws.lastChange ? ` · changed ${ago(ws.lastChange, now)}` : ""}
                  </div>
                  {open.length > 0 ? (
                    <ul className="checks compact" aria-label={`Open tasks of ${s.id}`}>
                      {open.slice(0, MAX_TASKS).map((c, k) => (
                        <li key={k} className="open">
                          <span className="box" role="img" aria-label="unchecked" />
                          <span><Md text={c.text} /></span>
                        </li>
                      ))}
                      {open.length > MAX_TASKS && (
                        <li className="more">
                          <button type="button" className="link" onClick={() => jump(s.id)}>+{open.length - MAX_TASKS} more open</button>
                        </li>
                      )}
                    </ul>
                  ) : (
                    <div className="dim" style={{ fontSize: 12 }}>
                      {s.criteria.length ? "All acceptance criteria checked." : "No acceptance criteria listed."}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {work.length > 4 && (
            <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${work.length} linked specs`}
            </button>
          )}
        </>
      )}

      {w.files && w.files.length > 0 && (
        <details className="files" open={work.length === 0}>
          <summary>
            {w.changedFiles} uncommitted files{w.unlinkedFiles ? ` · ${w.unlinkedFiles} not linked to a spec` : ""}
          </summary>
          <ul className="commits" style={{ marginTop: 8, maxHeight: 260 }} aria-label="Uncommitted files, newest change first">
            {w.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                {f.agentAt && <span className="pf on" title={`Edited by the agent ${ago(f.agentAt, now)}`}>agent</span>}
                {(f.specs ?? []).slice(0, 3).map((id) => (
                  <button type="button" className="pf link" key={id} onClick={() => jump(id)}>{id}</button>
                ))}
                {(f.specs?.length ?? 0) > 3 && <span className="dim">+{f.specs!.length - 3}</span>}
                <span className="dim" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(f.changedAt, now)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Activity({ hours }: { hours: Status["tokens"]["byHour"] }) {
  if (!hours.length) return <span className="dim">No activity recorded.</span>;
  const W = 600, H = 120, pad = 18;
  const max = Math.max(...hours.map((h) => h.output), 1);
  const step = (W - 2 * pad) / hours.length;
  const bw = Math.max(2, Math.min(28, step - 3));
  const label = (h: string) => `${h.replace("T", " ")}:00`;
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Output tokens per hour">
        {hours.map((h, i) => {
          const bh = Math.max(1, (h.output / max) * (H - 2 * pad));
          return (
            <rect key={h.hour} x={pad + i * step} y={H - pad - bh} width={bw} height={bh} rx={2} fill="var(--accent)">
              <title>{`${label(h.hour)} UTC — ${fmt(h.output)} output, ${h.messages} responses`}</title>
            </rect>
          );
        })}
        <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--border)" />
      </svg>
      <div className="legend">
        <span>{label(hours[0].hour)} UTC</span>
        <span style={{ marginLeft: "auto" }}>{label(hours[hours.length - 1].hour)} UTC</span>
        <span>peak {fmt(max)}/h</span>
      </div>
    </>
  );
}
