import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Code2,
  FileCode2,
  FileJson,
  GitBranch,
  GitCommitHorizontal,
  History,
  Info,
  KeyRound,
  Layers,
  LoaderCircle,
  Network,
  Play,
  Search,
  Share2,
  ShieldCheck,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import TabTitle from "./TabTitle.jsx";
import { api, solidDownloadUrl } from "../api.js";
import useRunStop from "../useRunStop.js";
import FileTree, { Checkbox, collectFiles } from "./FileTree.jsx";
import WorkspacePicker from "./WorkspacePicker.jsx";
import SandboxRunner from "./SandboxRunner.jsx";
import { useChanges } from "./ChangesContext.jsx";
import { money } from "./UsageMetrics.jsx";
import {
  BarList,
  Radar,
  SEV_COLOR,
  SEVERITIES,
  ScoreRing,
  StackedBar,
  scoreColor,
} from "./SolidCharts.jsx";
import BrandLoader from './BrandLoader.jsx'

const GROUPS = [
  {
    key: "solid",
    label: "SOLID principles",
    hint: "Single responsibility, open/closed, Liskov, interface segregation, dependency inversion",
  },
  {
    key: "oop",
    label: "Object-oriented design",
    hint: "Encapsulation, inheritance, polymorphism, abstraction",
  },
  {
    key: "patterns",
    label: "Design patterns",
    hint: "Creational, structural and behavioral: used, missing or misapplied",
  },
  {
    key: "architecture",
    label: "Architecture (HLD)",
    hint: "Modularity, coupling and cohesion, layering and data flow, scalability",
  },
  {
    key: "lld",
    label: "Low-level design",
    hint: "Error handling, interfaces and contracts, data structures",
  },
  {
    key: "practices",
    label: "Engineering practices",
    hint: "Security, performance, coding standards, testability",
  },
];
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));
const number = (value) => Number(value || 0).toLocaleString();
const usd = (value) =>
  value == null
    ? "not priced"
    : `$${Number(value).toFixed(value >= 1 ? 2 : 4)}`;
const isActive = (status) => ["queued", "running"].includes(status);
const summary = (job) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  stage: job.stage,
  created_at: job.created_at,
  title: job.title,
  counts: job.counts,
  error: job.error,
});

