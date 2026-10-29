import { useState } from 'react'
import { Code2, FileSearch, GitBranch, LoaderCircle, MessagesSquare, ShieldAlert, Sparkles } from 'lucide-react'
import { api } from '../api.js'
import './Hackathon.css'

// Layout helpers: the right-hand mode panel of a merged tab (ModeRail; ModeBar is the older top switch),
// the "Start here" panel and the tool intros used by the home page.

export function ModeBar({ label, modes, value, onChange }) {
  return <div className="hk-modebar" role="tablist" aria-label={label}>
    {modes.map(([id, Icon, text, hint]) => <button key={id} type="button" role="tab" aria-selected={value === id}
      className={value === id ? 'on' : ''} onClick={() => onChange(id)} title={hint}>
      <Icon size={14} />{text}
    </button>)}
  </div>
}

// Right-hand panel listing the modes of a merged tab, one row each, each in its own colour.
// modes: [id, Icon, title, hint, colour]
export function ModeRail({ eyebrow, title, modes, value, onChange }) {
  return <aside className="hk-rail bg-panel" aria-label={`${title} modes`}>
    <p className="eyebrow">{eyebrow}</p>
    <h2 className="hk-rail-title">{title}</h2>
    <div className="hk-rail-list" role="tablist" aria-orientation="vertical" aria-label={`${title} modes`}>
      {modes.map(([id, Icon, text, hint, color]) => <button key={id} type="button" role="tab" aria-selected={value === id}
        className={`hk-rail-item ${value === id ? 'on' : ''}`} style={{ '--mode': color }} onClick={() => onChange(id)} title={hint}>
        <span className="hk-rail-icon"><Icon size={16} /></span>
        <span className="min-w-0"><b>{text}</b><span>{hint}</span></span>
      </button>)}
    </div>
  </aside>
}

const TOOLS = [
  ['review', FileSearch, 'QuReview', 'Review code, fix SonarQube issues, check design, map architecture'],
  ['coder', Code2, 'QuCoder', 'Chat with a coding assistant; review, apply and revert its changes'],
  ['qa', MessagesSquare, 'QuBot', 'Ask questions about the codebase, answered with file and line references'],
  ['quscan', ShieldAlert, 'QuScan', "Check your dependencies against today's CVEs and threat news"],
]

export function StartHere({ samples, tabs, onWorkspace, onError, onGo }) {
  const [busy, setBusy] = useState('')
  async function open(sample) {
    setBusy(sample.repo)
    try { onWorkspace(await api.githubWorkspace(sample.repo, sample.ref || '')) }
    catch (err) { onError(err.message) }
    finally { setBusy('') }
  }
  const tools = TOOLS.filter(([id]) => !tabs?.length || tabs.includes(id))
  return <section className="hk-start">
    <div className="hk-start-head">
      <span className="hk-start-badge"><Sparkles size={16} /></span>
      <div>
        <p className="eyebrow">Start here</p>
        <h2 className="text-lg font-semibold">Open a codebase, then pick a tool</h2>
      </div>
    </div>
    <div className="hk-start-grid">
      <div>
        <p className="hk-start-step"><b>1</b>{samples.length ? 'Try a sample repository in one click' : 'Open a folder or import a public GitHub repository'}</p>
        {samples.length > 0 && <div className="flex flex-wrap gap-2 mt-3">
          {samples.map(sample => <button key={sample.repo + sample.ref} type="button" className="hk-sample" disabled={Boolean(busy)}
            onClick={() => open(sample)} title={`github.com/${sample.repo}${sample.ref ? ` @ ${sample.ref}` : ''}`}>
            {busy === sample.repo ? <LoaderCircle size={14} className="animate-spin" /> : <GitBranch size={14} />}
            {sample.label}{sample.ref ? <span className="text-muted">@{sample.ref}</span> : null}
          </button>)}
        </div>}
        <p className="field-help">{samples.length ? 'Or use the codebase panel on the left for your own folder or repository.' : 'Use the codebase panel on the left.'}</p>
      </div>
      <div>
        <p className="hk-start-step"><b>2</b>Pick a tool</p>
        <div className="hk-tools">
          {tools.map(([id, Icon, name, text]) => <button key={id} type="button" className="hk-tool" onClick={() => onGo(id)}>
            <span className="hk-tool-icon"><Icon size={15} /></span>
            <span className="min-w-0"><b>{name}</b><span>{text}</span></span>
          </button>)}
        </div>
      </div>
    </div>
  </section>
}

