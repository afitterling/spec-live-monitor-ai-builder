// The status page: every spec with its coverage, overall progress, what is
// being worked on, tests, tokens and model. Re-reads the status every 15 s.
import { json, type HeadersFunction } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadStatus } from "../lib/status.server";
import type { Spec, Status, Tokens } from "../lib/types";

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

function Bar({ done, total, ok, big, label }: { done: number; total: number; ok?: boolean; big?: boolean; label?: string }) {
  const p = pct(done, total);
  return (
    <div className={`bar${big ? " big" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label}>
      <span className={ok ? "ok" : ""} style={{ width: `${p}%` }} />
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

  const jump = (id: string) => {
    setQuery("");
    setKind("all");
    setState("all");
    setOpen((prev) => new Set(prev).add(id));
    requestAnimationFrame(() =>
      document.querySelector(`tr.spec[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return d.specs.filter(
      (s) =>
        (kind === "all" || s.kind === kind) &&
        (state === "all" || stateOf(s) === state) &&
        (!q || `${s.id} ${s.title} ${s.group}`.toLowerCase().includes(q)),
    );
  }, [d.specs, query, kind, state]);

  const kpis: [string, string, string][] = [
    ["Specs done", `${a.implemented} / ${a.specs}`, `${pct(a.implemented, a.specs)} % · ${a.started} started`],
    ["Criteria met", `${a.points.done} / ${a.points.total}`, `${a.requirements} numbered requirements`],
    ["Tests", String(t.web.cases + t.ipad.cases + t.browser.checks), `web ${t.web.cases} · iPad ${t.ipad.cases} · browser ${t.browser.checks}`],
    ["Model", (tok.currentModel ?? "–").replace(/^claude-/, ""), `last activity ${ago(tok.lastActivity, now)}`],
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
              <span key={k}>
                {k.toUpperCase()}: <b>{pct(s.points.done, s.points.total).toFixed(1)} %</b> ({s.points.done}/{s.points.total} criteria,{" "}
                {s.implemented}/{s.specs} done)
              </span>
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

      <section className="card" style={{ marginBottom: 12 }} aria-labelledby="nowTitle">
        <h2 id="nowTitle">Working on now</h2>
        <div className="now">
          {d.workingOn.ids.length === 0 && <span className="dim">No spec in progress.</span>}
          {d.workingOn.ids.map((id) => {
            const s = d.specs.find((x) => x.id === id);
            return (
              <button type="button" className="chip accent" key={id} onClick={() => jump(id)}>
                {id}
                {s ? ` · ${s.title} · ${s.points.done}/${s.points.total}` : ""}
              </button>
            );
          })}
          <span className="chip">
            {d.workingOn.reason}
            {d.workingOn.since ? ` · ${ago(d.workingOn.since, now)}` : ""}
          </span>
          {d.workingOn.changedFiles > 0 && <span className="chip">{d.workingOn.changedFiles} uncommitted files</span>}
        </div>
        {d.workingOn.files && d.workingOn.files.length > 0 && (
          <ul className="commits" style={{ marginTop: 10, maxHeight: 220 }} aria-label="Uncommitted files, newest change first">
            {d.workingOn.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className="dim" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(f.changedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="grpTitle">
          <h2 id="grpTitle">Coverage by group</h2>
          {d.summary.groups.map((g) => (
            <div className="group" key={g.key}>
              <div className="name">
                <span className="pf on">{g.kind}</span> {g.name}
              </div>
              <Bar done={g.points.done} total={g.points.total} ok={g.implemented === g.specs} label={`${g.kind} ${g.name}`} />
              <div className="num">
                {pct(g.points.done, g.points.total).toFixed(0)} % · {g.implemented}/{g.specs}
              </div>
            </div>
          ))}
        </section>

        <section className="card" aria-labelledby="tokTitle">
          <h2 id="tokTitle">Token usage</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Model</th><th className="num">Responses</th><th className="num">Output</th><th className="num">Input (incl. cache)</th></tr>
              </thead>
              <tbody>
                {tok.byModel.map((m) => (
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
                <tr><th>Session</th><th className="num">Responses</th><th className="num">Output</th><th className="num">Last</th></tr>
              </thead>
              <tbody>
                {tok.sessions.slice(0, 6).map((s) => (
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
          <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>{tok.source}</div>
        </section>
      </div>

      <section className="card" aria-labelledby="specTitle" style={{ marginBottom: 12 }}>
        <h2 id="specTitle">All specs ({shown.length} of {d.specs.length})</h2>
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
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Title</th><th className="hide-sm">Group</th><th>State</th>
                <th className="hide-sm">Web / iPad</th><th>Criteria</th><th className="hide-sm">Last commit</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={7} className="dim">No spec matches.</td></tr>
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
                            <h3>Acceptance criteria — {s.points.done} of {s.points.total}</h3>
                            <ul>
                              {s.criteria.length === 0 && <li className="open">None listed.</li>}
                              {s.criteria.map((c, i) => (
                                <li key={i} className={c.done ? "done" : "open"}><Md text={c.text} /></li>
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
        Rebuild section, as done when its status is Implemented. Token figures come from the local Claude Code transcripts (numbers only).
      </footer>
    </div>
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
