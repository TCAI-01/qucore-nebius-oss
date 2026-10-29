import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpenCheck, Bug, CircleHelp, Code2, FileSearch, LayoutDashboard, MessagesSquare, PlayCircle, ShieldAlert, ShieldCheck, Workflow } from 'lucide-react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './AppTour.css'

// Guided tours (driver.js).
//  - "Overview" starts by itself the first time the app opens in this browser, on the home page.
//  - Each tool has its own tour (QuCodRev, QuSonar, QuSolids, QuFlow, QuCoder, QuBot, QuScan). It starts by itself the
//    first time that tool is opened, and any tour can be replayed from the "?" menu in the header.
// Done tours are remembered in this browser. Steps point at what is on screen; a step whose element is not there
// (narrow window, a tool turned off) is skipped.

const SAMPLE_PDF = '/demo/qucore-sample-review.pdf'

const ICONS = {  // lucide paths for the popover badge
  wave: '<path d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 1 1 3 0m-3 6a1.5 1.5 0 0 0-3 0v2a7.5 7.5 0 0 0 15 0v-5a1.5 1.5 0 0 0-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 0 1 3 0v1m0 0V11m0-5.5a1.5 1.5 0 0 1 3 0v3m0 0V11"/>',
  review: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="m13.3 16.3 1.7 1.7"/>',
  bug: '<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  solid: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  flow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  repo: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  nav: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  folder: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  modes: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  chip: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  pdf: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8M16 13H8M16 17H8"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  play: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z"/>',
  flask: '<path d="M10 2v7.31M14 9.3V1.99M8.5 2h7M14 9.3a6.5 6.5 0 1 1-4 0M5.52 16h12.96"/>',
  list: '<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
}

// ---- element finders: always the first VISIBLE match (inactive tools stay mounted but hidden) ----
const seen = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
const pick = selector => () => [...document.querySelectorAll(selector)].find(seen)
const nth = (selector, i) => () => [...document.querySelectorAll(selector)].filter(seen)[i]
// A visible element whose text starts with `text`, then `up` parents higher (or its `closest` ancestor).
const byText = (selector, text, { up = 0, closest } = {}) => () => {
  const want = text.toLowerCase()
  let el = [...document.querySelectorAll(selector)].find(e => seen(e) && e.textContent.trim().toLowerCase().startsWith(want))
  if (!el) return undefined
  if (closest) return el.closest(closest) || el
  for (let i = 0; i < up && el.parentElement; i += 1) el = el.parentElement
  return el
}
const eyebrow = (text, opts) => byText('.eyebrow', text, opts)
// The block right after a heading (e.g. the options under "02 / Focus areas").
const after = (selector, text) => () => byText(selector, text)()?.nextElementSibling || undefined
const composer = pick('.qa-composer')
const suggestions = () => pick('.qa-suggestion')()?.parentElement || undefined

const link = (href, label, download) => `<a class="qt-link" href="${href}" target="_blank" rel="noopener"${download ? ' download' : ''}>${label}</a>`

const step = (element, section, icon, title, description, o = {}) => ({
  element, data: { section, icon, tab: o.tab, menu: o.menu },
  popover: { title, description, side: o.side || 'bottom', align: o.align || 'center' },
  ...(o.wait ? { waitForElement: o.wait } : {}),
})
const intro = (section, icon, title, description, tab) => ({ data: { section, icon, tab }, popover: { title, description } })

// ---------------------------------------------------------------- chapters ----
const TOOL_TEXT = {
  QuReview: ['Four reviews of one codebase: QuCodRev (prompt-driven review with a PDF report), QuSonar (SonarQube fixes), QuSolids (SOLID and design) and QuFlow (flow maps and UML).', 'review'],
  QuCoder: ['A coding assistant that works on your folder. Describe a change, review the diff line by line, then apply or revert it.', 'code'],
  QuBot: ['Ask anything about the codebase. Answers stream in and cite the exact files and lines they use.', 'chat'],
  QuScan: ["Your dependencies checked against today's CVEs, malicious releases and security news, with live Tavily web search.", 'shield'],
}
const MODES = {
  QuCodRev: ['review', 'Prompt-driven review: pick files and a prompt, QuCoRe reviews them on Nemotron and writes a report with ratings, evidence and fixes. Download it as PDF or JSON.'],
  QuSonar: ['bug', 'Upload a SonarQube export (Excel/CSV). Every issue is explained in plain words and fixed in place; you review each fix as a diff before it touches the file.'],
  QuSolids: ['solid', 'Design review: SOLID, object-oriented design, patterns, HLD and LLD. You get scores, charts and findings, with optional runnable sandbox demos and UML.'],
  QuFlow: ['flow', 'Draws how your code flows from input to output, plus UML class and sequence diagrams (Mermaid or React Flow).'],
}