// Intro page of each main tab: what the tool does, how to try it, and a
// "Get started" button that opens the usual screen. Shown until the person presses Get started
// (remembered per user in this browser).
export const INTROS = {
  review: {
    icon: FileSearch, name: 'QuReview', color: '56 189 248',
    tagline: 'Four reviews of one codebase, side by side.',
    steps: [
      ['Open a codebase', 'Import a public GitHub repository, open a folder, or try a sample below.'],
      ['Pick a mode on the right', 'QuCodRev (prompt-driven review and PDF report), QuSonar (SonarQube fixes), QuSolids (SOLID and design review with sandbox demos) or QuFlow (flow maps and UML).'],
      ['Select files and run', 'Every finding comes with the fix; proposed code changes land in the change history.'],
    ],
  },
  coder: {
    icon: Code2, name: 'QuCoder', color: '13 148 136',
    tagline: 'A coding assistant whose changes you review before they touch a file.',
    steps: [
      ['Open a codebase', 'Import a public GitHub repository, open a folder, or try a sample below.'],
      ['Tick the files and describe the change', 'Ask for a fix, a feature or a refactor in plain words, and keep chatting to refine it.'],
      ['Review, apply or revert', 'Every change opens as a diff in the change history: apply it to the folder or revert it later.'],
    ],
  },
  qa: {
    icon: MessagesSquare, name: 'QuBot', color: '139 92 246',
    tagline: 'Ask anything about the codebase; every answer cites files and lines.',
    steps: [
      ['Open a codebase', 'Import a public GitHub repository, open a folder, or try a sample below.'],
      ['Choose the scope', 'The whole codebase or the files you tick. Cursor-style Merkle retrieval is the default method.'],
      ['Ask', 'Answers stream in; every reference opens the exact lines of code.'],
    ],
  },
  quscan: {
    icon: ShieldAlert, name: 'QuScan', color: '239 68 68',
    tagline: "Your dependencies checked against today's CVEs, malicious releases and threat news.",
    steps: [
      ['Open a codebase', 'Import a public GitHub repository, open a folder, or try a sample below. QuScan reads requirements, pyproject, lock files and package.json.'],
      ['Pick what to run', 'Full scan, Packages only, or a Threat briefing for your stack (needs a Tavily key).'],
      ['Act on the report', 'Each package shows its CVEs, whether it is compromised, and the safe version to move to.'],
    ],
  },
}

export function TabIntro({ id, samples = [], onWorkspace, onError, onStart }) {
  const [busy, setBusy] = useState('')
  const intro = INTROS[id] || INTROS.review
  const Icon = intro.icon
  async function open(sample) {
    setBusy(sample.repo)
    try { onWorkspace(await api.githubWorkspace(sample.repo, sample.ref || '')); onStart() }
    catch (err) { onError(err.message) }
    finally { setBusy('') }
  }
  return <section className="hk-intro" style={{ '--mode': intro.color }} aria-labelledby="hk-intro-title">
    <div className="hk-intro-card">
      <span className="hk-intro-icon"><Icon size={26} /></span>
      <p className="eyebrow mt-5">How it works</p>
      <h1 id="hk-intro-title" className="hk-intro-title">{intro.name}</h1>
      <p className="hk-intro-tagline">{intro.tagline}</p>
      <ol className="hk-intro-steps">
        {intro.steps.map(([title, text], i) => <li key={title}>
          <b className="hk-intro-num">{i + 1}</b>
          <span><b>{title}</b><span>{text}</span></span>
        </li>)}
      </ol>
      {samples.length > 0 && <div className="hk-intro-samples">
        <span className="text-xs text-muted">Try it on a sample:</span>
        {samples.map(sample => <button key={sample.repo + sample.ref} type="button" className="hk-sample" disabled={Boolean(busy)}
          onClick={() => open(sample)} title={`github.com/${sample.repo}${sample.ref ? ` @ ${sample.ref}` : ''}`}>
          {busy === sample.repo ? <LoaderCircle size={14} className="animate-spin" /> : <GitBranch size={14} />}
          {sample.label}{sample.ref ? <span className="text-muted">@{sample.ref}</span> : null}
        </button>)}
      </div>}
      <button type="button" className="hk-intro-go" onClick={onStart}>Get started</button>
    </div>
  </section>
}
