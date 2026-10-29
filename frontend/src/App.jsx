import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bug,
  ChevronRight,
  Code2,
  FileSearch,
  FolderOpen,
  FolderSearch,
  History,
  KeyRound,
  LoaderCircle,
  MessagesSquare,
  Play,
  Square,
  Settings2,
  Workflow,
  X,
  ShieldCheck,
  GitCommitHorizontal,
  ShieldAlert,
  ChartColumnBig,
} from "lucide-react";
import { api } from "./api.js";
import useRunStop from "./useRunStop.js";
import FileTree, { Checkbox, collectFiles } from "./components/FileTree.jsx";
import PromptLibrary from "./components/PromptLibrary.jsx";
import Dashboard from "./components/Dashboard.jsx"; // cost & token dashboard (third button beside Prompts, Credentials)
import BrandLoader from "./components/BrandLoader.jsx"; // the QuCoRe icon loader used everywhere
import AppTour from "./components/AppTour.jsx"; // guided tours (driver.js): first visit, and the "?" menu
import { lastUi, rememberUi } from "./uiCache.js"; // last layout from the backend, for when it is not reachable
import useHeaderAlign from "./useHeaderAlign.js"; // header tabs start where the left sidebar ends
import SettingsPanel from "./components/SettingsPanel.jsx";
import ProviderSwitch from "./components/ProviderSwitch.jsx";
import ReportView from "./components/ReportView.jsx";
import SelectionMetrics from "./components/SelectionMetrics.jsx";
import { money } from "./components/UsageMetrics.jsx";
import SonarFixes from "./components/SonarFixes.jsx";
import FlowMap from "./components/FlowMap.jsx";
import CodeQA from "./components/CodeQA.jsx";
import Solidify from "./components/Solidify.jsx";
import QuCoder from "./components/QuCoder.jsx";
import QuScan from "./components/QuScan.jsx";
import { ChangesProvider, useChanges } from "./components/ChangesContext.jsx";
import GithubImport, { setRepoHint } from "./components/GithubImport.jsx";
import TabTitle from "./components/TabTitle.jsx";
import { ModeRail } from "./components/Hackathon.jsx";
import HomePage from "./components/HomePage.jsx";
import PanelToggles, { usePanels } from "./components/PanelToggle.jsx";

