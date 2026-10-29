import { money } from "./UsageMetrics.jsx";
const fmt = (value) => Number(value || 0).toLocaleString();

export default function SelectionMetrics({
  plan,
  busy,
  error,
  count,
  onRefresh,
}) {
  return (
    <div className="border-t border-line mt-4 pt-4" aria-live="polite">
      <div className="flex justify-between items-center gap-2 mb-3">
        <span className="eyebrow">Selection and batch plan</span>
        <button
          type="button"
          className="btn-small"
          disabled={!count || busy}
          onClick={onRefresh}
        >
          Recalculate
        </button>
      </div>
      {busy ? (
        <p className="text-xs text-muted">
          Counting lines/tokens and packing whole files…
        </p>
      ) : error ? (
        <p className="text-xs text-removed">{error}</p>
      ) : !plan ? (
        <p className="text-xs text-muted">
          Select files to calculate lines, token estimates, batches, and cost.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
            {[
              ["Files", fmt(plan.file_count)],
              ["Selected lines", fmt(plan.lines)],
              [
                "Source tokens (est.)",
                `${fmt(plan.source_tokens)} - ${fmt(Math.round(plan.source_tokens * 1.7))}`,
              ],
              ["Whole-file batches", fmt(plan.batch_count)],
            ].map(([label, value]) => (
              <div key={label} className="bg-elevated/50 p-3 rounded-lg">
                <div className="text-[10px] text-muted">{label}</div>
                <div className="text-base font-semibold mt-1">{value}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-3">
            Context: {fmt(plan.context_window)} · Output reserved per call:{" "}
            {fmt(plan.output_reservation_per_request)} · Safety allowance:{" "}
            {fmt(plan.safety_tokens_per_request)}. Prompt and formatting
            overhead are counted.
          </p>
          <p className="text-[11px] text-muted mt-2">
            Estimated review input: {fmt(plan.estimated_review_input_tokens)}{" "}
            tokens · Review-call budget: {money(plan.review_calls_budget_usd)}{" "}
            USD using maximum reserved output. Consolidation and embeddings are
            additional.
          </p>
          <p className="text-[11px] text-muted mt-2">
            Token method: {plan.token_method}. Provider counts may differ;
            totals and cost update during the run.
          </p>
          {plan.oversized_files?.length > 0 && (
            <div className="error-box mt-3">
              <p>
                These files cannot fit individually. No file will be cut or
                skipped; deselect them or increase the context only if your
                deployment supports it.
              </p>
              <ul className="list-disc pl-5 mt-2 text-xs">
                {plan.oversized_files.map((item) => (
                  <li key={item.path} className="break-all">
                    {item.path} — {fmt(item.input_tokens)} estimated input
                    tokens; available {fmt(item.available_input_tokens)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.prompt_required && (
            <p className="text-xs text-amber mt-2">
              Select a saved prompt to finalize the plan.
            </p>
          )}
          {plan.batches?.length > 0 && (
            <details className="text-xs mt-3">
              <summary className="text-sky-400 cursor-pointer">
                Inspect batch membership
              </summary>
              <div className="max-h-60 overflow-y-auto mt-2 space-y-3">
                {plan.batches.map((batch) => (
                  <div
                    key={batch.number}
                    className="border border-line rounded-lg p-3"
                  >
                    <p className="font-medium">
                      Batch {batch.number}: {batch.files.length} files ·{" "}
                      {fmt(batch.lines)} lines · {fmt(batch.input_tokens)}{" "}
                      estimated input tokens
                    </p>
                    <p className="font-mono text-[10px] text-muted mt-2 whitespace-pre-wrap break-all">
                      {batch.files.join("\n")}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