function overview() {
  const cols = [...document.querySelectorAll('.home-col')].filter(seen)
  return [
    intro('Welcome', 'wave', 'Welcome to QuCoRe',
      'Quick Code Review on NVIDIA Nemotron via Nebius Token Factory. A short look at the tools and where everything lives; every tool also has its own detailed tour. Use the arrow keys or the buttons, Esc closes.', 'home'),
    ...cols.map((col, i) => {
      const name = col.querySelector('h2')?.textContent?.trim() || ''
      const [text, icon] = TOOL_TEXT[name] || [col.querySelector('.home-tag')?.textContent || '', 'review']
      return step(nth('.home-col', i), `Tool ${i + 1} of ${cols.length}`, icon, name, text, { tab: 'home' })
    }),
    step(pick('.home-samples'), 'Get started', 'repo', 'Try a sample', 'No code at hand? Open a sample repository in one click and try any tool on it.', { tab: 'home' }),
    step(pick('[data-tour="nav"]'), 'Header', 'nav', 'Switch tools', 'QuReview, QuCoder, QuBot and QuScan, one click away from any page.', { tab: 'home' }),
    step(pick('[data-tour="changes"]'), 'Header', 'history', 'Change history', 'Every change a tool proposes (QuSonar fixes, QuCoder edits) is kept here: review the diff, apply it to your folder or revert it.', { tab: 'home', align: 'end' }),
    step(pick('.cfg-group'), 'Header', 'book', 'Prompts, Credentials and Dashboard', 'Prompts: your own review prompts and quality checks for QuCodRev. Credentials: the Nebius model and key, Tavily, and the code sandbox project ID. Dashboard: your runs, tokens and cost per tool.', { tab: 'home', align: 'end' }),
    step(pick('[data-tour="model"]'), 'Header', 'chip', 'Model', 'The Nemotron model the tools run on (Nebius Token Factory).', { tab: 'home', align: 'end' }),
    step(pick('[data-tour="tour"]'), 'Help', 'help', 'Tours', 'Replay this overview or the tour of any tool from here.', { tab: 'home', align: 'end' }),
    intro('All set', 'rocket', "You're ready",
      'Open a sample or your own folder and pick a tool. The first time you open each tool, a short tour shows how it works.', 'home'),
  ]
}

const codebase = (tab, label = '01 / Codebase') => step(eyebrow(label, { up: 1 }), 'Step 1 · your code', 'folder', 'Open your code',
  'Type the path of a folder on this computer or press Browse, or import a public GitHub repository. Then tick the files to use. Real .env files and keys are never sent to a model.',
  { tab, side: 'right', align: 'start', wait: 1500 })

function reviewChapter() {
  return [
    intro('QuReview · QuCodRev', 'review', 'QuCodRev: prompt-driven code review',
      `Review the files you pick against a prompt you choose and get a structured report. ${link(SAMPLE_PDF, 'Open a sample PDF report')}`, 'review'),
    codebase('review'),
    step(eyebrow('02 / Review prompt', { closest: '.card' }), 'Step 2 · prompt', 'book', 'Choose the review prompt',
      'General, security or performance, or your own prompt from Prompts in the header. Tick "Semantic ordering" to order files by meaning with embeddings. Then press Run review.', { tab: 'review', wait: 800 }),
    step(byText('.eyebrow', 'Selection and batch plan', { up: 2 }), 'Step 3 · plan', 'list', 'Batch plan and cost',
      'Before anything runs you see the lines, estimated tokens, how the files are split into batches and the expected cost.', { tab: 'review' }),
    step(byText('h2', 'Your next review starts here', { closest: '.card' }), 'Step 4 · report', 'pdf', 'Your report',
      `The report appears here: ratings, evidence, impact and fixes per finding, and what is working well. Download it as PDF or JSON. ${link(SAMPLE_PDF, 'See a sample PDF')}`, { tab: 'review', side: 'top' }),
    step(byText('h2', 'Recent reviews', { up: 1 }), 'History', 'history', 'Recent reviews', 'Your past reviews stay here; open one to see its report again.', { tab: 'review', side: 'right' }),
    step(pick('.hk-rail'), 'Modes', 'modes', 'Four modes of QuReview', 'Switch modes here. Each one works on the same opened codebase:', { tab: 'review', side: 'left', align: 'start' }),
    ...Object.entries(MODES).map(([name, [icon, text]], i) =>
      step(nth('.hk-rail-item', i), `Mode ${i + 1} of 4`, icon, name, text, { tab: 'review', side: 'left' })),
    step(pick('.qc-edge-left'), 'Layout', 'panel', 'More room', 'Hide or show the side panels so the middle gets wider.', { tab: 'review', side: 'right' }),
  ]
}

