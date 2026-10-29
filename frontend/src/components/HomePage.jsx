import { useMemo, useState } from "react";
import { ArrowRight, Check, GitBranch, LoaderCircle } from "lucide-react";
import { api } from "../api.js";
import { INTROS } from "./Hackathon.jsx";
import "./HomePage.css";

// Home page (opened on start): the four tools side by side, each with what it
// does and how to try it. The header logo opens it again. Background: faint code drifting upwards.
const RAIN = [
  "def review(files):",
  "for issue in sonar:",
  "assert fixed(code)",
  "import { scan } from",
  "git diff --stat",
  "SELECT * FROM cves",
  "class Router(Base):",
  "return merkle.root",
  "if risk > 7.5:",
  "npm audit --json",
  "async def ask(q):",
  "patch = apply(edit)",
  "pip install -U",
  "export default App",
  "while not passed:",
  "tokens += usage",
  "yield chunk",
  "const tree = build()",
  "sandbox.run(test)",
  '@app.post("/api")',
];

function CodeRain() {
  const columns = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        left: `${(i * 100) / 16 + 1.5}%`,
        duration: `${80 + ((i * 37) % 60)}s`,
        delay: `-${(i * 53) % 90}s`,
        lines: Array.from(
          { length: 14 },
          (_, j) => RAIN[(i * 7 + j * 3) % RAIN.length],
        ),
      })),
    [],
  );
  return (
    <div className="home-rain" aria-hidden="true">
      {columns.map((c, i) => (
        <pre
          key={i}
          style={{
            left: c.left,
            animationDuration: c.duration,
            animationDelay: c.delay,
          }}
        >
          {c.lines.join("\n\n")}
        </pre>
      ))}
    </div>
  );
}

export default function HomePage({
  tabs,
  samples = [],
  workspace,
  onWorkspace,
  onError,
  onOpen,
}) {
  const [busy, setBusy] = useState("");
  const ids = ["review", "coder", "qa", "quscan"].filter(
    (id) => !tabs?.length || tabs.includes(id),
  );
  async function open(sample) {
    setBusy(sample.repo);
    try {
      onWorkspace(await api.githubWorkspace(sample.repo, sample.ref || ""));
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="home">
      <CodeRain />
      <div className="home-inner">
        <header className="home-head">
          {/* <p className="eyebrow">QuCoRe · Quick Code Review</p> */}
          <h1>One codebase. Four tools.</h1>
          <p>
            Open a repository once, then review it, change it, question it and
            secure it.
          </p>
        </header>
        <div className="home-cols">
          {ids.map((id) => {
            const intro = INTROS[id];
            const Icon = intro.icon;
            return (
              <section
                key={id}
                className="home-col"
                style={{ "--mode": intro.color }}
              >
                <span className="home-icon">
                  <Icon size={22} />
                </span>
                <h2>{intro.name}</h2>
                <p className="home-tag">{intro.tagline}</p>
                <ol className="home-steps">
                  {intro.steps.map(([title, text], i) => (
                    <li key={title}>
                      <b className="home-num">{i + 1}</b>
                      <span>
                        <b>{title}</b>
                        <span>{text}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  className="home-go"
                  onClick={() => onOpen(id)}
                >
                  Open {intro.name}
                  <ArrowRight size={15} />
                </button>
              </section>
            );
          })}
        </div>
        {samples.length > 0 && (
          <div className="home-samples">
            <span className="text-sm text-muted">
              Try it on a sample repository:
            </span>
            {samples.map((sample) => {
              const opened =
                workspace?.source?.repo?.toLowerCase() ===
                sample.repo.toLowerCase();
              return (
                <button
                  key={sample.repo + sample.ref}
                  type="button"
                  className={`hk-sample ${opened ? "home-opened" : ""}`}
                  disabled={Boolean(busy)}
                  onClick={() => open(sample)}
                  title={`github.com/${sample.repo}${sample.ref ? ` @ ${sample.ref}` : ""}`}
                >
                  {busy === sample.repo ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : opened ? (
                    <Check size={14} />
                  ) : (
                    <GitBranch size={14} />
                  )}
                  {sample.label}
                  {sample.ref ? (
                    <span className="text-muted">@{sample.ref}</span>
                  ) : null}
                </button>
              );
            })}
            {workspace && (
              <span className="text-xs text-muted">
                Open: <b className="text-fg">{workspace.name}</b>. Pick a tool
                above.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
