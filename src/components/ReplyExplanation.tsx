import { useState } from 'react';
import { ChevronDown, Lightbulb } from 'lucide-react';
import type { TurnExplanation } from '../shared/types';
import {
  describeConfig,
  describeCorrection,
  describeStep,
  explanationHeadline,
  MODEL_TEXT_LABELS,
  PART_LABELS,
  SKIP_LABELS,
} from '../shared/explain';
import { cn, label } from '../lib/utils';

/** Plain-language breakdown of why the bot sent one reply. */
export function ReplyExplanation({
  explanation,
  className,
}: {
  explanation: TurnExplanation;
  className?: string;
}) {
  const { ai, decision } = explanation;
  const rule = decision.matchedRule;
  return (
    <div className={cn('space-y-3 text-[12.5px] leading-relaxed text-stone-600', className)}>
      <p className="font-semibold text-stone-800">{explanationHeadline(explanation)}</p>
      <dl className="space-y-2.5">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
            Settings used
          </dt>
          <dd>{describeConfig(explanation)}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
            AI model
          </dt>
          <dd>
            {ai.called ? (
              <>
                {ai.proposed?.length ? (
                  <span className="flex flex-wrap gap-1.5">
                    {ai.proposed.map((action, index) => (
                      <span
                        key={index}
                        className="rounded-md bg-ink/5 px-1.5 py-0.5 text-[11px] font-semibold text-stone-600"
                      >
                        {label(action.type)}
                        {action.quantity && action.quantity > 1 ? ` ×${action.quantity}` : ''}
                      </span>
                    ))}
                  </span>
                ) : (
                  'Proposed no actions.'
                )}
                {ai.ruleOverride && (
                  <span className="mt-1 block">
                    Your rule replaced these with “
                    {ai.ruleOverride === 'handoff' ? 'hand off to staff' : 'reply only'}”.
                  </span>
                )}
                {ai.askFor && ai.askFor !== 'none' && (
                  <span className="mt-1 block">Asked the customer for: {label(ai.askFor)}.</span>
                )}
                {!!ai.groundingIds?.length && (
                  <span className="mt-1 block">
                    Relied on {ai.groundingIds.length} fact{ai.groundingIds.length === 1 ? '' : 's'}{' '}
                    from your menu or business info.
                  </span>
                )}
                {ai.usage && (
                  <span className="mt-1 block text-stone-500">
                    {ai.usage.inputTokens.toLocaleString('en-US')} in /{' '}
                    {ai.usage.outputTokens.toLocaleString('en-US')} out tokens · about $
                    {ai.usage.costUsd.toFixed(4)} · {(ai.usage.durationMs / 1000).toFixed(1)}s
                    {ai.usage.estimated ? ' (estimated)' : ''}
                  </span>
                )}
              </>
            ) : ai.skipped ? (
              SKIP_LABELS[ai.skipped]
            ) : (
              'Not used for this reply.'
            )}
          </dd>
        </div>
        {rule && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
              Your rule
            </dt>
            <dd>
              “{rule.when}” → {label(rule.action)} (
              {rule.responseMode === 'exact' ? 'exact words' : 'AI adapts wording'})
            </dd>
          </div>
        )}
        {!!decision.parts.length && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
              Reply written by
            </dt>
            <dd>
              <ul className="list-disc space-y-0.5 pl-4">
                {decision.parts.map((part) => (
                  <li key={part}>{PART_LABELS[part]}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {ai.called && decision.modelText !== 'used' && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
              AI wording
            </dt>
            <dd>{MODEL_TEXT_LABELS[decision.modelText]}</dd>
          </div>
        )}
        {!!decision.corrections.length && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
              Corrected by the order engine
            </dt>
            <dd>
              <ul className="list-disc space-y-0.5 pl-4">
                {decision.corrections.map((correction) => (
                  <li key={correction}>{describeCorrection(correction)}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {!!explanation.steps.length && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-stone-400">
              Steps
            </dt>
            <dd className="flex flex-wrap gap-1.5">
              {explanation.steps.map((step, index) => (
                <span
                  key={`${step}-${index}`}
                  className="rounded-md border border-ink/[0.08] bg-white/70 px-1.5 py-0.5 text-[11px] text-stone-600"
                >
                  {describeStep(step)}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** A small "Why this reply?" toggle placed under a bot message. */
export function WhyToggle({ explanation }: { explanation: TurnExplanation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-ink/[0.06] pt-2">
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-600 hover:text-brand-700"
        onClick={() => setOpen(!open)}
      >
        <Lightbulb className="size-3.5" />
        Why this reply?
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <ReplyExplanation explanation={explanation} className="mt-2" />}
    </div>
  );
}