function sonarChapter() {
  return [
    intro('QuReview · QuSonar', 'bug', 'QuSonar: explain and fix SonarQube issues',
      'Bring a SonarQube export and the code it refers to; every issue is explained and fixed. Not using SonarQube? The repository\'s Sonar/ folder has two demo programs and a matching export: open that folder and upload sonarqube_simulated_issues.xlsx.', 'sonar'),
    codebase('sonar'),
    step(eyebrow('02 / SonarQube report', { up: 1 }), 'Step 2 · report', 'upload', 'Upload the SonarQube export',
      'Excel or CSV exported from SonarQube. QuSonar matches every issue to its file and line in the opened folder; you can re-point a file if the paths differ.', { tab: 'sonar', side: 'right' }),
    step(byText('h2', 'Turn SonarQube findings into fixes', { closest: '.card' }), 'Step 3 · fixes', 'code', 'Explanations and fixes',
      'Each issue gets a plain-language explanation and a fix. Review every fix as a diff; applied fixes land in Change history, where you can revert them.', { tab: 'sonar', side: 'top' }),
    step(byText('h2', 'Recent analyses', { up: 1 }), 'History', 'history', 'Recent analyses', 'Past QuSonar runs stay here.', { tab: 'sonar', side: 'right' }),
  ]
}

function solidChapter() {
  return [
    intro('QuReview · QuSolids', 'solid', 'QuSolids: how solid is your design?',
      'A design review against SOLID, object-oriented design, design patterns, architecture (HLD) and low-level design (LLD), with scores, charts and proposed code.', 'solid'),
    codebase('solid'),
    step(after('.eyebrow', '02 / Focus areas'), 'Step 2 · focus', 'sliders', 'Focus areas', 'Choose what to judge: SOLID principles, OOP, design patterns, architecture, low-level design and engineering practices.', { tab: 'solid', wait: 800 }),
    step(after('label', '03 / What matters'), 'Step 3 · context', 'book', 'What matters to you', 'Optional: tell it what the code must cope with (for example new payment providers), so the review weighs the right trade-offs.', { tab: 'solid' }),
    step(byText('label, p, span, b', 'Run proposed code in the sandbox', { closest: 'label, .card, div' }), 'Sandbox', 'play', 'Runnable demos',
      'Tick this to get a runnable demo of the improved design with made-up data. It runs in the Nebius sandbox (Python or Node); you can edit it, reset it or have AI fix it.', { tab: 'solid' }),
    step(byText('p, span, b', 'UML diagrams open in Flow', { up: 2 }), 'Diagrams', 'flow', 'UML renderer', 'UML diagrams from the review open in QuFlow; choose Mermaid, React Flow or both.', { tab: 'solid' }),
    step(eyebrow('04 / Run', { up: 1 }), 'Step 4 · run', 'gauge', 'Estimate and run', 'Lines, tokens and cost before you run, then Run design review.', { tab: 'solid', side: 'left' }),
    step(byText('h2', 'How solid is your design?', { closest: '.card' }), 'Result', 'pdf', 'Scores and findings',
      'A scorecard, scores by area and principle, findings by severity, hotspot files, an HLD overview and proposed code. Download it as a PDF.', { tab: 'solid', side: 'top' }),
  ]
}

function flowChapter() {
  return [
    intro('QuReview · QuFlow', 'flow', 'QuFlow: see how your code flows',
      'Flow maps from input to output, and UML class and sequence diagrams, drawn from the files you pick.', 'flow'),
    codebase('flow'),
    step(after('label', '02 / What to trace'), 'Step 2 · trace', 'sliders', 'What to trace', 'Optional: name a feature or request to follow (for example "checkout"), or leave it empty for the whole selection.', { tab: 'flow', wait: 800 }),
    step(eyebrow('03 / Detail', { up: 1 }), 'Step 3 · detail', 'list', 'Level of detail', 'From a high-level overview to function-by-function steps, then press the run button.', { tab: 'flow', side: 'left' }),
    step(byText('h2', 'Map how your code flows', { closest: '.card' }), 'Result', 'flow', 'The diagram', 'An interactive map you can pan, zoom and export; switch to UML for class and sequence diagrams.', { tab: 'flow', side: 'top' }),
    step(byText('h2', 'Recent flow maps', { up: 1 }), 'History', 'history', 'Recent flow maps', 'Earlier maps stay here.', { tab: 'flow', side: 'right' }),
  ]
}

