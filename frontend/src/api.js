// Same-origin API. Keys only pass through the settings PUT body; never storage/URLs.
async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.detail
    const message = typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map(item => `${item.field || 'Input'}: ${item.message || 'Invalid value'}`).join('; ')
      : `Request failed (${response.status}). Check that the backend is running.`
    throw new Error(message)
  }
  return data
}
const body = value => JSON.stringify(value)
export const api = {
  dashboard: (scope = 'mine') => request(`/dashboard?scope=${encodeURIComponent(scope)}`),
  pricingStatus: () => request('/pricing'),
  pricingCatalogue: (q = '') => request(`/pricing/catalogue?q=${encodeURIComponent(q)}`),
  pricingRefresh: () => request('/pricing/refresh', { method: 'POST' }),
  settings: () => request('/settings'),
  saveSettings: value => request('/settings', { method: 'PUT', body: body(value) }),
  // Header: pick the Nemotron model on Nebius Token Factory.
  setModel: model => request('/settings/model', { method: 'PUT', body: body({ model }) }),
  prompts: () => request('/prompts'),
  savePrompt: (id, value) => request(`/prompts${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: body(value) }),
  deletePrompt: id => request(`/prompts/${id}`, { method: 'DELETE' }),
  openWorkspace: path => request('/workspaces', { method: 'POST', body: body({ path }) }),
  // A public GitHub repository opened as a workspace (downloaded and unpacked on the server).
  // Reopen this person's last folder or GitHub repository ({ restored: false } when none).
  restoreWorkspace: () => request('/workspaces/restore', { method: 'POST' }),
  githubWorkspace: (url, ref = '', fresh = false) => request('/workspaces/github', { method: 'POST', body: body({ url, ref, fresh }) }),
  // Opens the native (Windows Explorer) folder dialog on the machine running FastAPI.
  pickFolder: initial => request('/system/pick-folder', { method: 'POST', body: body({ initial: initial || '' }) }),
  file: (id, path, signal) => request(`/workspaces/${id}/file?path=${encodeURIComponent(path)}`, { signal }),
  stopReview: id => request(`/reviews/${id}/stop`, { method: 'POST' }),
  sonarStop: id => request(`/sonar/jobs/${id}/stop`, { method: 'POST' }),
  flowStop: id => request(`/flows/${id}/stop`, { method: 'POST' }),
  reviews: () => request('/reviews'),
  review: id => request(`/reviews/${id}`),
  preview: (value, signal) => request('/reviews/preview', { method: 'POST', body: body(value), signal }),
  run: value => request('/reviews', { method: 'POST', body: body(value) }),
  // SonarQube fixes tab
  sonarUpload: (filename, content_base64) => request('/sonar/uploads', { method: 'POST', body: body({ filename, content_base64 }) }),
  sonarResolve: (upload_id, workspace_id) => request('/sonar/resolve', { method: 'POST', body: body({ upload_id, workspace_id }) }),
  sonarRun: value => request('/sonar/jobs', { method: 'POST', body: body(value) }),
  sonarRetry: (id, workspace_id) => request(`/sonar/jobs/${id}/retry`, { method: 'POST', body: body({ workspace_id }) }),
  sonarJobs: () => request('/sonar/jobs'),
  sonarJob: id => request(`/sonar/jobs/${id}`),
  sonarDelete: id => request(`/sonar/jobs/${id}`, { method: 'DELETE' }),
  // Flow map tab
  flowPreview: (value, signal) => request('/flows/preview', { method: 'POST', body: body(value), signal }),
  flowRun: value => request('/flows', { method: 'POST', body: body(value) }),
  flows: () => request('/flows'),
  flow: id => request(`/flows/${id}`),
  flowDelete: id => request(`/flows/${id}`, { method: 'DELETE' }),
  // Code Q&A tab
  qaPreview: (value, signal) => request('/qa/preview', { method: 'POST', body: body(value), signal }),
  qaStop: streamId => request('/qa/stop', { method: 'POST', body: body({ stream_id: streamId }) }),
  qaSessions: () => request('/qa/sessions'),
  qaSession: id => request(`/qa/sessions/${id}`),
  qaDeleteSession: id => request(`/qa/sessions/${id}`, { method: 'DELETE' }),
  qaSnippet: (workspace_id, path, signal) => request('/qa/snippet', { method: 'POST', body: body({ workspace_id, path }), signal }),
  // Solidify tab (design review + sandbox)
  solidPreview: (value, signal) => request('/solidify/preview', { method: 'POST', body: body(value), signal }),
  solidRun: value => request('/solidify/jobs', { method: 'POST', body: body(value) }),
  solidJobs: () => request('/solidify/jobs'),
  solidJob: id => request(`/solidify/jobs/${id}`),
  solidDelete: id => request(`/solidify/jobs/${id}`, { method: 'DELETE' }),
  solidStop: id => request(`/solidify/jobs/${id}/stop`, { method: 'POST' }),
  // runtime: 'python' (Python files) or 'node' (JavaScript / TypeScript files)
  sandboxRun: (code, runtime = 'python') => request('/solidify/sandbox/runs', { method: 'POST', body: body({ code, runtime }) }),
  sandboxGet: id => request(`/solidify/sandbox/runs/${id}`),
  sandboxStop: id => request(`/solidify/sandbox/runs/${id}/stop`, { method: 'POST' }),
  solidDemo: (jobId, findingId) => request(`/solidify/jobs/${jobId}/findings/${findingId}/demo`, { method: 'POST' }),
  // "Fix with AI": rewrite a demo that failed in the sandbox from its code and output
  solidDemoFix: (jobId, findingId, value) => request(`/solidify/jobs/${jobId}/findings/${findingId}/demo/fix`, { method: 'POST', body: body(value) }),
  // QuScan tab (dependency threat intelligence with Tavily)
  quscanCredentials: () => request('/quscan/credentials'),
  quscanSaveCredentials: value => request('/quscan/credentials', { method: 'PUT', body: body(value) }),
  quscanInventory: workspace_id => request('/quscan/inventory', { method: 'POST', body: body({ workspace_id }) }),
  quscanRun: value => request('/quscan/jobs', { method: 'POST', body: body(value) }),
  quscanJobs: () => request('/quscan/jobs'),
  quscanJob: id => request(`/quscan/jobs/${id}`),
  quscanStop: id => request(`/quscan/jobs/${id}/stop`, { method: 'POST' }),
  quscanDelete: id => request(`/quscan/jobs/${id}`, { method: 'DELETE' }),
  // UML diagrams (drawn from Solidify, shown in the Flow tab)
  umlRun: value => request('/uml/jobs', { method: 'POST', body: body(value) }),
  umlJobs: () => request('/uml/jobs'),
  umlJob: id => request(`/uml/jobs/${id}`),
  umlStop: id => request(`/uml/jobs/${id}/stop`, { method: 'POST' }),
  umlDelete: id => request(`/uml/jobs/${id}`, { method: 'DELETE' }),
  // Code changes: Monaco review, save, replace, revert
  changeDraft: value => request('/changes/draft', { method: 'POST', body: body(value) }),
  changeSave: value => request('/changes', { method: 'POST', body: body(value) }),
  changeUpdate: (id, content) => request(`/changes/${id}`, { method: 'PUT', body: body({ content }) }),
  changeGet: id => request(`/changes/${id}`),
  changesList: (params = {}) => request(`/changes${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`),
  changeReplace: (id, force = false) => request(`/changes/${id}/replace`, { method: 'POST', body: body({ force }) }),
  changeRevert: (id, force = false) => request(`/changes/${id}/revert`, { method: 'POST', body: body({ force }) }),
  changeDelete: id => request(`/changes/${id}`, { method: 'DELETE' }),
  // QuCoder
  qucoderPreview: (value, signal) => request('/qucoder/preview', { method: 'POST', body: body(value), signal }),
  qucoderStop: streamId => request('/qucoder/stop', { method: 'POST', body: body({ stream_id: streamId }) }),
  qucoderSessions: () => request('/qucoder/sessions'),
  qucoderSession: id => request(`/qucoder/sessions/${id}`),
  qucoderDeleteSession: id => request(`/qucoder/sessions/${id}`, { method: 'DELETE' }),
}

// Code Q&A answer stream (Server-Sent Events over a POST). Calls onEvent(event, data)
// for meta / status / context / delta / usage / done / error events.
export async function qaAsk(value, onEvent, signal) {
  const response = await fetch('/api/qa/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(value), signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map(item => `${item.field || 'Input'}: ${item.message || 'Invalid value'}`).join('; ')
      : `Request failed (${response.status}). Check that the backend is running.`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const dispatch = raw => {
    let event = 'message'
    let data = ''
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) onEvent(event, JSON.parse(data))
  }
  for (;;) {
    const { value: chunk, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      dispatch(raw)
    }
  }
  if (buffer.trim()) dispatch(buffer)
}
// QuCoder answer stream (same Server-Sent Events reader as Code Q&A).
export async function qucoderAsk(value, onEvent, signal) {
  const response = await fetch('/api/qucoder/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(value), signal })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map(item => `${item.field || 'Input'}: ${item.message || 'Invalid value'}`).join('; ')
      : `Request failed (${response.status}). Check that the backend is running.`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const dispatch = raw => {
    let event = 'message'
    let data = ''
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) onEvent(event, JSON.parse(data))
  }
  for (;;) {
    const { value: chunk, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) { const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2); dispatch(raw) }
  }
  if (buffer.trim()) dispatch(buffer)
}
export const downloadUrl = (id, type) => `/api/reviews/${id}/download/${type}`
export const sonarDownloadUrl = (id, type) => `/api/sonar/jobs/${id}/download/${type}`
export const solidDownloadUrl = (id, type) => `/api/solidify/jobs/${id}/download/${type}`
export const quscanDownloadUrl = (id, type) => `/api/quscan/jobs/${id}/download/${type}`
