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
      <p className="font-semibold text-ink">{explanationHeadline(explanation)}</p>
      <dl className="stagger space-y-3">
        <div>
          <dt className="eyebrow mb-1">Settings used</dt>
          <dd>{describeConfig(explanation)}</dd>
        </div>
        <div>
          <dt className="eyebrow mb-1">AI model</dt>
          <dd>
            {ai.called ? (
              <>
                {ai.proposed?.length ? (
                  <span className="flex flex-wrap gap-1.5">
                    {ai.proposed.map((action, index) => (
                      <span
                        key={index}
                        className="pop-in rounded-full bg-brand-500/12 px-2.5 py-0.5 text-[11px] font-semibold text-brand-800"
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
                  <span className="mt-1.5 block font-mono text-[11px] text-stone-500">
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
            <dt className="eyebrow mb-1">Your rule</dt>
            <dd>
              “{rule.when}” → {label(rule.action)} (
              {rule.responseMode === 'exact' ? 'exact words' : 'AI adapts wording'})
            </dd>
          </div>
        )}
        {!!decision.parts.length && (
          <div>
            <dt className="eyebrow mb-1">Reply written by</dt>
            <dd>
              <ul className="list-disc space-y-0.5 pl-4 marker:text-brand-500">
                {decision.parts.map((part) => (
                  <li key={part}>{PART_LABELS[part]}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {ai.called && decision.modelText !== 'used' && (
          <div>
            <dt className="eyebrow mb-1">AI wording</dt>
            <dd>{MODEL_TEXT_LABELS[decision.modelText]}</dd>
          </div>
        )}
        {!!decision.corrections.length && (
          <div>
            <dt className="eyebrow mb-1">Corrected by the order engine</dt>
            <dd>
              <ul className="list-disc space-y-0.5 pl-4 marker:text-brand-500">
                {decision.corrections.map((correction) => (
                  <li key={correction}>{describeCorrection(correction)}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {!!explanation.steps.length && (
          <div>
            <dt className="eyebrow mb-1">Steps</dt>
            <dd className="stagger flex flex-wrap gap-1.5">
              {explanation.steps.map((step, index) => (
                <span
                  key={`${step}-${index}`}
                  className="rounded-full border border-ink/[0.08] bg-white px-2.5 py-0.5 text-[11px] font-medium text-stone-600 shadow-[0_4px_10px_-8px_rgb(14_6_4/0.4)]"
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
    <div className="mt-2.5 border-t border-dashed border-ink/10 pt-2">
      <button
        type="button"
        aria-expanded={open}
        className="-ml-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-brand-700 transition-colors hover:bg-brand-500/10 hover:text-brand-800 aria-expanded:bg-brand-500/10 aria-expanded:text-brand-800"
        onClick={() => setOpen(!open)}
      >
        <Lightbulb className="size-3.5" />
        Why this reply?
        <ChevronDown
          className={cn(
            'size-3 transition-transform duration-300 ease-[var(--ease-spring)]',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && <ReplyExplanation explanation={explanation} className="step-in mt-2" />}
    </div>
  );
}
