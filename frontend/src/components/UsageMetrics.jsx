const number = value => Number(value || 0).toLocaleString()
export const money = value => value == null ? 'Not configured' : `$${Number(value).toFixed(6)}`

export default function UsageMetrics({ metrics }) {
  if (!metrics) return null
  const usage = metrics.usage || {}
  const selection = metrics.selection || {}
  const cost = metrics.cost || {}
  return <section className="card p-5 mb-5" aria-label="Run usage and cost">
    <div className="flex flex-wrap justify-between items-center gap-2 mb-4"><h3 className="section-title">Run usage</h3><span className="text-xs text-muted">{metrics.batches_completed || 0} / {selection.batch_count || 0} batches reviewed</span></div>
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{[
      ['Lines reviewed', `${number(metrics.lines_reviewed)} / ${number(selection.lines)}`],
      ['Reported input tokens', number(usage.input_tokens)],
      ['Reported output tokens', number(usage.output_tokens)],
      [cost.complete ? 'Cost from reported usage' : 'Known cost subtotal', money(cost.complete ? cost.total_usd : cost.known_subtotal_usd)],
    ].map(([label, value]) => <div key={label} className="rounded-lg bg-elevated/60 p-3"><div className="text-[11px] text-muted">{label}</div><div className="text-lg font-semibold mt-1 wrap-break-word">{value}</div></div>)}</div>
    <div className="text-xs text-muted mt-3 space-y-1">
      <p>{number(metrics.files_reviewed)} / {number(selection.file_count)} files reviewed · {number(usage.requests)} LLM calls · {number(usage.total_tokens)} reported LLM tokens total.</p>
      <p>Input: {money(cost.input_usd)} · Output: {money(cost.output_usd)} · Rates per million: {money(cost.rates?.input_per_million)} input / {money(cost.rates?.output_per_million)} output.</p>
      {(usage.embedding_requests > 0 || usage.embedding_tokens > 0) && <p>Embeddings: {number(usage.embedding_tokens)} tokens · {cost.embedding_usd == null ? 'cost excluded; set embedding price in .env' : money(cost.embedding_usd)}.</p>}
      {!cost.complete && <p className="text-amber">Cost is incomplete: some usage or applicable pricing is unavailable.</p>}
      <p>Includes returned usage from review and consolidation calls. An estimate from your rates, not your provider's invoice; cache discounts and unreported retries are not reconciled.</p>
    </div>
  </section>
}
