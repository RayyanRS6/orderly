import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type {
  BotConfig,
  BotSettings as Settings,
  Company,
  ModelOption,
  Provider,
} from '../shared/types';
import { botConfig } from '../shared/bot';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { label, shortDate } from '../lib/utils';
import { Badge, CustomSelect, ErrorNotice, Field, PageHeading } from './ui';

export function BotSettings() {
  const { data, mutate, busy, navigate } = useWorkspace();
  const [draft, setDraft] = useState(() => botConfig(data.company, true));
  const [revision, setRevision] = useState(data.company.bot?.revision ?? 0);
  const [ai, setAi] = useState(data.company.ai);
  const [approved, setApproved] = useState(data.company.privacy?.aiDataApproved ?? false);
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  const [checkedAt, setCheckedAt] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const owner = data.role !== 'staff';
  const changed =
    JSON.stringify(draft) !==
    JSON.stringify(data.company.bot?.draft ?? botConfig(data.company, true));
  const modelChanged =
    JSON.stringify(ai) !== JSON.stringify(data.company.ai) ||
    approved !== (data.company.privacy?.aiDataApproved ?? false);
  const update = (patch: Partial<BotConfig>) => {
    setDraft({ ...draft, ...patch });
    setNotice('');
  };
  async function discover(refresh = false) {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ items: ModelOption[]; checkedAt: string }>(
        `/models?provider=${ai.provider}&keyMode=${ai.keyMode}&refresh=${refresh}`,
        data.company.id,
      );
      setCatalog(result.items);
      setCheckedAt(result.checkedAt);
    } catch (e) {
      setError((e as Error).message);
      setCatalog([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (owner) void discover();
  }, [ai.provider, ai.keyMode]);
  async function action(work: () => Promise<unknown>, message: string) {
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function saveDraft() {
    const saved = await mutate<Settings>('/bot/draft', { config: draft, revision }, 'PUT');
    setRevision(saved.revision);
  }
  const items = catalog.some((m) => m.id === ai.model)
    ? catalog
    : [
        { id: ai.model, name: ai.model || 'Choose a model', available: true, priced: false },
        ...catalog,
      ];
  const picked = items.find((m) => m.id === ai.model);
  return (
    <>
      <PageHeading
        title="Bot settings"
        description="Choose how this business’s assistant behaves. Drafts stay separate from the published bot."
      >
        <button className="btn" onClick={() => navigate('playground')}>
          Test saved draft
        </button>
      </PageHeading>
      <ErrorNotice message={error} />
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-success-700/15 bg-success-700/[0.07] p-4 text-[13px] text-success-800"
        >
          {notice}
        </p>
      )}
      <section className="card mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-title">Live readiness</h2>
          <Badge tone={data.company.botEnabled ? 'green' : 'amber'}>
            {data.company.botEnabled ? 'Automation enabled' : 'Automation paused'}
          </Badge>
        </div>
        <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          {data.readiness?.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              <span
                aria-label={c.ready ? 'Complete' : 'Required'}
                className={c.ready ? 'text-success-700' : 'text-brand-500'}
              >
                {c.ready ? '✓' : '○'}
              </span>
              {c.label}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-stone-500">
          Published version: {data.company.bot?.published?.version ?? 'none'} · Model:{' '}
          <strong className="break-all text-stone-700">{data.company.ai.model}</strong>. Run an
          inbound message and a staff reply with your own test number before your first customer.
        </p>
        {owner && (
          <button
            disabled={busy}
            className="btn mt-4"
            onClick={() =>
              void action(
                () =>
                  mutate(
                    `/companies/${data.company.id}`,
                    { ...data.company, botEnabled: !data.company.botEnabled },
                    'PUT',
                  ),
                data.company.botEnabled ? 'Automation paused.' : 'Automation enabled.',
              )
            }
          >
            {data.company.botEnabled ? 'Pause automation' : 'Enable automation'}
          </button>
        )}
      </section>
      <fieldset disabled={!owner || busy} className="min-w-0 space-y-6 disabled:opacity-70">
        <section className="card p-5 sm:p-6 space-y-5">
          <h2 className="panel-title">Provider and model</h2>
          <p className="text-sm text-stone-500">
            Connect the business’s API key in Integrations. Available text models refresh when you
            open this page (cached for one hour), or on demand. New models appear automatically;
            your selected model stays pinned until you change it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="AI provider">
              <CustomSelect
                value={ai.provider}
                onChange={(v) => {
                  setApproved(false);
                  setAi({
                    ...ai,
                    provider: v as Provider,
                    keyMode: v === 'mock' ? 'platform' : 'own',
                    model: v === 'mock' ? 'deterministic-demo' : '',
                    pricing: undefined,
                  });
                }}
                options={[
                  { value: 'mock', label: 'Local rules · free sandbox' },
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'gemini', label: 'Google Gemini' },
                  { value: 'anthropic', label: 'Anthropic' },
                ]}
              />
            </Field>
            <Field label="Who pays the provider?">
              <CustomSelect
                value={ai.keyMode}
                onChange={(v) => {
                  setApproved(false);
                  setAi({ ...ai, keyMode: v as 'own' | 'platform' });
                }}
                options={[
                  { value: 'own', label: 'Business API key' },
                  {
                    value: 'platform',
                    label: 'Orderly API key',
                    disabled: data.role !== 'admin' && data.company.ai.keyMode !== 'platform',
                  },
                ]}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Model">
                <CustomSelect
                  value={ai.model}
                  disabled={loading}
                  onChange={(v) => setAi({ ...ai, model: v, pricing: undefined })}
                  options={items.map((m) => ({
                    value: m.id,
                    label: `${m.name}${!m.available ? ' · unavailable' : !m.priced ? ' · prices required' : ''}`,
                    disabled: !m.available,
                  }))}
                />
              </Field>
            </div>
            <Field label="Monthly AI spending limit (USD)">
              <input
                className="input"
                type="number"
                min="0"
                max="10000"
                step="1"
                value={ai.monthlyBudgetUsd}
                onChange={(e) => setAi({ ...ai, monthlyBudgetUsd: Number(e.target.value) })}
              />
            </Field>
            <div className="self-end">
              <button className="btn" disabled={loading} onClick={() => void discover(true)}>
                <RefreshCw className="size-4" />
                {loading ? 'Loading…' : 'Refresh models'}
              </button>
              <p className="mt-2 text-xs text-stone-500">
                {checkedAt
                  ? `Checked ${shortDate(checkedAt)}`
                  : 'Model availability has not been checked.'}
              </p>
            </div>
          </div>
          {ai.provider !== 'mock' && (
            <>
              <details
                open={!picked?.priced || !!ai.pricing}
                className="rounded-xl border border-white bg-white/50 p-4"
              >
                <summary className="cursor-pointer text-sm font-semibold">
                  Token prices and budget estimates
                </summary>
                <p className="my-3 text-xs leading-5 text-stone-500">
                  USD per million tokens. Confirm current standard rates on the provider’s pricing
                  page. Model catalogs do not include prices. These estimates are used to reserve
                  your budget; provider invoices remain authoritative.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(['Input', 'Output'] as const).map((name, index) => (
                    <Field key={name} label={`${name} price / 1M tokens`}>
                      <input
                        type="number"
                        min="0.00001"
                        max="1000"
                        step="any"
                        className="input"
                        value={
                          ai.pricing?.[index] ??
                          (index === 0 ? picked?.inputRate : picked?.outputRate) ??
                          ''
                        }
                        onChange={(e) => {
                          const rates: [number, number] = ai.pricing
                            ? [...ai.pricing]
                            : [picked?.inputRate ?? 0, picked?.outputRate ?? 0];
                          rates[index] = Number(e.target.value);
                          setAi({ ...ai, pricing: rates });
                        }}
                      />
                    </Field>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold text-brand-500 underline">
                  <a href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer">
                    OpenAI prices
                  </a>
                  <a
                    href="https://ai.google.dev/gemini-api/docs/pricing"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Gemini prices
                  </a>
                  <a
                    href="https://platform.claude.com/docs/en/about-claude/pricing"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Anthropic prices
                  </a>
                </div>
              </details>
              <label className="flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-brand-500"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                <span>
                  I have reviewed this provider’s customer-data terms and billing tier and approve
                  sending customer message content to it. I will inform customers. In particular, I
                  have checked the Gemini free and paid tier data-use differences.
                </span>
              </label>
            </>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className="btn btn-primary"
              disabled={!ai.model}
              onClick={() =>
                void action(
                  () =>
                    mutate<Company>(
                      `/companies/${data.company.id}`,
                      {
                        ...data.company,
                        botEnabled: false,
                        ai,
                        privacy: {
                          ...data.company.privacy,
                          aiDataApproved: approved,
                          retentionDays: data.company.privacy?.retentionDays ?? 0,
                        },
                      },
                      'PUT',
                    ),
                  'Model saved. Run a generation test before enabling automation.',
                )
              }
            >
              <Save className="size-4" />
              Save model settings
            </button>
            <button
              className="btn"
              disabled={modelChanged || ai.provider === 'mock'}
              onClick={() =>
                void action(
                  () => mutate('/models/test', {}),
                  'The exact selected model generated a valid structured response.',
                )
              }
            >
              <Check className="size-4" />
              Run generation test
            </button>
          </div>
          <p className="text-xs text-stone-500">
            The generation test uses fictional customer text and incurs a small API charge. Retired
            or incompatible models produce an error and hand off to staff; Orderly never silently
            switches models.
          </p>
        </section>
        <section className="card p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="panel-title">Behavior draft</h2>
            <Badge>{changed ? 'Unsaved changes' : `Saved revision ${revision}`}</Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Assistant name">
              <input
                className="input"
                maxLength={80}
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </Field>
            <Field label="Personality">
              <CustomSelect
                value={draft.personality}
                onChange={(v) => update({ personality: v as BotConfig['personality'] })}
                options={['warm', 'professional', 'concise'].map((value) => ({
                  value,
                  label: label(value),
                }))}
              />
            </Field>
            <Field label="Language">
              <CustomSelect
                value={draft.language}
                onChange={(v) => update({ language: v as BotConfig['language'] })}
                options={[
                  { value: 'auto', label: 'Match customer' },
                  { value: 'en', label: 'English' },
                  { value: 'ur', label: 'Urdu' },
                  { value: 'roman-ur', label: 'Roman Urdu' },
                ]}
              />
            </Field>
            <Field label="Fulfillment">
              <CustomSelect
                value={draft.fulfillment}
                onChange={(v) => update({ fulfillment: v as BotConfig['fulfillment'] })}
                options={[
                  { value: 'both', label: 'Pickup and delivery' },
                  { value: 'pickup', label: 'Pickup only' },
                  { value: 'delivery', label: 'Delivery only' },
                ]}
              />
            </Field>
          </div>
          <Field label="Goal">
            <textarea
              className="input min-h-24"
              maxLength={1500}
              value={draft.goal}
              onChange={(e) => update({ goal: e.target.value })}
            />
          </Field>
          <Field
            label="Additional instructions"
            hint="For example: ask one question at a time, explain lunch specials, and escalate allergy questions to staff."
          >
            <textarea
              className="input min-h-32"
              maxLength={4000}
              value={draft.instructions}
              onChange={(e) => update({ instructions: e.target.value })}
            />
          </Field>
          <Field label="Greeting (optional)">
            <textarea
              className="input"
              maxLength={500}
              value={draft.greeting}
              onChange={(e) => update({ greeting: e.target.value })}
            />
          </Field>
          <Field label="Handoff message (optional)">
            <textarea
              className="input"
              maxLength={500}
              value={draft.handoffMessage}
              onChange={(e) => update({ handoffMessage: e.target.value })}
            />
          </Field>
          <div>
            <h3 className="field-label">Order collection flow</h3>
            <p className="mb-3 text-sm text-stone-500">
              Reorder the questions. Details already supplied are remembered. Delivery address and
              area are required only for delivery.
            </p>
            <ol className="space-y-2">
              {draft.steps.map((step, i) => (
                <li
                  key={step}
                  className="flex items-center gap-3 rounded-[10px] border border-white/60 bg-white/40 p-3 text-[13px]"
                >
                  <span className="text-stone-400">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    {
                      {
                        items: 'Menu items',
                        fulfillment: 'Pickup or delivery',
                        name: 'Customer name',
                        address: 'Delivery address and area',
                      }[step]
                    }
                  </span>
                  <button
                    className="icon-btn"
                    disabled={i === 0}
                    aria-label={`Move ${step} up`}
                    onClick={() => {
                      const steps = [...draft.steps];
                      [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
                      update({ steps });
                    }}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                  <button
                    className="icon-btn"
                    disabled={i === draft.steps.length - 1}
                    aria-label={`Move ${step} down`}
                    onClick={() => {
                      const steps = [...draft.steps];
                      [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
                      update({ steps });
                    }}
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              className="size-4 shrink-0 accent-brand-500"
              type="checkbox"
              checked={draft.requirePhoneConfirmation}
              onChange={(e) => update({ requirePhoneConfirmation: e.target.checked })}
            />
            <span>
              Staff must call the customer and confirm the delivery address before accepting an
              order.
            </span>
          </label>
          <p className="notice p-4 text-[13px] leading-6">
            After collection: show the priced summary → ask the customer to confirm → save a pending
            order → sync to the connected order Sheet → staff call and accept → prepare and
            dispatch. Instructions cannot bypass menu prices, customer confirmation, required
            details or access controls. Phone calls are performed by your staff.
          </p>
        </section>
        <section className="card p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="panel-title">Approved business knowledge</h2>
            <button
              className="btn"
              disabled={draft.knowledge.length >= 30}
              onClick={() =>
                update({ knowledge: [...draft.knowledge, { question: '', answer: '' }] })
              }
            >
              <Plus className="size-4" />
              Add answer
            </button>
          </div>
          <p className="text-sm text-stone-500">
            Add factual answers such as payment methods, delivery instructions or ingredients. Menu
            prices come from your catalog.
          </p>
          {draft.knowledge.map((k, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-white bg-white/50 p-4">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={`Question ${i + 1}`}>
                    <input
                      className="input"
                      maxLength={250}
                      value={k.question}
                      onChange={(e) =>
                        update({
                          knowledge: draft.knowledge.map((x, j) =>
                            i === j ? { ...x, question: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                </div>
                <button
                  className="icon-btn"
                  aria-label={`Remove answer ${i + 1}`}
                  onClick={() => update({ knowledge: draft.knowledge.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <Field label="Approved answer">
                <textarea
                  className="input"
                  maxLength={1500}
                  value={k.answer}
                  onChange={(e) =>
                    update({
                      knowledge: draft.knowledge.map((x, j) =>
                        i === j ? { ...x, answer: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
            </div>
          ))}
        </section>
        <div className="flex flex-wrap gap-3">
          <button
            className="btn"
            onClick={() => void action(saveDraft, 'Draft saved. Test it before publishing.')}
          >
            <Save className="size-4" />
            Save draft
          </button>
          <button
            className="btn btn-primary"
            disabled={changed}
            onClick={() =>
              void action(async () => {
                const saved = await mutate<Settings>('/bot/publish', { revision });
                setRevision(saved.revision);
              }, 'Published. Automation keeps its current enabled/paused state.')
            }
          >
            Publish saved draft
          </button>
        </div>
        {!!data.company.bot?.history.length && (
          <section className="card p-5 sm:p-6">
            <h2 className="panel-title">Published history</h2>
            <div className="mt-4 space-y-3">
              {[...data.company.bot.history].reverse().map((v) => (
                <div
                  key={v.version}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <span>
                    Version {v.version} · {shortDate(v.publishedAt)}
                  </span>
                  {v.version !== data.company.bot?.published?.version && (
                    <button
                      className="btn"
                      onClick={() =>
                        void action(async () => {
                          const s = await mutate<Settings>('/bot/publish', {
                            revision,
                            restoreVersion: v.version,
                          });
                          setDraft(s.draft);
                          setRevision(s.revision);
                        }, 'Previous configuration restored as a new version.')
                      }
                    >
                      Restore version {v.version}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </fieldset>
    </>
  );
}