function Text({ text }) {
  return String(text || "")
    .split(/(`[^`]+`)/g)
    .map((part, i) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="sd-inline-code">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}

function usePolling(id, load, onUpdate) {
  useEffect(() => {
    if (!id) return undefined;
    let stopped = false;
    let timer;
    async function poll() {
      try {
        const next = await load(id);
        if (stopped) return;
        onUpdate(next);
        if (!isActive(next.status)) return;
      } catch {
        /* retried below */
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Solidify({
  workspace,
  onWorkspace,
  settings,
  onError,
  onConfigure,
  onOpenUml,
}) {
  const [selected, setSelected] = useState(new Set());
  const [groups, setGroups] = useState(new Set(GROUPS.map((g) => g.key)));
  const [notes, setNotes] = useState("");
  const [sandbox, setSandbox] = useState(false); // run proposed code in the sandbox (default off)
  const [renderers, setRenderers] = useState({
    mermaid: true,
    reactflow: false,
  }); // UML renderer for the Flow tab (Mermaid or React Flow, never both)
  const [umlJobs, setUmlJobs] = useState([]);
  const [umlBusy, setUmlBusy] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [runningId, setRunningId] = useState(null);
  const [launching, setLaunching] = useState(false);
  const runStop = useRunStop(runningId, launching, api.solidStop, onError);

  const files = useMemo(
    () => (workspace ? collectFiles(workspace.tree) : []),
    [workspace],
  );
  useEffect(() => {
    setSelected(new Set());
  }, [workspace?.id]);

  // History; reconnect to a review still running (so it can be followed and stopped).
  useEffect(() => {
    api
      .solidJobs()
      .then((items) => {
        setHistory(items);
        const running = items.find((item) => isActive(item.status));
        if (running)
          api
            .solidJob(running.id)
            .then((next) => {
              setJob(next);
              setRunningId(next.id);
            })
            .catch(() => {});
      })
      .catch(() => {});
  }, []);

  // Before-run estimate for the current selection (debounced).
  useEffect(() => {
    setPlan(null);
    setPlanError("");
    if (!workspace || !selected.size || !groups.size) {
      setPlanBusy(false);
      return undefined;
    }
    const controller = new AbortController();
    setPlanBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.solidPreview(
          {
            workspace_id: workspace.id,
            files: [...selected],
            groups: [...groups],
            notes,
            sandbox,
          },
          controller.signal,
        );
        if (!controller.signal.aborted) setPlan(result);
      } catch (err) {
        if (!controller.signal.aborted) setPlanError(err.message);
      } finally {
        if (!controller.signal.aborted) setPlanBusy(false);
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspace, selected, groups, notes, sandbox, settings]);

  usePolling(runningId, api.solidJob, (next) => {
    setJob((current) => (!current || current.id === next.id ? next : current));
    setHistory((items) => [
      summary(next),
      ...items.filter((item) => item.id !== next.id),
    ]);
    if (!isActive(next.status)) setRunningId(null);
  });

  const selectPaths = (paths, enabled) =>
    setSelected((current) => {
      const next = new Set(current);
      paths.forEach((path) => (enabled ? next.add(path) : next.delete(path)));
      return next;
    });
  const toggleGroup = (key) =>
    setGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function start() {
    runStop.begin();
    setLaunching(true);
    try {
      const started = await api.solidRun({
        workspace_id: workspace.id,
        files: [...selected],
        groups: [...groups],
        notes: notes.trim(),
        sandbox,
      });
      setJob(started);
      setHistory((items) => [
        summary(started),
        ...items.filter((item) => item.id !== started.id),
      ]);
      setRunningId(started.id);
      await runStop.started(started.id);
    } catch (err) {
      onError(err.message);
    } finally {
      setLaunching(false);
    }
  }
  async function show(id) {
    try {
      setJob(await api.solidJob(id));
    } catch (err) {
      onError(err.message);
    }
  }
  async function remove(id) {
    try {
      await api.solidDelete(id);
      setHistory((items) => items.filter((item) => item.id !== id));
      if (job?.id === id) setJob(null);
    } catch (err) {
      onError(err.message);
    }
  }

  useEffect(() => {
    api
      .umlJobs()
      .then(setUmlJobs)
      .catch(() => {});
  }, [job?.id]);

  // Opens a UML diagram of this review in the Flow tab, drawing it first if it does not exist yet.
  async function openUml(diagram, scope = "") {
    if (!job?.report) return;
    const existing = umlJobs
      .filter(
        (j) =>
          j.counts?.source === job.id &&
          j.counts?.diagram === diagram &&
          !["failed", "cancelled"].includes(j.status),
      )
      .sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      )[0];
    if (existing) {
      onOpenUml?.({ id: existing.id, renderers });
      return;
    }
    if (!workspace) {
      onError(
        "Open the same codebase folder in this tab to draw UML diagrams from it.",
      );
      return;
    }
    setUmlBusy(diagram);
    try {
      const reviewed = job.report.coverage?.reviewed?.length
        ? job.report.coverage.reviewed
        : (job.files || []).map((f) => f.path);
      const started = await api.umlRun({
        workspace_id: workspace.id,
        files: reviewed,
        diagram,
        scope,
        source: job.id,
      });
      setUmlJobs((items) => [
        {
          id: started.id,
          status: started.status,
          title: started.title,
          created_at: started.created_at,
          counts: started.counts,
        },
        ...items,
      ]);
      onOpenUml?.({ id: started.id, renderers });
    } catch (err) {
      onError(err.message);
    } finally {
      setUmlBusy(null);
    }
  }

  const busy = Boolean(runningId) || launching;
  const canRun =
    workspace &&
    selected.size &&
    groups.size &&
    plan?.can_run &&
    !planBusy &&
    settings?.configured;

  return (
    <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)] min-h-[calc(100vh-96px)]">
      <aside className="bg-panel border-r border-line flex flex-col min-w-0">
        <WorkspacePicker
          workspace={workspace}
          onWorkspace={onWorkspace}
          onError={onError}
          label="01 / Codebase"
        />
        {workspace ? (
          <>
            <div className="px-5 py-4 border-b border-line">
              <div className="flex justify-between gap-3 items-center">
                <span
                  className="text-sm font-semibold truncate"
                  title={workspace.root}
                >
                  {workspace.name}
                </span>
                <span className="pill">{selected.size} selected</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted mt-3">
                <Checkbox
                  checked={files.length > 0 && selected.size === files.length}
                  mixed={selected.size > 0 && selected.size < files.length}
                  disabled={!files.length}
                  onChange={() =>
                    selectPaths(files, selected.size !== files.length)
                  }
                />
                Select all eligible files{" "}
                <span className="ml-auto">{files.length}</span>
              </label>
            </div>
            <div className="max-h-[480px] overflow-auto">
              <FileTree
                tree={workspace.tree}
                selected={selected}
                selectPaths={selectPaths}
                activePath={null}
                onOpen={(path) => selectPaths([path], !selected.has(path))}
              />
            </div>
          </>
        ) : (
          <div className="px-6 py-12 text-center text-muted">
            <ShieldCheck size={25} className="mx-auto mb-4 opacity-60" />
            <p className="text-sm">
              Open a folder, then pick the files to review.
            </p>
            <p className="text-xs mt-2">
              Select the whole codebase or just the modules you care about.
            </p>
          </div>
        )}
        <div className="p-5 border-t border-line mt-auto">
          <h2 className="eyebrow flex gap-2 items-center mb-4">
            <History size={13} />
            Recent reviews
          </h2>
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {history.map((item) => (
              <div
                key={item.id}
                className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${job?.id === item.id ? "bg-elevated" : ""}`}
              >
                <button
                  onClick={() => show(item.id)}
                  className="flex-1 min-w-0 text-left p-3"
                >
                  <div className="flex gap-2 items-center">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.status === "completed" ? "bg-added" : item.status === "failed" ? "bg-removed" : "bg-amber"} ${isActive(item.status) ? "animate-pulse" : ""}`}
                    />
                    <span className="truncate text-xs font-medium">
                      {item.title}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-muted mt-1 pl-3.5">
                    <span>
                      {new Date(item.created_at).toLocaleDateString()} ·{" "}
                      {item.counts?.files || 0} files
                    </span>
                    <span>
                      {item.counts?.score != null
                        ? `${item.counts.score}/100 ${item.counts.grade || ""} · ${item.counts.findings} findings`
                        : item.status}
                    </span>
                  </div>
                </button>
                {!isActive(item.status) && (
                  <button
                    className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1"
                    title="Delete"
                    aria-label="Delete review"
                    onClick={() => remove(item.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {!history.length && (
              <p className="text-xs text-muted">
                Finished reviews are saved here.
              </p>
            )}
          </div>
        </div>
      </aside>

      <main className="p-5 lg:p-8 xl:p-10 min-w-0 max-w-[1600px] w-full mx-auto">
        <div className="mb-7">
          <p className="eyebrow">Design quality · HLD and LLD</p>
          <TabTitle icon={ShieldCheck} name="QuSolids" tone="green" />
          <p className="text-sm text-muted mt-2 max-w-3xl">
            Reviews the code against SOLID, object-oriented design, design
            patterns, architecture and low-level design practice. You get
            scores, charts, what is wrong, why it matters and how to fix it,
            with proposed code you can run in a sandbox.
          </p>
        </div>

        <section className="card p-5 mb-6">
          <div className="grid xl:grid-cols-[minmax(0,1fr)_280px] gap-6">
            <div>
              <p className="eyebrow mb-3">02 / Focus areas</p>
              <div
                className="grid sm:grid-cols-2 gap-2"
                role="group"
                aria-label="Focus areas"
              >
                {GROUPS.map((g) => (
                  <label
                    key={g.key}
                    className={`qa-method ${groups.has(g.key) ? "qa-method-on" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={groups.has(g.key)}
                      disabled={busy}
                      onChange={() => toggleGroup(g.key)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold">
                        {g.label}
                      </span>
                      <span className="block text-[11px] text-muted leading-snug mt-0.5">
                        {g.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <label htmlFor="solid-notes" className="eyebrow block mt-5 mb-2">
                03 / What matters to you (optional)
              </label>
              <textarea
                id="solid-notes"
                className="input min-h-[64px] resize-y"
                maxLength={2000}
                value={notes}
                disabled={busy}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="For example: this will be extended with new payment providers, so extensibility matters most."
              />
              <div className="grid sm:grid-cols-2 gap-2 mt-4">
                <label className={`qa-method ${sandbox ? "qa-method-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={sandbox}
                    disabled={busy}
                    onChange={(e) => setSandbox(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">
                      Run proposed code in the sandbox
                    </span>
                    <span className="block text-[11px] text-muted leading-snug mt-0.5">
                      Adds a runnable demo with made-up data to the findings, so
                      you can see the new design work. Off by default; uses more
                      tokens.
                    </span>
                  </span>
                </label>
                <div
                  className="qa-method !cursor-default"
                  role="group"
                  aria-label="UML renderer"
                >
                  <Boxes size={15} className="text-sky-400 mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">
                      UML diagrams open in Flow with
                    </span>
                    <span className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                      {/* One renderer at a time: checking one unchecks the other. */}
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={renderers.mermaid}
                          onChange={() =>
                            setRenderers({ mermaid: true, reactflow: false })
                          }
                        />
                        Mermaid
                      </label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={renderers.reactflow}
                          onChange={() =>
                            setRenderers({ mermaid: false, reactflow: true })
                          }
                        />
                        React Flow
                      </label>
                    </span>
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-col">
              <p className="eyebrow mb-3">04 / Run</p>
              <button
                className="btn-primary w-full"
                disabled={runStop.stopping || (!busy && !canRun)}
                onClick={busy ? runStop.stop : start}
              >
                {runStop.stopping ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : busy ? (
                  <Square size={15} />
                ) : (
                  <Play size={15} />
                )}
                {runStop.stopping
                  ? "Stopping…"
                  : busy
                    ? "Stop"
                    : "Run design review"}
              </button>
              <div className="mt-4 rounded-lg border border-line bg-ink/40 p-3 text-[11px] flex-1">
                <p className="eyebrow mb-2 flex items-center gap-2">
                  Before you run{" "}
                  {planBusy && (
                    <LoaderCircle size={11} className="animate-spin" />
                  )}
                </p>
                {!selected.size && (
                  <p className="text-muted">
                    Select files in the tree to see lines, tokens and cost.
                  </p>
                )}
                {!groups.size && (
                  <p className="text-removed">
                    Choose at least one focus area.
                  </p>
                )}
                {planError && <p className="text-removed">{planError}</p>}
                {plan && !planBusy && (
                  <dl className="divide-y divide-line/60">
                    {[
                      [
                        "Files · lines",
                        `${number(plan.file_count)} · ${number(plan.lines)}`,
                      ],
                      ["Source tokens", `~${number(plan.source_tokens)}`],
                      [
                        "Model calls",
                        plan.mode === "single"
                          ? "1 review + 1 summary"
                          : `${plan.batch_count} review + 1 summary`,
                      ],
                      ["Input tokens", `~${number(plan.input_tokens)}`],
                      ["Output tokens (max)", number(plan.output_tokens_max)],
                      [
                        "Cost (max)",
                        `${usd(plan.cost?.total_max_usd)}${plan.cost?.complete ? "" : "*"}`,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex justify-between gap-3 py-1.5"
                      >
                        <dt className="text-muted">{label}</dt>
                        <dd className="tabular-nums text-right">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {plan?.split_files?.length > 0 && (
                  <p className="text-amber mt-2">
                    {plan.split_files.length} large file(s) are read in parts.
                  </p>
                )}
                {plan && (
                  <p className="text-muted mt-2 leading-relaxed">
                    {plan.mode === "staged"
                      ? "The selection is larger than one request, so it is reviewed in batches. "
                      : ""}
                    Actual usage and cost appear after the run. * = a rate is
                    not set.
                  </p>
                )}
              </div>
            </div>
          </div>
          {!settings?.configured && (
            <button
              className="text-xs text-amber mt-4 flex items-center gap-2"
              onClick={onConfigure}
            >
              <KeyRound size={13} />
              Add the endpoint, API key and model for{" "}
              {settings?.active?.label || "the active provider"}.
            </button>
          )}
        </section>

        <Result
          job={job}
          settings={settings}
          onConfigure={onConfigure}
          onError={onError}
          umlJobs={umlJobs}
          umlBusy={umlBusy}
          onUml={openUml}
          renderers={renderers}
        />
      </main>
    </div>
  );
}

function Result({
  job,
  settings,
  onConfigure,
  onError,
  umlJobs,
  umlBusy,
  onUml,
  renderers,
}) {
  if (!job)
    return (
      <div className="card min-h-[340px] flex flex-col items-center justify-center text-center px-8">
        <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5">
          <ShieldCheck size={34} className="text-sky-400" />
        </div>
        <h2 className="text-xl font-semibold">How solid is your design?</h2>
        <p className="text-muted max-w-lg text-sm mt-3 leading-relaxed">
          Pick the files, choose what to check and run the review. The report
          scores each area, explains every problem and proposes a fix you can
          try in a sandbox. It downloads as a PDF.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <span className="pill">SOLID</span>
          <span className="pill">OOP</span>
          <span className="pill">Patterns</span>
          <span className="pill">Architecture</span>
          <span className="pill">Sandbox</span>
          <span className="pill">PDF</span>
        </div>
      </div>
    );
  if (isActive(job.status)) {
    const done = (job.counts?.done || 0) + (job.counts?.failed || 0);
    const pct = job.counts?.batches
      ? Math.round((done / job.counts.batches) * 100)
      : 0;
    return (
      <div
        role="status"
        className="card p-10 flex flex-col items-center text-center min-h-[300px] justify-center"
      >
        <BrandLoader className="brand-loader-inline mb-5" />
        <h2 className="text-xl font-semibold">{job.stage || "Preparing"}</h2>
        <p className="text-muted text-sm mt-3 max-w-md">
          Reviewing {job.counts?.files} files ({number(job.counts?.lines)}{" "}
          lines). The report appears here and is saved automatically.
        </p>
        <div
          className="sd-progress mt-6 w-full max-w-sm"
          aria-label="Review progress"
        >
          <span style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
        <p className="text-[11px] text-muted mt-2">
          {done} of {job.counts?.batches} review batches ·{" "}
          {number(job.usage?.input_tokens)} in /{" "}
          {number(job.usage?.output_tokens)} out tokens so far
        </p>
      </div>
    );
  }
  if (!job.report)
    return (
      <div
        role="alert"
        className={`card p-8 ${job.status === "cancelled" ? "border-amber/30" : "border-removed/30"}`}
      >
        <AlertTriangle
          className={`${job.status === "cancelled" ? "text-amber" : "text-removed"} mb-4`}
        />
        <h2 className="text-xl font-semibold">
          {job.status === "cancelled"
            ? "Review stopped"
            : "The review could not be completed"}
        </h2>
        <p className="text-sm text-muted mt-3">
          {job.error || "No report was produced."}
        </p>
        {(job.batches || []).some((b) => b.error) && (
          <ul className="list-disc pl-5 mt-3 text-xs text-muted space-y-1">
            {job.batches
              .filter((b) => b.error)
              .map((b) => (
                <li key={b.number}>
                  Batch {b.number}: {b.error}
                </li>
              ))}
          </ul>
        )}
      </div>
    );
  return (
    <ReportView
      job={job}
      settings={settings}
      onConfigure={onConfigure}
      onError={onError}
      umlJobs={umlJobs}
      umlBusy={umlBusy}
      onUml={onUml}
      renderers={renderers}
    />
  );
}

function Card({ title, icon: Icon, children, className = "", right }) {
  return (
    <section className={`card p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="section-title !text-base">
          {Icon && <Icon size={16} className="text-sky-400" />}
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function ReportView({
  job,
  settings,
  onConfigure,
  onError = () => {},
  umlJobs = [],
  umlBusy = null,
  onUml = () => {},
  renderers = { mermaid: true },
}) {
  const report = job.report;
  const [group, setGroup] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [demos, setDemos] = useState({}); // demos written on request, by finding id
  const findings = useMemo(
    () =>
      (report.findings || []).map((f) =>
        demos[f.id] ? { ...f, runnable_python: demos[f.id].code, demo_runtime: demos[f.id].runtime } : f,
      ),
    [report.findings, demos],
  );
  const evaluated = (report.groups || []).filter((g) => g.evaluated);
  const counts = report.severity_counts || {};
  const cost = job.cost || {};
  const filtered = useMemo(
    () =>
      findings.filter(
        (f) =>
          (group === "all" || f.group === group) &&
          (severity === "all" || f.severity === severity) &&
          (!query.trim() ||
            `${f.title} ${f.file} ${f.problem} ${f.symbol} ${f.principle_label}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())),
      ),
    [findings, group, severity, query],
  );
  const byPrinciple = useMemo(
    () =>
      Object.entries(
        findings.reduce((acc, f) => {
          acc[f.principle_label] = (acc[f.principle_label] || 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
    [findings],
  );
  const arch = report.architecture || {};
  const deps = report.metrics?.dependencies || {};
  const toggle = (id) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const idToTitle = Object.fromEntries(findings.map((f) => [f.id, f.title]));
  const jump = (id) => {
    setGroup("all");
    setSeverity("all");
    setQuery("");
    setOpen((current) => new Set(current).add(id));
    setTimeout(
      () =>
        document
          .getElementById(`finding-${id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
  };

  return (
    <div className="space-y-5">
      {(job.status !== "completed" || report.partial) && (
        <div
          role="status"
          className="rounded-lg border border-amber/30 bg-amber/10 p-4 text-sm text-amber flex gap-3"
        >
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            {job.error || "This is a partial review."}
            {report.coverage?.not_reviewed?.length
              ? ` ${report.coverage.not_reviewed.length} file(s) were not reviewed.`
              : ""}
          </span>
        </div>
      )}

      <section className="card p-6">
        <div className="flex flex-wrap items-start gap-6">
          <ScoreRing
            score={report.overall?.score}
            grade={report.overall?.grade}
          />
          <div className="flex-1 min-w-[260px]">
            <div className="flex flex-wrap justify-between items-start gap-3">
              <div className="min-w-0">
                <p
                  className="eyebrow"
                  style={{ color: scoreColor(report.overall?.score) }}
                >
                  Design review{" "}
                  {job.status === "completed" ? "complete" : "result"}
                </p>
                <h2 className="text-2xl font-semibold mt-1">
                  {job.workspace_name}
                </h2>
                <p className="text-muted text-xs mt-1">
                  {new Date(job.created_at).toLocaleString()} · {job.deployment}
                  {job.provider_label ? ` · ${job.provider_label}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  className="btn-primary"
                  href={solidDownloadUrl(job.id, "pdf")}
                  download
                >
                  <FileCode2 size={15} />
                  PDF report
                </a>
                <a
                  className="btn"
                  href={solidDownloadUrl(job.id, "json")}
                  download
                  aria-label="Download JSON"
                >
                  <FileJson size={15} />
                  JSON
                </a>
              </div>
            </div>
            <p className="text-sm leading-7 text-fg/90 mt-4 max-w-4xl">
              <Text text={report.executive_summary} />
            </p>
          </div>
        </div>
        <div
          className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mt-6"
          aria-label="Review totals"
        >
          {[
            [
              "Files reviewed",
              `${report.coverage?.reviewed?.length ?? job.counts.files} / ${job.counts.files}`,
            ],
            ["Lines", number(job.counts.lines)],
            ["Findings", `${findings.length}`],
            [
              "Critical + high",
              `${(counts.critical || 0) + (counts.high || 0)}`,
            ],
            [
              "Tokens in / out",
              `${number(job.usage?.input_tokens)} / ${number(job.usage?.output_tokens)}`,
            ],
            [
              cost.complete ? "Cost from usage" : "Known cost subtotal",
              money(cost.complete ? cost.total_usd : cost.known_subtotal_usd),
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-elevated/60 p-3">
              <div className="text-[11px] text-muted">{label}</div>
              <div className="text-lg font-semibold mt-1 tabular-nums break-words">
                {value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-5">
        <Card title="Scorecard" icon={Layers}>
          <Radar
            items={evaluated.map((g) => ({ label: g.short, value: g.score }))}
          />
        </Card>
        <Card title="Score by area" icon={Layers}>
          <BarList
            items={evaluated.map((g) => ({
              label: g.label,
              value: g.score,
              color: scoreColor(g.score),
              right: `${g.score} · ${g.findings}`,
              title: `${g.label}: score ${g.score}, ${g.findings} findings`,
            }))}
          />
          <p className="text-[11px] text-muted mt-4">
            Score (0-100) · findings. Score = 100 / (1 + severity-weighted
            findings / size factor).
          </p>
        </Card>
        <Card title="Findings by severity" icon={AlertTriangle}>
          <StackedBar
            segments={SEVERITIES.map((s) => ({
              label: s,
              value: counts[s] || 0,
              color: SEV_COLOR[s],
            }))}
          />
          <p className="text-[11px] text-muted mt-4">
            Quick wins (small effort, medium or higher):{" "}
            {report.quick_wins?.length
              ? report.quick_wins.map((id) => (
                  <button
                    key={id}
                    className="sd-link mx-0.5"
                    onClick={() => jump(id)}
                  >
                    {id}
                  </button>
                ))
              : "none"}
          </p>
        </Card>
        <Card title="SOLID principles" icon={ShieldCheck}>
          <BarList
            empty="SOLID was not in the focus areas."
            items={(report.principles || [])
              .filter((p) => p.group === "solid")
              .map((p) => ({
                label: p.label,
                value: p.score,
                color: scoreColor(p.score),
                right: `${p.score} · ${p.findings}`,
              }))}
          />
        </Card>
        <Card title="Findings by principle" icon={GitBranch}>
          <BarList
            empty="No findings."
            items={byPrinciple.map(([label, count]) => ({
              label,
              value: (count / byPrinciple[0][1]) * 100,
              color: "#3698ef",
              right: count,
            }))}
          />
        </Card>
        <Card title="Hotspot files" icon={FileCode2}>
          <BarList
            empty="No file has findings."
            items={(report.hotspots || []).slice(0, 8).map((h) => ({
              label: h.path.split("/").pop(),
              title: h.path,
              value: (h.findings / report.hotspots[0].findings) * 100,
              color: h.critical
                ? SEV_COLOR.critical
                : h.high
                  ? SEV_COLOR.high
                  : SEV_COLOR.medium,
              right: h.findings,
            }))}
          />
        </Card>
      </div>

      {(arch.description || arch.layers?.length > 0) && (
        <Card
          title="Architecture overview (HLD)"
          icon={Layers}
          right={arch.style ? <span className="pill">{arch.style}</span> : null}
        >
          <p className="text-sm leading-7 text-fg/90 max-w-4xl">
            <Text text={arch.description} />
          </p>
          <div className="grid xl:grid-cols-2 gap-6 mt-5">
            {arch.data_flow?.length > 0 && (
              <div>
                <p className="eyebrow mb-3">Data flow, input to output</p>
                <ol className="sd-flow">
                  {arch.data_flow.map((step, i) => (
                    <li key={i}>
                      <span className="sd-flow-dot">{i + 1}</span>
                      <span className="text-sm leading-6">
                        <Text text={step} />
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <div className="space-y-5">
              {arch.layers?.length > 0 && (
                <div>
                  <p className="eyebrow mb-3">Layers</p>
                  <div className="space-y-2">
                    {arch.layers.map((l) => (
                      <div
                        key={l.name}
                        className="rounded-lg border border-line p-3"
                      >
                        <p className="text-sm font-semibold">{l.name}</p>
                        <p className="text-xs text-muted mt-0.5">
                          {l.responsibility}
                        </p>
                        {l.files.length > 0 && (
                          <p className="font-mono text-[10.5px] text-sky-400 mt-1.5 break-all">
                            {l.files.join(" · ")}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {arch.concerns?.length > 0 && (
                <div>
                  <p className="eyebrow mb-2">Concerns</p>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-fg/85">
                    {arch.concerns.map((c, i) => (
                      <li key={i}>
                        <Text text={c} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid xl:grid-cols-2 gap-5 items-start">
        {report.patterns?.length > 0 && (
          <Card title="Design patterns" icon={GitBranch}>
            <div className="overflow-x-auto">
              <table className="sd-table">
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Where and why</th>
                  </tr>
                </thead>
                <tbody>
                  {report.patterns.map((p, i) => (
                    <tr key={i}>
                      <td className="font-medium whitespace-nowrap">
                        {p.name}
                      </td>
                      <td>{p.category.toLowerCase()}</td>
                      <td>
                        <span
                          className={`rating ${p.status === "used" ? "rating-pass" : p.status === "missing" ? "rating-medium" : "rating-high"}`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="text-muted">
                        {p.files.length > 0 && (
                          <span className="font-mono text-[10.5px] text-sky-400 block break-all">
                            {p.files.slice(0, 3).join(" · ")}
                          </span>
                        )}
                        <Text text={p.note} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.pattern_summary?.length > 0 && (
              <ul className="list-disc pl-5 space-y-1 text-xs text-fg/85 mt-4">
                {report.pattern_summary.map((p, i) => (
                  <li key={i}>
                    <b>{p.pattern}</b> ({p.status}):{" "}
                    <Text text={p.recommendation} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {deps.supported && (
          <Card title="Dependencies and coupling" icon={Layers}>
            <p className="text-sm text-fg/85">
              {deps.edges} import links between the reviewed files.
              {deps.cycles?.length ? (
                <span className="text-removed font-medium">
                  {" "}
                  {deps.cycles.length} circular dependency group(s).
                </span>
              ) : (
                <span className="text-added font-medium">
                  {" "}
                  No circular dependencies.
                </span>
              )}
            </p>
            {deps.cycles?.map((cycle, i) => (
              <p
                key={i}
                className="font-mono text-[11px] mt-2 rounded border border-removed/30 bg-removed/10 p-2 break-all"
              >
                {cycle.join("  ↔  ")}
              </p>
            ))}
            <div className="mt-4">
              <BarList
                empty="No import links found."
                items={(deps.nodes || []).slice(0, 8).map((n) => ({
                  label: n.path.split("/").pop(),
                  title: `${n.path}: imported by ${n.fan_in}, imports ${n.fan_out}`,
                  value:
                    ((n.fan_in + n.fan_out) /
                      (deps.nodes[0].fan_in + deps.nodes[0].fan_out || 1)) *
                    100,
                  color: "#8b91a7",
                  right: `${n.fan_in} in · ${n.fan_out} out`,
                }))}
              />
            </div>
          </Card>
        )}
      </div>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="section-title !text-base">
            <AlertTriangle size={16} className="text-sky-400" />
            Findings and proposed solutions{" "}
            <span className="pill">
              {filtered.length} of {findings.length}
            </span>
          </h3>
          <div className="relative">
            <Search
              size={13}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              className="input !pl-8 !py-1.5 text-xs w-56"
              placeholder="Search findings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search findings"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          <button
            className={`sd-chip ${group === "all" ? "sd-chip-on" : ""}`}
            onClick={() => setGroup("all")}
          >
            All areas {findings.length}
          </button>
          {GROUPS.filter((g) => findings.some((f) => f.group === g.key)).map(
            (g) => (
              <button
                key={g.key}
                className={`sd-chip ${group === g.key ? "sd-chip-on" : ""}`}
                onClick={() => setGroup(g.key)}
              >
                {g.label} {findings.filter((f) => f.group === g.key).length}
              </button>
            ),
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            className={`sd-chip ${severity === "all" ? "sd-chip-on" : ""}`}
            onClick={() => setSeverity("all")}
          >
            Any severity
          </button>
          {SEVERITIES.filter((s) => counts[s]).map((s) => (
            <button
              key={s}
              className={`sd-chip ${severity === s ? "sd-chip-on" : ""}`}
              onClick={() => setSeverity(s)}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: SEV_COLOR[s] }}
              />
              {s} {counts[s]}
            </button>
          ))}
          {findings.length > 0 && (
            <button
              className="btn-small ml-auto"
              onClick={() =>
                setOpen(
                  open.size ? new Set() : new Set(filtered.map((f) => f.id)),
                )
              }
            >
              {open.size ? "Collapse all" : "Expand shown"}
            </button>
          )}
        </div>
        <div className="space-y-2.5">
          {filtered.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              open={open.has(f.id)}
              onToggle={() => toggle(f.id)}
              settings={settings}
              onConfigure={onConfigure}
              jobId={job.id}
              sandboxOn={Boolean(job.options?.sandbox)}
              onError={onError}
              onDemo={(id, code, runtime) => setDemos((d) => ({ ...d, [id]: { code, runtime } }))}
            />
          ))}
          {!filtered.length && (
            <p className="text-sm text-muted py-6 text-center">
              {findings.length
                ? "No finding matches these filters."
                : "No design issues were found in the reviewed code."}
            </p>
          )}
        </div>
      </section>

      {report.roadmap?.length > 0 && (
        <Card title="Improvement roadmap" icon={GitBranch}>
          <ol className="sd-timeline">
            {report.roadmap.map((phase, i) => (
              <li key={i}>
                <span className="sd-flow-dot">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{phase.phase}</p>
                  <p className="text-xs text-muted mt-0.5">
                    <Text text={phase.goal} />
                  </p>
                  {phase.actions.length > 0 && (
                    <ul className="list-disc pl-5 mt-2 space-y-1 text-sm text-fg/90">
                      {phase.actions.map((a, j) => (
                        <li key={j}>
                          <Text text={a} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {phase.finding_ids.length > 0 && (
                    <p className="mt-2 text-[11px] text-muted">
                      Findings:{" "}
                      {phase.finding_ids.map((id) => (
                        <button
                          key={id}
                          className="sd-link mr-1.5"
                          onClick={() => jump(id)}
                          title={idToTitle[id]}
                        >
                          {id}
                        </button>
                      ))}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid xl:grid-cols-2 gap-5 items-start">
        {(report.strengths_summary?.length > 0 ||
          report.strengths?.length > 0) && (
          <Card title="What the code does well" icon={Check}>
            <ul className="list-disc pl-5 space-y-1.5 text-sm text-fg/90">
              {(report.strengths_summary?.length
                ? report.strengths_summary
                : report.strengths
                    .slice(0, 8)
                    .map((s) => `${s.title}: ${s.explanation}`)
              ).map((s, i) => (
                <li key={i}>
                  <Text text={s} />
                </li>
              ))}
            </ul>
          </Card>
        )}
        <UmlCard
          recommendations={report.uml_recommendations || []}
          umlJobs={umlJobs.filter((j) => j.counts?.source === job.id)}
          busy={umlBusy}
          onOpen={onUml}
          renderers={renderers}
        />
      </div>

      {report.classes?.length > 0 && (
        <details className="card p-5">
          <summary className="cursor-pointer text-sm font-semibold flex items-center gap-2">
            <Layers size={16} className="text-sky-400" />
            Class and module inventory{" "}
            <span className="pill">{report.classes.length}</span>
          </summary>
          <div className="overflow-x-auto mt-4">
            <table className="sd-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>File</th>
                  <th>Responsibility</th>
                  <th>Relations</th>
                </tr>
              </thead>
              <tbody>
                {report.classes.map((c, i) => (
                  <tr key={i}>
                    <td className="font-medium whitespace-nowrap">{c.name}</td>
                    <td>{c.kind}</td>
                    <td className="font-mono text-[10.5px] text-sky-400 break-all">
                      {c.file}
                    </td>
                    <td className="text-muted">{c.responsibility}</td>
                    <td className="text-muted text-[11px]">
                      {c.relations
                        .map((r) => `${r.type} ${r.target}`)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {(report.notes?.length > 0 ||
        report.coverage?.not_reviewed?.length > 0) && (
        <Card title="Assumptions and limitations" icon={Info}>
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-fg/85">
            {(report.notes || []).map((n, i) => (
              <li key={i}>
                <Text text={n} />
              </li>
            ))}
          </ul>
          {report.coverage?.not_reviewed?.length > 0 && (
            <p className="text-xs text-muted mt-3">
              Not reviewed:{" "}
              <span className="font-mono">
                {report.coverage.not_reviewed.slice(0, 20).join(", ")}
              </span>
            </p>
          )}
        </Card>
      )}
      <p className="text-[11px] text-muted">
        {number(job.usage?.requests)} model calls. Findings come from the
        model's reading of the code and tool-computed structure facts; scores
        are calculated from the findings. Nothing in your codebase was executed.
        Review every change before applying it.
      </p>
    </div>
  );
}

function CodeBlock({ code, label, tone = "" }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`sd-codewrap ${tone}`}>
      <div className="sd-codebar">
        <span>{label}</span>
        <button
          type="button"
          className="btn-small !py-0.5"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* blocked */
            }
          }}
        >
          {copied ? (
            <>
              <Check size={12} />
              Copied
            </>
          ) : (
            <>
              <ClipboardCopy size={12} />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="sd-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Which sandbox runtime a finding's demo uses, from its file name ("" = no sandbox demo for that language).
function demoRuntimeOf(file) {
  const name = String(file || "").toLowerCase();
  if (/\.pyw?$/.test(name)) return "python";
  if (/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(name)) return "node";
  return "";
}

export function FindingCard({
  f,
  open,
  onToggle,
  settings,
  onConfigure,
  jobId,
  sandboxOn = false,
  onError = () => {},
  onDemo = () => {},
}) {
  const { openDraft, openQuCoder, busy: drafting } = useChanges();
  const [writing, setWriting] = useState(false);
  const canApply = Boolean(f.file && f.before_code && f.after_code);
  // Sandbox demos: Python files run in Python, JavaScript / TypeScript files (React included) in Node.js;
  // other languages have no sandbox demo. Reviews saved before demo_runtime existed held Python demos only.
  const runtime = f.demo_runtime ?? (f.runnable_python ? "python" : demoRuntimeOf(f.file));
  async function writeDemo() {
    setWriting(true);
    try {
      const made = await api.solidDemo(jobId, f.id);
      onDemo(f.id, made.runnable_python, made.demo_runtime || runtime);
    } catch (err) {
      onError(err.message);
    } finally {
      setWriting(false);
    }
  }
  const where = f.file
    ? `${f.file}:${f.line_start}${f.line_end > f.line_start ? `-${f.line_end}` : ""}`
    : "Project-wide";
  return (
    <article
      id={`finding-${f.id}`}
      className={`sd-finding ${open ? "sd-finding-open" : ""}`}
      style={{ "--sev": SEV_COLOR[f.severity] }}
    >
      <button
        type="button"
        className="sd-finding-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={15} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-muted" />
        )}
        <span className={`rating rating-${f.severity} shrink-0`}>
          {f.severity}
        </span>
        <span className="font-mono text-[11px] text-muted shrink-0">
          {f.id}
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-medium truncate">{f.title}</span>
          <span className="block text-[11px] text-muted truncate">
            {f.principle_label} · {where}
            {f.symbol ? ` · ${f.symbol}` : ""}
          </span>
        </span>
        {f.runnable_python && (
          <span className="pill hidden sm:inline-flex shrink-0">Runnable</span>
        )}
        <span
          className="pill hidden sm:inline-flex shrink-0"
          title="Estimated effort: S small, M medium, L large"
        >
          effort {f.effort}
        </span>
      </button>
      {open && (
        <div className="sd-finding-body">
          <div className="grid lg:grid-cols-2 gap-5">
            <div>
              <p className="eyebrow mb-1.5">Problem</p>
              <p className="text-sm leading-6">
                <Text text={f.problem} />
              </p>
            </div>
            {f.why_it_matters && (
              <div>
                <p className="eyebrow mb-1.5">Why it matters</p>
                <p className="text-sm leading-6">
                  <Text text={f.why_it_matters} />
                </p>
              </div>
            )}
          </div>
          {f.evidence && (
            <CodeBlock code={f.evidence} label={`Evidence · ${where}`} />
          )}
          {f.fix_steps.length > 0 && (
            <div>
              <p className="eyebrow mb-2 flex flex-wrap items-center gap-2">
                How to fix it{" "}
                {f.suggested_pattern && (
                  <span className="pill">pattern: {f.suggested_pattern}</span>
                )}
              </p>
              <ol className="list-decimal pl-5 space-y-1.5 text-sm leading-6">
                {f.fix_steps.map((s, i) => (
                  <li key={i}>
                    <Text text={s} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          {f.occurrences.length > 0 && (
            <p className="text-xs text-muted">
              Also seen in:{" "}
              <span className="font-mono">{f.occurrences.join(", ")}</span>
            </p>
          )}
          {(f.before_code || f.after_code) && (
            <div
              className={`grid gap-4 ${f.before_code && f.after_code ? "xl:grid-cols-2" : ""}`}
            >
              {f.before_code && (
                <CodeBlock
                  code={f.before_code}
                  label="Current code"
                  tone="sd-before"
                />
              )}
              {f.after_code && (
                <CodeBlock
                  code={f.after_code}
                  label="Proposed code"
                  tone="sd-after"
                />
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canApply && (
              <button
                type="button"
                className="btn-primary !py-1.5 !text-xs"
                disabled={drafting}
                onClick={() =>
                  openDraft({
                    path: f.file,
                    title: `Solidify ${f.id}: ${f.title}`,
                    source: `solidify ${f.id}`,
                    edits: [
                      {
                        before_code: f.before_code,
                        after_code: f.after_code,
                        line_start: f.line_start,
                        line_end: f.line_end,
                      },
                    ],
                  })
                }
              >
                {drafting ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <GitCommitHorizontal size={14} />
                )}
                Apply this change…
              </button>
            )}
            <button
              type="button"
              className="btn !py-1.5 !text-xs"
              onClick={() =>
                openQuCoder({
                  files: f.file ? [f.file] : [],
                  prompt: `Fix this design issue${f.file ? ` in ${f.file} (lines ${f.line_start}-${f.line_end})` : ""}: ${f.title}.\n\nProblem: ${f.problem}\n\nHow to fix it:\n${f.fix_steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nMake the smallest safe change and keep the behaviour the same.`,
                })
              }
            >
              <Code2 size={14} />
              Fix with QuCoder
            </button>
          </div>
          {sandboxOn && !runtime && !f.runnable_python && (
            <p className="text-xs text-muted">
              Sandbox demos run for findings in Python and JavaScript / TypeScript files.
            </p>
          )}
          {(sandboxOn || f.runnable_python) && (runtime || f.runnable_python) && (
            <div>
              <p className="eyebrow mb-2">
                Try the proposed design in the sandbox
              </p>
              {f.runnable_python ? (
                <SandboxRunner
                  code={f.runnable_python}
                  runtime={runtime || "python"}
                  onNewDemo={async () => {
                    const made = await api.solidDemo(jobId, f.id);
                    onDemo(f.id, made.runnable_python, made.demo_runtime || runtime || "python");
                  }}
                  onFix={async (failure) => {
                    const made = await api.solidDemoFix(jobId, f.id, failure);
                    onDemo(f.id, made.runnable_python, made.demo_runtime || failure.runtime);
                  }}
                  settings={settings}
                  onConfigure={onConfigure}
                />
              ) : (
                <div className="sd-demo-empty">
                  <p className="text-xs text-muted leading-relaxed">
                    No demo was written for this finding. QuCoRe can write a{" "}
                    {runtime === "node" ? "Node.js" : "Python"} program that runs
                    the old and new design side by side on made-up data and
                    prints what happens.
                  </p>
                  <button
                    type="button"
                    className="btn !py-1.5 !text-xs shrink-0"
                    onClick={writeDemo}
                    disabled={writing}
                  >
                    {writing ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    {writing ? "Writing the demo…" : "Write a demo"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const UML_TYPES = [
  ["class", "Class", Boxes],
  ["sequence", "Sequence", Share2],
  ["activity", "Activity", Workflow],
  ["state", "State", GitBranch],
  ["usecase", "Use case", Network],
  ["object", "Object", Layers],
];
const typeOf = (name) =>
  /sequence/i.test(name)
    ? "sequence"
    : /activity/i.test(name)
      ? "activity"
      : /state/i.test(name)
        ? "state"
        : /use\s*case/i.test(name)
          ? "usecase"
          : /object/i.test(name)
            ? "object"
            : "class";

// UML diagrams of the reviewed code. Each link draws the diagram (once) and opens it in the Flow tab.
function UmlCard({ recommendations, umlJobs, busy, onOpen, renderers }) {
  const state = (type) => {
    const jobs = umlJobs.filter(
      (j) =>
        j.counts?.diagram === type &&
        !["failed", "cancelled"].includes(j.status),
    );
    return jobs.some((j) => ["queued", "running"].includes(j.status))
      ? "running"
      : jobs.length
        ? "ready"
        : "new";
  };
  const label = (type) =>
    busy === type || state(type) === "running"
      ? "Drawing…"
      : state(type) === "ready"
        ? "Open in Flow"
        : "Generate";
  const using = renderers.reactflow ? "React Flow" : "Mermaid";
  return (
    <Card
      title="UML diagrams"
      icon={Network}
      right={<span className="pill">opens in Flow</span>}
    >
      <p className="text-xs text-muted mb-4 leading-relaxed">
        Drawn from the reviewed code, then shown in the Flow tab with{" "}
        {using}. Pick the renderer above the Run button.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {UML_TYPES.map(([key, name, Icon]) => (
          <button
            key={key}
            type="button"
            className={`sd-uml-btn ${state(key) === "ready" ? "sd-uml-ready" : ""}`}
            disabled={Boolean(busy) && busy !== key}
            onClick={() => onOpen(key, "")}
          >
            <Icon size={16} className="text-sky-400" />
            <span className="text-xs font-semibold">{name}</span>
            <span className="text-[10px] text-muted flex items-center gap-1">
              {(busy === key || state(key) === "running") && (
                <LoaderCircle size={10} className="animate-spin" />
              )}
              {label(key)}
            </span>
          </button>
        ))}
      </div>
      {recommendations.length > 0 && (
        <>
          <p className="eyebrow mt-5 mb-2">Recommended for this code</p>
          <ul className="space-y-3">
            {recommendations.map((u, i) => {
              const type = typeOf(u.diagram);
              return (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <b>{u.diagram}</b>{" "}
                    <span className="text-muted">· {u.scope}</span>
                    <p className="text-xs text-fg/80 mt-0.5 leading-5">
                      {u.why}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-small shrink-0"
                    disabled={Boolean(busy) && busy !== type}
                    onClick={() => onOpen(type, u.scope)}
                  >
                    {label(type)}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