// Four tabs. QuReview groups four tools as modes (right-hand panel); every tool keeps its own screen and logic.
const REVIEW_GROUP = ["review", "sonar", "solid", "flow"];
const NAV = [
  ["review", FileSearch, "QuReview", "QuReview"],
  ["coder", Code2, "QuCoder", "QuCoder"],
  ["qa", MessagesSquare, "QuBot", "QuBot"],
  ["quscan", ShieldAlert, "QuScan", "QuScan"],
];
// Modes of the merged tabs, shown in the right-hand panel: [id, icon, title, hint, colour (r g b)]
const REVIEW_MODES = [
  [
    "review",
    FileSearch,
    "QuCodRev",
    "Prompt-driven code review with a PDF report",
    "56 189 248",
  ],
  ["sonar", Bug, "QuSonar", "Explain and fix SonarQube issues", "245 158 11"],
  [
    "solid",
    ShieldCheck,
    "QuSolids",
    "SOLID, OOP, HLD and LLD review with sandbox demos",
    "139 92 246",
  ],
  ["flow", Workflow, "QuFlow", "Flow maps and UML diagrams", "16 185 129"],
];
export default function App() {
  useHeaderAlign();
  const [tab, setTab] = useState("review");
  const [flowView, setFlowView] = useState("flow"); // Flow tab: "flow" (flow maps) or "uml" (UML diagrams)
  const [umlOpen, setUmlOpen] = useState(null); // { id, renderers, nonce } sent from Solidify's UML links
  const [coderSeed, setCoderSeed] = useState(null); // { files, prompt, nonce } sent from "Fix with QuCoder" buttons
  const [light] = useState(true); // day (light) theme only
  const [settings, setSettings] = useState(null);
  // Tabs and samples from backend/.env (QUCORE_TABS, QUCORE_SAMPLE_REPOS ...). Until settings load (or with no backend
  // running), what the backend last reported in this browser, else all four tools (uiCache.js).
  const ui = useMemo(() => settings?.ui || lastUi(), [settings]);
  useEffect(() => {
    if (settings?.ui) rememberUi(settings.ui);
  }, [settings]);
  const navItems = NAV.filter(([id]) => !ui.tabs?.length || ui.tabs.includes(id));
  // Right-hand mode panel of QuReview and the hide/show handles of the side panels.
  const modeRail = REVIEW_GROUP.includes(tab);
  const panels = usePanels();
  // Home page: the four tools side by side; opened on start and by the logo.
  const showHome = tab === "home";
  const homeOpened = useRef(false);
  useEffect(() => {
    if (homeOpened.current) return;
    homeOpened.current = true;
    setTab("home");
  }, []);
  const navActive = (id) =>
    tab === id || (id === "review" && REVIEW_GROUP.includes(tab));
  const [prompts, setPrompts] = useState([]);
  const [promptId, setPromptId] = useState("");
  const [rootInput, setRootInput] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [opening, setOpening] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewRequest = useRef(null);
  const [embeddings, setEmbeddings] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [review, setReview] = useState(null);
  const [runningId, setRunningId] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectionPlan, setSelectionPlan] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [planVersion, setPlanVersion] = useState(0);
  const reportRequest = useRef(0);
  const runStop = useRunStop(runningId, launching, api.stopReview, setError);

  // A tab hidden by QUCORE_TABS falls back to the first tab shown.
  useEffect(() => {
    if (
      !settings ||
      !navItems.length ||
      tab === "prompts" ||
      tab === "settings" ||
      tab === "dashboard" ||
      tab === "home"
    )
      return;
    const shown = navItems.flatMap(([id]) =>
      id === "review" ? REVIEW_GROUP : [id],
    );
    if (!shown.includes(tab)) setTab(navItems[0][0]);
  }, [settings, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reopen the last folder or GitHub repository this person used (stored per user),
  // so a refresh or a new visit continues where they left off. Once per page load.
  const restoredWorkspace = useRef(false);
  useEffect(() => {
    if (!settings || restoredWorkspace.current) return;
    restoredWorkspace.current = true;
    api
      .restoreWorkspace()
      .then((last) => {
        if (last?.expired && last.github) {
          // the GitHub download was deleted after inactivity: fill in its URL to import again
          setRepoHint({ ...last.github, minutes: last.idle_minutes });
          return;
        }
        if (!last?.restored || !last.id) return;
        setWorkspace((current) => current || last);
        setRootInput((current) => current || last.root);
      })
      .catch(() => {});
  }, [settings]);

  async function initialize() {
    setLoading(true);
    setError("");
    try {
      const [s, p, r] = await Promise.all([
        api.settings(),
        api.prompts(),
        api.reviews(),
      ]);
      setSettings(s);
      setPrompts(p);
      setJobs(r);
      setPromptId((id) =>
        p.some((item) => item.id === id) ? id : p[0]?.id || "",
      );
      const pending = r.find((item) =>
        ["queued", "running"].includes(item.status),
      );
      setRunningId(pending?.id || null);
      if (pending || r[0]) setReview(await api.review((pending || r[0]).id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    initialize();
    return () => previewRequest.current?.abort();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }, [light]);
  useEffect(() => {
    if (!runningId) return;
    let stopped = false;
    let timer;
    async function poll() {
      try {
        const next = await api.review(runningId);
        if (stopped) return;
        setPollError("");
        setReview((current) =>
          !current || current.id === runningId ? next : current,
        );
        setJobs((items) =>
          [next, ...items.filter((item) => item.id !== next.id)].slice(0, 100),
        );
        if (["completed", "failed", "cancelled"].includes(next.status)) {
          setRunningId(null);
          return;
        }
      } catch (err) {
        if (!stopped)
          setPollError(`Status update failed. Retrying… ${err.message}`);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runningId]);

  useEffect(() => {
    setSelectionPlan(null);
    setPlanError("");
    if (!workspace || !selected.size) {
      setPlanBusy(false);
      return;
    }
    const controller = new AbortController();
    setPlanBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.preview(
          {
            workspace_id: workspace.id,
            files: [...selected],
            prompt_id: promptId,
            use_embeddings: false,
          },
          controller.signal,
        );
        if (!controller.signal.aborted) setSelectionPlan(result);
      } catch (err) {
        if (!controller.signal.aborted) setPlanError(err.message);
      } finally {
        if (!controller.signal.aborted) setPlanBusy(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspace, selected, promptId, prompts, settings, planVersion]);

  const files = useMemo(
    () => (workspace ? collectFiles(workspace.tree) : []),
    [workspace],
  );
  const activePrompt = prompts.find((prompt) => prompt.id === promptId);
  const busy = Boolean(runningId) || launching;
  const selectPaths = (paths, enabled) =>
    setSelected((current) => {
      const next = new Set(current);
      paths.forEach((path) => (enabled ? next.add(path) : next.delete(path)));
      return next;
    });
  async function openFolder(event) {
    event.preventDefault();
    setOpening(true);
    setError("");
    try {
      const result = await api.openWorkspace(rootInput.trim());
      previewRequest.current?.abort();
      setPreview(null);
      setPreviewBusy(false);
      setWorkspace(result);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setOpening(false);
    }
  }
  // "Browse": native folder dialog; the chosen folder opens straight away.
  async function browseFolder() {
    setBrowsing(true);
    setError("");
    try {
      const picked = await api.pickFolder(rootInput.trim());
      if (!picked?.path) return;
      setRootInput(picked.path);
      setOpening(true);
      adoptWorkspace(await api.openWorkspace(picked.path));
    } catch (err) {
      setError(err.message);
    } finally {
      setBrowsing(false);
      setOpening(false);
    }
  }
  // A folder opened from the SonarQube or Flow map tab becomes the shared
  // workspace, reset exactly as the Review tab's own "Open folder" does.
  function adoptWorkspace(result) {
    previewRequest.current?.abort();
    setPreview(null);
    setPreviewBusy(false);
    setWorkspace(result);
    setSelected(new Set());
    setRootInput(result.root);
  }
  async function openFile(path) {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewBusy(true);
    setPreview({ path, content: "" });
    try {
      const result = await api.file(workspace.id, path, controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      if (!controller.signal.aborted) setPreviewBusy(false);
    }
  }
  async function run() {
    runStop.begin();
    setLaunching(true);
    setError("");
    // Invalidate any slower history load before switching to this new run.
    reportRequest.current += 1;
    try {
      const job = await api.run({
        workspace_id: workspace.id,
        files: [...selected],
        prompt_id: promptId,
        use_embeddings: embeddings,
      });
      const initial = {
        ...job,
        stage: "Queued",
        title: activePrompt.name,
        file_count: selected.size,
        created_at: new Date().toISOString(),
      };
      setReview(initial);
      setJobs((items) => [initial, ...items]);
      setRunningId(job.id);
      await runStop.started(job.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLaunching(false);
    }
  }
  async function showReport(id) {
    const sequence = ++reportRequest.current;
    setError("");
    try {
      const result = await api.review(id);
      if (sequence === reportRequest.current) {
        setReview(result);
        setTab("review");
      }
    } catch (err) {
      if (sequence === reportRequest.current) setError(err.message);
    }
  }
  const canRun =
    !busy &&
    !opening &&
    !planBusy &&
    selectionPlan?.can_run &&
    workspace &&
    selected.size &&
    activePrompt &&
    settings?.configured &&
    (!embeddings || settings?.embedding_deployment);
  // Solidify -> Flow: show a UML diagram in the Flow tab.
  function openUml(request) {
    setUmlOpen({ ...request, nonce: Date.now() });
    setFlowView("uml");
    setTab("flow");
  }
  // Any tab -> QuCoder: preselect files and prefill the request.
  function openQuCoder(seed) {
    setCoderSeed({ ...seed, nonce: Date.now() });
    setTab("coder");
  }

  return (
    <ChangesProvider
      workspace={workspace}
      light={light}
      onError={setError}
      onOpenQuCoder={openQuCoder}
    >
      <div className={`min-h-screen bg-ink text-fg ${panels.className}`}>
        <header className="app-header border-b border-line bg-panel px-5 lg:px-8 h-[96px] grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-5">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setTab("home");
            }}
            className="col-start-1 justify-self-start flex items-center gap-3"
          >
            <span className="brand-mark relative">
              <img
                src="/qucore 2 logo.png"
                alt="QuCoRe logo"
                className="w-22 h-22 object-contain"
              />
              <span
                className="oss-sticker"
                title="Open source (Apache-2.0)"
                aria-label="Open source"
              >
                OSS
              </span>
            </span>
            <span className="brand-tag hidden 2xl:block">
              <span className="block text-[12px] text-muted tracking-[.16em] uppercase mt-0.5">
                Quick
              </span>
              <span className="block text-[12px] text-muted tracking-[.16em] uppercase">
                Code
              </span>
              <span className="block text-[12px] text-muted tracking-[.16em] uppercase">
                Review
              </span>
            </span>
          </a>
          <nav
            className="col-start-2 justify-self-center hidden xl:flex gap-1 bg-ink border border-line p-1 rounded-xl"
            aria-label="Main navigation"
            data-tour="nav"
          >
            {navItems.map(([id, Icon, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`nav-btn ${navActive(id) ? "bg-elevated text-fg shadow-xs" : "text-muted"}`}
                aria-current={navActive(id) ? "page" : undefined}
                title={label}
              >
                <Icon size={15} />
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </nav>
          <div className="col-start-3 justify-self-end flex items-center gap-2.5">
            <span className="inline-flex" data-tour="changes">
              <ChangesButton onClick={() => {}} />
            </span>
            <div
              className="cfg-group"
              role="group"
              aria-label="Customization"
            >
              {[
                ["prompts", BookOpen, "Prompts"],
                ["settings", Settings2, "Credentials"],
                ["dashboard", ChartColumnBig, "Dashboard"],
              ].map(([id, Icon, label]) => (

                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={`cfg-btn cfg-${id} ${tab === id ? "cfg-btn-on" : ""}`}
                    aria-current={tab === id ? "page" : undefined}
                    title={label}
                  >
                    <Icon size={15} />
                    <span className="hidden 2xl:inline">{label}</span>
                  </button>
                ))}
            </div>
            {settings && (
              <span className="inline-flex" data-tour="model">
                <ProviderSwitch
                  settings={settings}
                  busy={Boolean(runningId)}
                  onChange={setSettings}
                  onError={setError}
                  onConfigure={() => setTab("settings")}
                />
              </span>
            )}
            <PoweredBy />
            <AppTour ready={!loading} tab={tab} tabs={ui.tabs} onTab={setTab} />
          </div>
        </header>
        <nav
          className="flex xl:hidden border-b border-line bg-panel p-2 gap-2 overflow-x-auto"
          aria-label="Mobile navigation"
        >
          {[
            ...navItems.map(([id, , , mobile]) => [id, mobile]),
            ["prompts", "Prompts"],
            ["settings", "Credentials"],
            ["dashboard", "Dashboard"],
          ].map(([id, label]) => (

              <button
                key={id}
                onClick={() => setTab(id)}
                className={`nav-btn ${navActive(id) ? "bg-elevated" : ""} ${id === "prompts" || id === "settings" || id === "dashboard" ? `cfg-btn-mobile cfg-${id}` : ""}`}
              >
                {label}
              </button>
            ))}
        </nav>
        {error && (
          <div
            role="alert"
            className="m-4 error-box flex items-start justify-between gap-4"
          >
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {pollError && (
          <p role="status" className="m-4 text-amber text-sm">
            {pollError}
          </p>
        )}
        {loading ? (
          <BrandLoader size="lg" label="Loading QuCoRe" className="py-24" />
        ) : !settings ? (
          <div className="p-12 text-center">
            <p className="text-muted mb-5">
              Start the FastAPI backend to load QuCoRe.
            </p>
            <button className="btn mx-auto" onClick={initialize}>
              Retry connection
            </button>
          </div>
        ) : (
          <>
            {!showHome && (
              <PanelToggles
                panels={panels}
                left={tab !== "prompts" && tab !== "settings" && tab !== "dashboard"}
                right={tab === "qa" || modeRail}
              />
            )}
            {showHome && (
              <HomePage
                tabs={ui.tabs}
                samples={ui.sample_repos || []}
                workspace={workspace}
                onWorkspace={adoptWorkspace}
                onError={setError}
                onOpen={setTab}
              />
            )}
            {/* the tools stay mounted (hidden) behind the home page, so running work survives */}
            <div className={modeRail ? "hk-shell" : ""} hidden={showHome}>
              <div className={modeRail ? "hk-shell-main" : ""}>
                {tab === "prompts" && (
                  <PromptLibrary
                    prompts={prompts}
                    setPrompts={setPrompts}
                    selectedId={promptId}
                    onSelect={setPromptId}
                    onReview={() => setTab("review")}
                  />
                )}
                {tab === "settings" && (
                  <SettingsPanel settings={settings} onSaved={setSettings} />
                )}
                {tab === "dashboard" && <Dashboard onError={setError} />}
                {/* Kept mounted while hidden so a running analysis and its results survive tab switches. */}
                <div hidden={tab !== "sonar"}>
                  <SonarFixes
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                  />
                </div>
                {/* Code Q&A stays mounted so a streaming answer survives tab switches. */}
                <div hidden={tab !== "qa"}>
                  <CodeQA
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                  />
                </div>
                {/* Solidify stays mounted so a running review and its report survive tab switches. */}
                <div hidden={tab !== "solid"}>
                  <Solidify
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                    onOpenUml={openUml}
                  />
                </div>
                {/* QuScan stays mounted so a running scan and its report survive tab switches. */}
                <div hidden={tab !== "quscan"}>
                  <QuScan
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                  />
                </div>
                {/* QuCoder stays mounted so a streaming answer survives tab switches. */}
                <div hidden={tab !== "coder"}>
                  <QuCoder
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                    seed={coderSeed}
                    onSeedUsed={() => setCoderSeed(null)}
                  />
                </div>
                <div hidden={tab !== "flow"}>
                  {/* QuFlow: the Flow map / UML diagrams switch sits in QuFlow's own heading */}
                  <FlowMap
                    workspace={workspace}
                    onWorkspace={adoptWorkspace}
                    settings={settings}
                    light={light}
                    onError={setError}
                    onConfigure={() => setTab("settings")}
                    view={flowView}
                    onViewChange={setFlowView}
                    umlOpen={umlOpen}
                  />
                </div>
                {tab === "review" && (
                  <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)] min-h-[calc(100vh-76px)]">
                    <aside className="bg-panel border-r border-line flex flex-col min-w-0">
                      <div className="p-5 border-b border-line">
                        <p className="eyebrow mb-3">01 / Codebase</p>
                        <form onSubmit={openFolder} className="space-y-3">
                            <label className="sr-only" htmlFor="codebase-path">
                              Absolute local codebase path
                            </label>
                            <div className="flex gap-2">
                              <input
                                id="codebase-path"
                                className="input font-mono text-xs"
                                placeholder="Absolute path, or Browse…"
                                value={rootInput}
                                onChange={(e) => setRootInput(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn shrink-0"
                                onClick={browseFolder}
                                disabled={browsing || opening}
                                title="Choose a folder in Windows Explorer"
                              >
                                {browsing ? (
                                  <LoaderCircle
                                    size={15}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <FolderSearch size={15} />
                                )}
                                Browse
                              </button>
                            </div>
                            <button
                              className="btn w-full"
                              disabled={opening || !rootInput.trim()}
                            >
                              {opening ? (
                                <LoaderCircle
                                  size={15}
                                  className="animate-spin"
                                />
                              ) : (
                                <FolderOpen size={15} />
                              )}
                              {opening ? "Scanning…" : "Open folder"}
                            </button>
                          </form>
                        <p className="field-help">
                          A folder on the machine running FastAPI.
                        </p>
                        <GithubImport
                          workspace={workspace}
                          onWorkspace={adoptWorkspace}
                          onError={setError}
                          disabled={opening}
                        />
                      </div>
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
                              <span className="pill">
                                {selected.size} selected
                              </span>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-muted mt-3">
                              <Checkbox
                                checked={
                                  files.length > 0 &&
                                  selected.size === files.length
                                }
                                mixed={
                                  selected.size > 0 &&
                                  selected.size < files.length
                                }
                                disabled={!files.length}
                                onChange={() =>
                                  selectPaths(
                                    files,
                                    selected.size !== files.length,
                                  )
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
                              activePath={preview?.path}
                              onOpen={openFile}
                            />
                          </div>
                          <p className="px-5 py-3 text-[11px] text-muted border-t border-line">
                            Dependencies, build folders, links, common
                            credential files, binary files, and files above 8
                            MiB are excluded. The .git directory is included;
                            binary Git objects remain visible but cannot be
                            selected. Gitignore rules are not applied.
                          </p>
                        </>
                      ) : (
                        <div className="px-6 py-12 text-center text-muted">
                          <FolderOpen
                            size={25}
                            className="mx-auto mb-4 opacity-60"
                          />
                          <p className="text-sm">
                            Open a folder to select code.
                          </p>
                          <p className="text-xs mt-2">
                            Folder checkboxes include all eligible files inside.
                          </p>
                        </div>
                      )}
                      <div className="p-5 border-t border-line mt-auto">
                        <h2 className="eyebrow flex gap-2 items-center mb-4">
                          <History size={13} />
                          Recent reviews
                        </h2>
                        <div className="space-y-1 max-h-72 overflow-y-auto">
                          {jobs.map((job) => (
                            <button
                              key={job.id}
                              onClick={() => showReport(job.id)}
                              className={`w-full text-left p-3 rounded-lg hover:bg-elevated ${review?.id === job.id ? "bg-elevated" : ""}`}
                            >
                              <div className="flex gap-2 items-center">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${job.status === "completed" ? "bg-added" : ["failed", "cancelled"].includes(job.status) ? "bg-removed" : "bg-amber animate-pulse"}`}
                                />
                                <span className="truncate text-xs font-medium">
                                  {job.title}
                                </span>
                              </div>
                              <div className="flex justify-between text-[10px] text-muted mt-1 pl-3.5">
                                <span>
                                  {new Date(
                                    job.created_at,
                                  ).toLocaleDateString()}{" "}
                                  · {job.file_count} files
                                </span>
                                <span>{job.status}</span>
                              </div>
                              {job.metrics?.cost && (
                                <p className="text-[10px] text-muted mt-1 pl-3.5">
                                  {Number(
                                    job.metrics.lines_reviewed || 0,
                                  ).toLocaleString()}{" "}
                                  lines ·{" "}
                                  {Number(
                                    job.metrics.usage?.total_tokens || 0,
                                  ).toLocaleString()}{" "}
                                  tokens ·{" "}
                                  {money(
                                    job.metrics.cost.total_usd ??
                                      job.metrics.cost.known_subtotal_usd,
                                  )}
                                  {!job.metrics.cost.complete
                                    ? " subtotal"
                                    : ""}
                                </p>
                              )}
                            </button>
                          ))}
                          {!jobs.length && (
                            <p className="text-xs text-muted">
                              Completed reports will be saved here.
                            </p>
                          )}
                        </div>
                      </div>
                    </aside>
                    <main className="@container p-5 lg:p-8 xl:p-10 min-w-0 max-w-[1500px] w-full mx-auto">
                      <div className="flex justify-between items-start mb-7">
                        <div>
                          <p className="eyebrow">
                            Focused feedback. Clear next steps.
                          </p>
                          <TabTitle
                            icon={FileSearch}
                            name="QuCodRev"
                            tone="blue"
                          />
                          <p className="text-sm text-muted mt-2">
                            Your code. Your criteria. A report you can act on.
                          </p>
                        </div>
                        <span className="pill hidden xl:flex">
                          Nebius Token Factory
                        </span>
                      </div>
                      <section className="card p-5 mb-6">
                        <div className="flex items-center justify-between mb-3">
                          <label htmlFor="selected-prompt" className="eyebrow">
                            02 / Review prompt
                          </label>
                          <button
                            onClick={() => setTab("prompts")}
                            className="text-xs text-sky-400 flex items-center gap-1"
                          >
                            Manage prompts
                            <ChevronRight size={13} />
                          </button>
                        </div>
                        <div className="flex flex-col xl:flex-row gap-3">
                          <select
                            id="selected-prompt"
                            className="input flex-1"
                            value={promptId}
                            onChange={(e) => setPromptId(e.target.value)}
                          >
                            <option value="" disabled>
                              Select one saved prompt
                            </option>
                            {prompts.map((prompt) => (
                              <option value={prompt.id} key={prompt.id}>
                                {prompt.name}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn-primary min-w-40"
                            disabled={runStop.stopping || (!busy && !canRun)}
                            onClick={busy ? runStop.stop : run}
                          >
                            {busy ? <Square size={16} /> : <Play size={15} />}
                            {runStop.stopping
                              ? "Stopping…"
                              : busy
                                ? "Stop"
                                : "Run review"}
                          </button>
                        </div>
                        {/* {activePrompt && (
                    <p
                      className="text-xs leading-6 text-muted mt-3 line-clamp-3 wrap-break-word"
                      title={activePrompt.content}
                    >
                      {activePrompt.content}
                    </p>
                  )} */}
                        <div className="flex flex-wrap justify-between items-center gap-3 border-t border-line pt-4 mt-4">
                          <label className="text-xs text-muted flex gap-2 items-center">
                            <input
                              type="checkbox"
                              checked={embeddings}
                              onChange={(e) => setEmbeddings(e.target.checked)}
                            />
                            Semantic ordering with embeddings
                          </label>
                          <span className="text-xs text-muted">
                            {selected.size} files · 1 prompt · PDF + JSON
                          </span>
                        </div>
                        {embeddings && !settings.embedding_deployment && (
                          <p className="text-xs text-amber mt-3">
                            Add a Nebius embedding model in Credentials before
                            running.
                          </p>
                        )}
                        {!settings.configured && (
                          <button
                            className="text-xs text-amber mt-3 flex items-center gap-2"
                            onClick={() => setTab("settings")}
                          >
                            <KeyRound size={13} />
                            Add your Nebius API key and model in Credentials.
                          </button>
                        )}
                        <SelectionMetrics
                          plan={selectionPlan}
                          busy={planBusy}
                          error={planError}
                          count={selected.size}
                          onRefresh={() => setPlanVersion((value) => value + 1)}
                        />
                        <p className="text-[11px] text-muted mt-3">
                          Run review sends the selected source and prompt to{" "}
                          {settings.configured
                            ? `${settings.active_deployment} (${settings.active?.label})`
                            : "your configured deployment"}
                          .
                        </p>
                      </section>
                      {preview && (
                        <section className="card mb-6 overflow-hidden">
                          <div className="flex justify-between items-center gap-3 px-5 py-3 border-b border-line">
                            <span
                              className="font-mono text-xs truncate"
                              title={preview.path}
                            >
                              {preview.path}
                            </span>
                            <button
                              aria-label="Close source preview"
                              className="text-muted"
                              onClick={() => {
                                previewRequest.current?.abort();
                                setPreview(null);
                                setPreviewBusy(false);
                              }}
                            >
                              <X size={16} />
                            </button>
                          </div>
                          <pre className="source-preview">
                            {previewBusy
                              ? "Loading source…"
                              : preview.content
                                  .split(/\r\n|\n|\r/)
                                  .map(
                                    (line, i) =>
                                      `${String(i + 1).padStart(4, " ")}  ${line}`,
                                  )
                                  .join("\n")}
                          </pre>
                        </section>
                      )}
                      <ReportView key={review?.id || "empty"} review={review} />
                    </main>
                  </div>
                )}
              </div>
              {modeRail && (
                <ModeRail
                  eyebrow="Modes"
                  title="QuReview"
                  modes={REVIEW_MODES}
                  value={tab}
                  onChange={setTab}
                />
              )}
            </div>
          </>
        )}
      </div>
    </ChangesProvider>
  );
}

// Header card (where the account menu used to be): the open models and services behind QuCoRe.
function PoweredBy() {
  return (
    <div
      className="powered-card"
      role="note"
      aria-label="Powered by NVIDIA, Nebius and Tavily"
      title="NVIDIA Nemotron models on Nebius Token Factory · Tavily search for QuScan"
    >
      <span className="powered-eyebrow">Powered by</span>
      <span className="powered-names">
        <span className="powered-item">
          <i className="powered-dot powered-nvidia" />
          NVIDIA
        </span>
        <span className="powered-item">
          <i className="powered-dot powered-nebius" />
          Nebius
        </span>
        <span className="powered-item">
          <i className="powered-dot powered-tavily" />
          Tavily
        </span>
      </span>
    </div>
  );
}

// Header button: opens the history of every change that was saved, applied or reverted.
function ChangesButton() {
  const { count, openHistory } = useChanges();
  return (
    <button
      type="button"
      className="chg-open"
      onClick={openHistory}
      title="Changes: saved, applied and reverted code changes"
      aria-label="Open the change history"
    >
      <GitCommitHorizontal size={16} />
      {count > 0 && <span className="chg-open-badge">{count}</span>}
    </button>
  );
}