function coderChapter() {
  return [
    intro('QuCoder', 'code', 'QuCoder: a coding assistant you stay in control of',
      'Describe what you want; the code appears as a diff. Nothing touches a file until you apply it, and every change can be reverted.', 'coder'),
    codebase('coder', '01 / Folder'),
    step(eyebrow('02 / Reference files', { up: 1 }), 'Step 2 · context', 'list', 'Reference files', 'Tick the files QuCoder should read. Fewer, relevant files give better and cheaper answers.', { tab: 'coder', side: 'right' }),
    step(() => byText('button', 'Create something new')()?.parentElement || undefined, 'Ideas', 'rocket', 'Start from an idea', 'Create something new, improve selected code or add a feature: pick a starter or write your own request.', { tab: 'coder', wait: 800 }),
    step(composer, 'Step 3 · ask', 'send', 'Describe the change',
      'Type the request and send. Paste or drop screenshots (Ctrl+V) to show an error or a design. Keep chatting to refine.', { tab: 'coder', side: 'top' }),
    step(byText('button, a, span', 'Change history', {}), 'Step 4 · review', 'history', 'Apply or revert',
      'Proposed changes show as diffs under the answer. Apply the ones you want; all of them are kept in Change history, where you can revert them later.', { tab: 'coder', align: 'end' }),
    step(byText('h2', 'Chats', { up: 1 }), 'History', 'history', 'Chats', 'Every conversation is saved here; start a new one at any time.', { tab: 'coder', side: 'right', align: 'end' }),
  ]
}

function qaChapter() {
  return [
    intro('QuBot', 'chat', 'QuBot: ask your codebase',
      'Questions about the code, answered from the code: each answer cites the files and lines it used, and every reference opens the code.', 'qa'),
    codebase('qa'),
    step(eyebrow('02 / Scope', { up: 1 }), 'Step 2 · scope', 'list', 'Scope', 'Ask about the entire codebase or only the files you select.', { tab: 'qa', side: 'right' }),
    step(eyebrow('03 / Method', { up: 1 }), 'Step 3 · method', 'sliders', 'Retrieval method',
      'Cursor-style (default): a Merkle-synced index of functions and classes; only the best snippets are sent. Under "Advanced" you also find in-prompt (whole files) and hybrid RAG.', { tab: 'qa', side: 'left', wait: 800 }),
    step(eyebrow('04 / Options', { up: 1 }), 'Options', 'history', 'Include history', 'Sends your previous answers with the question so follow-ups keep their context.', { tab: 'qa', side: 'left' }),
    step(byText('summary, button, span, p', 'Before you ask', { closest: 'details, .card, div' }), 'Cost', 'gauge', 'Estimate first', 'Lines, tokens and cost of the question before you ask it.', { tab: 'qa', side: 'left' }),
    step(suggestions, 'Ideas', 'rocket', 'Suggested questions', 'Start with an architecture overview, the main entry point or the riskiest code: one click asks it.', { tab: 'qa' }),
    step(composer, 'Step 4 · ask', 'send', 'Ask', 'Type a question (screenshots welcome) and press Ask. Answers stream in with references you can open.', { tab: 'qa', side: 'top' }),
  ]
}

function quscanChapter() {
  return [
    intro('QuScan', 'shield', 'QuScan: is anything you depend on under attack?',
      "Finds every package your code uses, checks it against the latest CVEs, malicious releases and supply-chain attacks (Tavily web search and OpenCVE) and tells you which version to move to.", 'quscan'),
    codebase('quscan'),
    step(after('.eyebrow', '03 / What to run'), 'Step 2 · what', 'list', 'What to run',
      "Full scan (your packages plus today's threat briefing), Packages only, or a Threat briefing for your stack that needs no folder.", { tab: 'quscan', wait: 800 }),
    step(after('.eyebrow', '04 / Options'), 'Step 3 · options', 'sliders', 'Options',
      'Search depth, results per search, news window, OpenCVE lookups, a supply-chain and malware check, and a deeper crawl for the riskiest packages.', { tab: 'quscan' }),
    step(eyebrow('05 / Run', { up: 1 }), 'Step 4 · run', 'gauge', 'Estimate and run', 'Packages, Tavily credits and model calls before you start.', { tab: 'quscan', side: 'left' }),
    step(byText('button', 'Today', {}), 'Daily', 'bell', 'Daily briefing', 'Set up a daily threat briefing for your stack.', { tab: 'quscan', align: 'end' }),
    step(byText('h2', 'Is anything you depend on under attack?', { closest: '.card' }), 'Result', 'shield', 'The results',
      'Each package with its danger score, CVEs, whether a release was compromised, the safe version to move to, mitigation steps and sources. Export the results.', { tab: 'quscan', side: 'top' }),
  ]
}

export const CHAPTERS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, tab: 'home', build: overview },
  { id: 'review', label: 'QuCodRev', icon: FileSearch, tab: 'review', build: reviewChapter, group: 'review' },
  { id: 'sonar', label: 'QuSonar', icon: Bug, tab: 'sonar', build: sonarChapter, group: 'review' },
  { id: 'solid', label: 'QuSolids', icon: ShieldCheck, tab: 'solid', build: solidChapter, group: 'review' },
  { id: 'flow', label: 'QuFlow', icon: Workflow, tab: 'flow', build: flowChapter, group: 'review' },
  { id: 'coder', label: 'QuCoder', icon: Code2, tab: 'coder', build: coderChapter },
  { id: 'qa', label: 'QuBot', icon: MessagesSquare, tab: 'qa', build: qaChapter },
  { id: 'quscan', label: 'QuScan', icon: ShieldAlert, tab: 'quscan', build: quscanChapter },
]

// auth: who is using the app. Hosted: the signed-in person (AuthGate). Open-source / local app: no sign-in
// ({ authenticated: true, user: null }), so the tours are remembered for this browser.
export default function AppTour({ ready, tab, tabs, onTab, auth = { authenticated: true, user: null } }) {
  const [menu, setMenu] = useState(false)
  const box = useRef(null)
  const tour = useRef(null)
  const started = useRef(new Set())  // chapters started by themselves in this page (StrictMode-safe)
  const tabRef = useRef(tab)
  tabRef.current = tab
  const user = auth?.user
  const allowed = Boolean(auth?.authenticated && (user || !auth?.enabled))
  const keyOf = id => `qucore-tour:${user?.id || 'local'}:${id}`
  const isDone = id => { try { return localStorage.getItem(keyOf(id)) === '1' } catch { return true } }
  const markDone = ids => { try { ids.forEach(id => localStorage.setItem(keyOf(id), '1')) } catch { /* storage off */ } }
  const on = id => {  // a tool turned off with QUCORE_TABS has no tour
    const chapter = CHAPTERS.find(c => c.id === id)
    if (!tabs?.length || id === 'overview') return true
    return tabs.includes(chapter.group || chapter.tab)
  }

  const run = useCallback((ids) => {
    if (tour.current?.isActive()) tour.current.destroy()
    const chapters = CHAPTERS.filter(c => ids.includes(c.id) && on(c.id))
    if (!chapters.length) return
    const back = tabRef.current
    const firstTab = chapters[0].tab
    const begin = () => {
      const steps = chapters.flatMap(c => c.build())
      const go = (d, index) => {
        const next = steps[index]
        if (!next) { d.destroy(); return }
        if (next.data?.tab && next.data.tab !== tabRef.current) onTab(next.data.tab)
        window.dispatchEvent(new CustomEvent('qucore:user-menu', { detail: { open: Boolean(next.data?.menu) } }))
        d.moveTo(index)
      }
      const d = driver({
        steps, showProgress: true, progressText: '{{current}} / {{total}}', popoverClass: 'qucore-tour', allowClose: true,
        overlayColor: '#0a1230', overlayOpacity: 0.6, stagePadding: 6, stageRadius: 12, popoverOffset: 12,
        skipMissingElement: true, smoothScroll: true, disableActiveInteraction: true,
        nextBtnText: 'Next →', prevBtnText: '← Back', doneBtnText: 'Finish',
        onNextClick: (_e, _s, { driver: dr }) => go(dr, (dr.getActiveIndex() ?? -1) + 1),
        onPrevClick: (_e, _s, { driver: dr }) => go(dr, (dr.getActiveIndex() ?? 1) - 1),
        onPopoverRender: (popover, { state }) => {
          const data = state.activeStep?.data || {}
          const index = steps.indexOf(state.activeStep)
          const head = document.createElement('div')
          head.className = 'qt-head'
          head.innerHTML = `<span class="qt-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[data.icon] || ICONS.help}</svg></span><span class="qt-section"></span>`
          head.querySelector('.qt-section').textContent = data.section || 'QuCoRe'
          popover.wrapper.insertBefore(head, popover.title)
          const bar = document.createElement('div')
          bar.className = 'qt-bar'
          bar.innerHTML = `<span style="width:${Math.round(((index + 1) / steps.length) * 100)}%"></span>`
          popover.wrapper.prepend(bar)
          popover.closeButton.setAttribute('title', 'Close the tour')
          if (index === 0) {
            const skip = document.createElement('button')
            skip.type = 'button'; skip.className = 'qt-skip'; skip.textContent = 'Skip'
            skip.onclick = () => d.destroy()
            popover.footerButtons.prepend(skip)
          }
        },
        onDestroyed: () => {
          window.dispatchEvent(new CustomEvent('qucore:user-menu', { detail: { open: false } }))
          markDone(chapters.map(c => c.id))
          if (chapters.length > 1 || chapters[0].id === 'overview') { if (tabRef.current !== back) onTab(back) }
          tour.current = null
        },
      })
      tour.current = d
      d.drive()
    }
    if (tabRef.current !== firstTab) { onTab(firstTab); setTimeout(begin, 500) } else setTimeout(begin, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, onTab, user?.id])

  // First sign-in: the overview on the home page. First visit of a tool: that tool's tour.
  useEffect(() => {
    if (!allowed || !ready || tour.current?.isActive()) return undefined
    const overviewDone = isDone('overview')
    const chapter = !overviewDone ? (tab === 'home' ? CHAPTERS[0] : null)
      : CHAPTERS.find(c => c.tab === tab && c.id !== 'overview' && on(c.id) && !isDone(c.id))
    if (!chapter || started.current.has(chapter.id)) return undefined
    const timer = setTimeout(() => {
      if (tour.current?.isActive() || started.current.has(chapter.id)) return
      if (chapter.id === 'overview' && !seen(document.querySelector('.home-cols'))) return
      started.current.add(chapter.id)
      run([chapter.id])
    }, 900)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, ready, tab, run])

  useEffect(() => {
    if (!menu) return undefined
    const close = e => { if (box.current && !box.current.contains(e.target)) setMenu(false) }
    const escape = e => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [menu])
  useEffect(() => () => { tour.current?.destroy() }, [])

  if (!allowed) return null
  const choose = ids => { setMenu(false); run(ids) }
  const current = CHAPTERS.find(c => c.tab === tab && c.id !== 'overview')
  return <div ref={box} className="relative">
    <button type="button" className="btn-icon" onClick={() => setMenu(!menu)} title="Tours and help" aria-label="Tours and help"
      aria-haspopup="menu" aria-expanded={menu} data-tour="tour">
      <CircleHelp size={17} />
    </button>
    {menu && <div role="menu" className="qt-menu">
      <p className="qt-menu-title">Guided tours</p>
      {current && on(current.id) && <button type="button" role="menuitem" className="qt-menu-item qt-menu-main" onClick={() => choose([current.id])}>
        <PlayCircle size={15} /><span>Tour of this page<small>{current.label}</small></span>
      </button>}
      <button type="button" role="menuitem" className="qt-menu-item" onClick={() => choose(['overview'])}>
        <LayoutDashboard size={15} /><span>Overview<small>The tools and the header</small></span>
      </button>
      <div className="qt-menu-sep" />
      {CHAPTERS.filter(c => c.id !== 'overview' && on(c.id)).map(c => <button key={c.id} type="button" role="menuitem"
        className={`qt-menu-item ${c.group ? 'qt-menu-sub' : ''}`} onClick={() => choose([c.id])}>
        <c.icon size={15} /><span>{c.label}</span>
      </button>)}
      <div className="qt-menu-sep" />
      <button type="button" role="menuitem" className="qt-menu-item" onClick={() => choose(CHAPTERS.map(c => c.id))}>
        <BookOpenCheck size={15} /><span>Full tour<small>Everything, one tool after another</small></span>
      </button>
      <a role="menuitem" className="qt-menu-item" href={SAMPLE_PDF} target="_blank" rel="noopener" onClick={() => setMenu(false)}>
        <FileSearch size={15} /><span>Sample PDF report<small>What a QuCodRev report looks like</small></span>
      </a>
    </div>}
  </div>
}
