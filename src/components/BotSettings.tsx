import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import type {
  BotConfig,
  BotSettings as Settings,
  Company,
  ModelOption,
  Provider,
} from '../shared/types';
import { botConfig, MAX_BOT_INSTRUCTIONS, normalizeBotConfig, sameBotConfig } from '../shared/bot';
import {
  KNOWN_MODEL_RATES,
  MODEL_DEFAULTS,
  PROVIDER_NAMES,
  recommendedModel,
} from '../shared/models';
import { useAction, useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { cn, label, shortDate } from '../lib/utils';
import { ActionButton, Badge, ConfirmDialog, CustomSelect, Field, PageHeading } from './ui';

const KEY_HINTS: Record<Provider, { placeholder: string; url: string; pricing: string }> = {
  anthropic: {
    placeholder: 'sk-ant-…',
    url: 'https://console.anthropic.com/settings/keys',
    pricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  openai: {
    placeholder: 'sk-…',
    url: 'https://platform.openai.com/api-keys',
    pricing: 'https://openai.com/api/pricing/',
  },
  gemini: {
    placeholder: 'AIza…',
    url: 'https://aistudio.google.com/app/apikey',
    pricing: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  mock: { placeholder: '', url: '', pricing: '' },
};

export function BotSettings() {
  const { data, mutate, navigate, notify } = useWorkspace();
  const { pending, run } = useAction();
  const [draft, setDraft] = useState(() => botConfig(data.company, true));
  // The saved draft (at `revision`) that the edits on screen started from.
  const [base, setBase] = useState(draft);
  const [revision, setRevision] = useState(data.company.bot?.revision ?? 0);
  const [restoring, setRestoring] = useState<number>();
  const [restoreError, setRestoreError] = useState('');
  const [ai, setAi] = useState(data.company.ai);
  const [approved, setApproved] = useState(data.company.privacy?.aiDataApproved ?? false);
  const [apiKey, setApiKey] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  const [checkedAt, setCheckedAt] = useState('');
  const [catalogNote, setCatalogNote] = useState('');
  const [loading, setLoading] = useState(false);
  const owner = data.role !== 'staff';
  const published = data.company.bot?.published;
  // Compared by meaning: the database reorders fields and the server trims text.
  const changed = !sameBotConfig(draft, base);
  const live = !!published && sameBotConfig(draft, published.config);
  // Someone saved elsewhere (another tab or owner) and there are no edits here: follow along.
  useEffect(() => {
    const latest = data.company.bot?.revision ?? 0;
    if (latest === revision || changed) return;
    const fresh = botConfig(data.company, true);
    setRevision(latest);
    setBase(fresh);
    setDraft(fresh);
  }, [data.company.bot?.revision]);
  // After a save: the server's copy becomes the new starting point. Anything typed while
  // it was saving stays on screen as an unsaved change instead of being overwritten.
  const adopt = (saved: Settings, sent: BotConfig) => {
    const fresh = normalizeBotConfig(saved.draft);
    setRevision(saved.revision);
    setBase(fresh);
    setDraft((current) => (current === sent ? fresh : current));
  };
  const usesAi = ai.provider !== 'mock';
  // Every business connects its own key. There is no shared Orderly key.
  const savedKey =
    usesAi &&
    !!data.integrations?.find((integration) => integration.kind === ai.provider)?.configured;
  const connected =
    data.company.ai.provider !== 'mock' &&
    !!data.readiness?.find((check) => check.id === 'model')?.ready;
  const sameAsSaved =
    ai.provider === data.company.ai.provider &&
    ai.model === data.company.ai.model &&
    JSON.stringify(ai.pricing) === JSON.stringify(data.company.ai.pricing) &&
    !apiKey.trim();
  const canConnect = usesAi && approved && !!ai.model && (savedKey || !!apiKey.trim());
  const update = (patch: Partial<BotConfig>) => setDraft({ ...draft, ...patch });
  async function discover(refresh = false) {
    // Models can only be listed once this business has saved its own key.
    if (!usesAi || !savedKey) {
      setCatalog([]);
      setCatalogNote(usesAi ? 'The full model list appears after the key is connected.' : '');
      return;
    }
    setLoading(true);
    setCatalogNote('');
    try {
      const result = await api<{ items: ModelOption[]; checkedAt: string }>(
        `/models?provider=${ai.provider}&refresh=${refresh}`,
        data.company.id,
      );
      setCatalog(result.items);
      setCheckedAt(result.checkedAt);
    } catch (e) {
      setCatalogNote((e as Error).message);
      setCatalog([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (owner) void discover();
  }, [ai.provider, savedKey]);
  // Failures already show as a notification (from mutate); nothing else to do here.
  const act = (key: string, work: () => Promise<unknown>) =>
    void run(key, work).catch(() => undefined);
  const connect = () =>
    act('connect', async () => {
      await mutate(
        '/ai/connect',
        {
          provider: ai.provider,
          model: ai.model,
          approve: true,
          monthlyBudgetUsd: ai.monthlyBudgetUsd,
          ...(apiKey.trim() && { apiKey: apiKey.trim() }),
          ...(ai.pricing && { pricing: ai.pricing }),
        },
        undefined,
        {
          success: `Connected. ${PROVIDER_NAMES[ai.provider]} ${ai.model} answered a test message, and the bot now uses it.`,
        },
      );
      setApiKey('');
    });
  const saveDraft = () =>
    act('draft', async () => {
      const sent = draft;
      const saved = await mutate<Settings>('/bot/draft', { config: sent, revision }, 'PUT', {
        success: published
          ? `Draft saved. Customers keep seeing version ${published.version} until you publish.`
          : 'Draft saved. Publish it when you want customers to get it.',
      });
      adopt(saved, sent);
    });
  // One click: the settings on screen are saved and published together.
  const publish = () =>
    act('publish', async () => {
      const sent = draft;
      const saved = await mutate<Settings>('/bot/publish', { revision, config: sent });
      adopt(saved, sent);
      notify(
        `Published version ${saved.published?.version}. Customers now get these settings.${
          data.company.botEnabled ? '' : ' Automatic replies are still paused.'
        }`,
      );
    });
  // Publishes an older version again; it also replaces the draft.
  const restore = (version: number) =>
    act(`restore-${version}`, async () => {
      const sent = draft;
      setRestoreError('');
      try {
        const saved = await mutate<Settings>(
          '/bot/publish',
          { revision, restoreVersion: version },
          undefined,
          {
            dialog: true,
            success: `Version ${version} restored. Customers now get it as version ${
              (published?.version ?? 0) + 1
            }.`,
          },
        );
        adopt(saved, sent);
        setRestoring(undefined);
      } catch (e) {
        setRestoreError((e as Error).message);
      }
    });
  const items = catalog.some((m) => m.id === ai.model)
    ? catalog
    : [
        {
          id: ai.model,
          name: ai.model || 'Choose a model',
          available: true,
          priced: !!KNOWN_MODEL_RATES[ai.model],
          inputRate: KNOWN_MODEL_RATES[ai.model]?.[0],
          outputRate: KNOWN_MODEL_RATES[ai.model]?.[1],
        },
        ...catalog,
      ];
  const picked = items.find((m) => m.id === ai.model);
  return (
    <>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the saved ${PROVIDER_NAMES[ai.provider]} key?`}
        description="Automatic replies pause and the bot stops using this key until you connect another one. The key still works in your provider account; revoke it there if you no longer need it."
        confirmLabel="Remove key"
        busy={pending === 'remove-key'}
        busyLabel="Removing…"
        error={removing ? removeError : undefined}
        onConfirm={() =>
          act('remove-key', async () => {
            setRemoveError('');
            try {
              await mutate(`/integrations/${ai.provider}`, undefined, 'DELETE', {
                dialog: true,
                success: 'Saved key removed. Paste a new key to connect again.',
              });
              setRemoving(false);
            } catch (e) {
              setRemoveError((e as Error).message);
            }
          })
        }
      />
      <ConfirmDialog
        open={restoring !== undefined}
        onOpenChange={(open) => {
          if (!open) setRestoring(undefined);
          setRestoreError('');
        }}
        title={`Restore version ${restoring}?`}
        description={`Customers get version ${restoring} right away. The settings on this page are not published, and they will be replaced by version ${restoring}. To keep them, publish them first.`}
        confirmLabel={`Restore version ${restoring}`}
        busy={pending === `restore-${restoring}`}
        busyLabel="Restoring…"
        error={restoreError}
        onConfirm={() => {
          if (restoring !== undefined) restore(restoring);
        }}
      />
      <PageHeading
        title="Bot settings"
        description="Choose how this business’s assistant behaves. Drafts stay separate from the published bot."
      >
        <button className="btn" onClick={() => navigate('playground')}>
          Test saved draft
        </button>
      </PageHeading>
      <section className="card mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-title">Live readiness</h2>
          <Badge tone={data.company.botEnabled ? 'green' : 'amber'}>
            {data.company.botEnabled ? 'Automation enabled' : 'Automation paused'}
          </Badge>
        </div>
        <ul className="stagger mt-4 grid gap-2 text-sm sm:grid-cols-2">
          {data.readiness?.map((c) => (
            <li
              key={c.id}
              className="flex items-start gap-2.5 rounded-xl bg-paper px-3 py-2 text-[13px] leading-5 text-stone-700"
            >
              <span
                aria-label={c.ready ? 'Complete' : 'Required'}
                className={
                  c.ready
                    ? 'pop-in inline-grid size-5 shrink-0 place-items-center rounded-full bg-success-700 text-[11px] font-bold leading-none text-white shadow-[0_6px_12px_-6px_rgb(23_124_74/0.8)]'
                    : 'inline-grid size-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-[11px] font-bold leading-none text-brand-800'
                }
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
          <ActionButton
            className={cn('mt-4', !data.company.botEnabled && 'btn-primary')}
            loading={pending === 'automation'}
            loadingLabel={data.company.botEnabled ? 'Pausing…' : 'Enabling…'}
            onClick={() =>
              act('automation', () =>
                mutate(
                  `/companies/${data.company.id}`,
                  { ...data.company, botEnabled: !data.company.botEnabled },
                  'PUT',
                  {
                    success: data.company.botEnabled
                      ? 'Automatic replies paused.'
                      : 'Automatic replies are on.',
                  },
                ),
              )
            }
          >
            {data.company.botEnabled ? 'Pause automation' : 'Enable automation'}
          </ActionButton>
        )}
      </section>
      <fieldset disabled={!owner} className="stagger min-w-0 space-y-6 disabled:opacity-70">
        <section className="card p-5 sm:p-6 space-y-5" aria-labelledby="ai-model-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="ai-model-title" className="panel-title">
              AI model
            </h2>
            <Badge tone={connected ? 'green' : 'amber'}>
              {connected
                ? `Connected · ${PROVIDER_NAMES[data.company.ai.provider]} ${data.company.ai.model}`
                : 'Not connected'}
            </Badge>
          </div>
          <p className="text-sm leading-relaxed text-stone-500">
            Each business uses its own API key, so its AI usage is billed to its own provider
            account. Choose a provider, paste the key, tick the agreement and click{' '}
            <strong className="text-stone-700">Connect and test</strong>. Orderly checks the key and
            sends one test message before switching the bot over. If anything fails, nothing
            changes.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="AI provider">
              <CustomSelect
                value={ai.provider}
                onChange={(v) => {
                  if (v === ai.provider) return;
                  const provider = v as Provider;
                  const saved = provider === data.company.ai.provider;
                  setApproved(saved ? (data.company.privacy?.aiDataApproved ?? false) : false);
                  setApiKey('');
                  setAi({
                    ...ai,
                    provider,
                    model: saved ? data.company.ai.model : MODEL_DEFAULTS[provider],
                    pricing: saved ? data.company.ai.pricing : undefined,
                  });
                }}
                options={[
                  { value: 'anthropic', label: 'Anthropic Claude · recommended' },
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'gemini', label: 'Google Gemini' },
                  { value: 'mock', label: 'No AI · built-in rules (testing only)' },
                ]}
              />
            </Field>
            {usesAi && (
              <Field
                label="Model"
                hint={
                  catalogNote ||
                  (checkedAt ? `Model list checked ${shortDate(checkedAt)}.` : undefined)
                }
              >
                <CustomSelect
                  value={ai.model}
                  disabled={loading}
                  onChange={(v) => setAi({ ...ai, model: v, pricing: undefined })}
                  options={items.map((m) => ({
                    value: m.id,
                    label: `${m.name}${recommendedModel(ai.provider, m.id) ? ' · recommended' : ''}${!m.available ? ' · unavailable' : !m.priced ? ' · prices required' : ''}`,
                    disabled: !m.available,
                  }))}
                />
              </Field>
            )}
            {usesAi && (
              <div className="sm:col-span-2">
                <Field
                  label={`${PROVIDER_NAMES[ai.provider]} API key for ${data.company.name}`}
                  hint={
                    savedKey
                      ? 'A key is already saved for this business and is never shown. Leave this empty to keep it, or paste a new key to replace it.'
                      : 'Stored encrypted on the server and used only for this business.'
                  }
                >
                  <input
                    className="input font-mono"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={apiKey}
                    placeholder={savedKey ? '•••••••• saved' : KEY_HINTS[ai.provider].placeholder}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
                <a
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
                  href={KEY_HINTS[ai.provider].url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Get a {PROVIDER_NAMES[ai.provider]} API key
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}
            <Field
              label="Monthly AI spending limit (USD)"
              hint="When the limit is reached, customers get a short notice and staff take over."
            >
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
          </div>
          {usesAi && (
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-ink/[0.06] bg-paper px-4 py-3 text-sm leading-6 transition-colors has-[:checked]:border-brand-500/25 has-[:checked]:bg-brand-50">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-brand-500"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              <span>
                I agree to send customer messages to {PROVIDER_NAMES[ai.provider]} to generate
                replies, and I have checked its data and billing terms
                {ai.provider === 'gemini' ? ', including the free-tier data-use differences' : ''}.
                I will let customers know.
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {usesAi ? (
              <ActionButton
                className="btn-primary"
                disabled={!canConnect}
                loading={pending === 'connect'}
                loadingLabel="Checking the key and testing a reply…"
                onClick={connect}
              >
                <PlugZap className="size-4" />
                {connected && sameAsSaved ? 'Test again' : 'Connect and test'}
              </ActionButton>
            ) : data.company.ai.provider === 'mock' ? (
              <p className="text-sm text-stone-500">
                AI is off. Choose a provider above to connect one.
              </p>
            ) : (
              <ActionButton
                className="btn-primary"
                loading={pending === 'ai-off'}
                loadingLabel="Turning AI off…"
                onClick={() =>
                  act('ai-off', () =>
                    mutate(
                      `/companies/${data.company.id}`,
                      {
                        ...data.company,
                        botEnabled: false,
                        ai: {
                          provider: 'mock',
                          model: MODEL_DEFAULTS.mock,
                          monthlyBudgetUsd: ai.monthlyBudgetUsd,
                        },
                      },
                      'PUT',
                      {
                        success:
                          'AI turned off. Test chats use built-in rules only, and automatic replies are paused.',
                      },
                    ),
                  )
                }
              >
                Turn AI off
              </ActionButton>
            )}
            {data.company.ai.provider !== 'mock' &&
              ai.monthlyBudgetUsd !== data.company.ai.monthlyBudgetUsd && (
                <ActionButton
                  loading={pending === 'limit'}
                  loadingLabel="Saving…"
                  onClick={() =>
                    act('limit', () =>
                      mutate(
                        `/companies/${data.company.id}`,
                        {
                          ...data.company,
                          ai: { ...data.company.ai, monthlyBudgetUsd: ai.monthlyBudgetUsd },
                        },
                        'PUT',
                        { success: 'Spending limit saved.' },
                      ),
                    )
                  }
                >
                  <Save className="size-4" />
                  Save limit only
                </ActionButton>
              )}
            {savedKey && (
              <button
                className="btn btn-quiet text-red-700 hover:bg-red-50 hover:text-red-800"
                onClick={() => {
                  setRemoveError('');
                  setRemoving(true);
                }}
              >
                Remove saved key
              </button>
            )}
          </div>
          {usesAi && !canConnect && pending !== 'connect' && (
            <p className="text-xs font-semibold text-brand-700">
              {!approved ? 'Tick the agreement to continue.' : 'Paste the API key to continue.'}
            </p>
          )}
          {usesAi && (
            <p className="text-xs leading-relaxed text-stone-500">
              The test sends one fictional message (“Hello. Please show the menu.”) to prove this
              exact model and key can produce a valid order reply. It costs a fraction of a cent.
              Orderly never switches models on its own.
            </p>
          )}
          {usesAi && (
            <details
              open={!picked?.priced || !!ai.pricing}
              className="rounded-2xl border border-ink/[0.06] bg-paper p-4"
            >
              <summary className="cursor-pointer text-sm font-semibold text-ink marker:text-brand-500">
                Advanced: prices and model list
              </summary>
              <p className="my-3 text-xs leading-5 text-stone-500">
                Token prices in USD per million tokens. Known models are filled in automatically;
                enter prices only for a model marked “prices required”. They are used to reserve the
                spending limit; the provider’s invoice is authoritative.
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
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <button className="btn" disabled={!savedKey} onClick={() => void discover(true)}>
                  <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
                  {loading ? 'Loading…' : 'Refresh model list'}
                </button>
                <a
                  className="text-xs font-semibold text-brand-700 underline decoration-brand-500/40 underline-offset-4 transition-colors hover:text-brand-800 hover:decoration-brand-500"
                  href={KEY_HINTS[ai.provider].pricing}
                  target="_blank"
                  rel="noreferrer"
                >
                  {PROVIDER_NAMES[ai.provider]} prices
                </a>
              </div>
            </details>
          )}
        </section>
        <section className="card p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="panel-title">Behavior draft</h2>
            <Badge tone={changed ? 'amber' : 'neutral'}>
              {changed ? 'Unsaved changes' : 'All changes saved'}
            </Badge>
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
            hint="Define your flow, wording and interruptions. Answer customer questions first, then resume ordering. Up to 20,000 characters."
          >
            <textarea
              className="input min-h-32"
              maxLength={MAX_BOT_INSTRUCTIONS}
              value={draft.instructions}
              onChange={(e) => update({ instructions: e.target.value })}
            />
            <p
              className="mt-1.5 text-right font-mono text-[11px] tabular-nums text-stone-500"
              aria-live="polite"
            >
              {draft.instructions.length.toLocaleString()} / {MAX_BOT_INSTRUCTIONS.toLocaleString()}{' '}
              characters
            </p>
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="eyebrow mb-1.5">Behavior rules</h3>
                <p className="text-sm text-stone-500">
                  Rules run from top to bottom. The first matching rule controls what the bot does.
                </p>
              </div>
              <button
                className="btn"
                disabled={draft.behaviorRules.length >= 30}
                onClick={() =>
                  update({
                    behaviorRules: [
                      ...draft.behaviorRules,
                      {
                        id: crypto.randomUUID(),
                        enabled: true,
                        when: '',
                        action: 'continue',
                        response: '',
                        responseMode: 'adaptive',
                      },
                    ],
                  })
                }
              >
                <Plus className="size-4" />
                Add rule
              </button>
            </div>
            {draft.behaviorRules.length === 0 && (
              <p className="step-in rounded-2xl border border-dashed border-ink/15 bg-cream/60 p-4 text-sm text-stone-500">
                No special rules yet. Goal and Additional instructions still guide the bot.
              </p>
            )}
            {draft.behaviorRules.map((rule, i) => (
              <div
                key={rule.id}
                className={cn(
                  'step-in space-y-4 rounded-2xl border p-4 transition-colors',
                  rule.enabled
                    ? 'border-ink/[0.06] bg-paper'
                    : 'border-dashed border-ink/15 bg-cream/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={rule.enabled}
                    aria-label={`Enable rule ${i + 1}`}
                    onChange={(event) =>
                      update({
                        behaviorRules: draft.behaviorRules.map((item, index) =>
                          index === i ? { ...item, enabled: event.target.checked } : item,
                        ),
                      })
                    }
                  />
                  <strong
                    className={cn(
                      'ml-1 min-w-0 flex-1 truncate font-serif text-[22px] font-normal leading-tight tracking-[-0.01em] transition-colors max-sm:text-[18px]',
                      rule.enabled ? 'text-ink' : 'text-stone-500',
                    )}
                  >
                    Rule {i + 1}
                  </strong>
                  <button
                    className="icon-btn group"
                    disabled={i === 0}
                    aria-label={`Move rule ${i + 1} up`}
                    onClick={() => {
                      const behaviorRules = [...draft.behaviorRules];
                      [behaviorRules[i - 1], behaviorRules[i]] = [
                        behaviorRules[i]!,
                        behaviorRules[i - 1]!,
                      ];
                      update({ behaviorRules });
                    }}
                  >
                    <ArrowUp className="size-4 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-translate-y-0.5" />
                  </button>
                  <button
                    className="icon-btn group"
                    disabled={i === draft.behaviorRules.length - 1}
                    aria-label={`Move rule ${i + 1} down`}
                    onClick={() => {
                      const behaviorRules = [...draft.behaviorRules];
                      [behaviorRules[i + 1], behaviorRules[i]] = [
                        behaviorRules[i]!,
                        behaviorRules[i + 1]!,
                      ];
                      update({ behaviorRules });
                    }}
                  >
                    <ArrowDown className="size-4 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:translate-y-0.5" />
                  </button>
                  <button
                    className="icon-btn hover:bg-red-50 hover:text-red-700"
                    aria-label={`Remove rule ${i + 1}`}
                    onClick={() =>
                      update({
                        behaviorRules: draft.behaviorRules.filter((_, index) => index !== i),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <Field label="When this happens">
                  <textarea
                    className="input min-h-20"
                    maxLength={500}
                    required
                    placeholder="For example: the customer changes the subject while an order is in progress"
                    value={rule.when}
                    onChange={(event) =>
                      update({
                        behaviorRules: draft.behaviorRules.map((item, index) =>
                          index === i ? { ...item, when: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Then">
                    <CustomSelect
                      value={rule.action}
                      onChange={(value) =>
                        update({
                          behaviorRules: draft.behaviorRules.map((item, index) =>
                            index === i ? { ...item, action: value as typeof rule.action } : item,
                          ),
                        })
                      }
                      options={[
                        { value: 'continue', label: 'Continue the order' },
                        { value: 'reply', label: 'Reply only' },
                        { value: 'handoff', label: 'Hand off to staff' },
                      ]}
                    />
                  </Field>
                  <Field label="Wording">
                    <CustomSelect
                      value={rule.responseMode}
                      onChange={(value) =>
                        update({
                          behaviorRules: draft.behaviorRules.map((item, index) =>
                            index === i
                              ? { ...item, responseMode: value as typeof rule.responseMode }
                              : item,
                          ),
                        })
                      }
                      options={[
                        { value: 'adaptive', label: 'Let AI adapt it' },
                        { value: 'exact', label: 'Use exact words' },
                      ]}
                    />
                  </Field>
                </div>
                <Field label={rule.responseMode === 'exact' ? 'Exact reply' : 'Response guidance'}>
                  <textarea
                    className="input min-h-20"
                    maxLength={1500}
                    value={rule.response}
                    placeholder={
                      rule.responseMode === 'exact'
                        ? 'Text sent exactly to the customer'
                        : 'Explain how the bot should respond'
                    }
                    onChange={(event) =>
                      update({
                        behaviorRules: draft.behaviorRules.map((item, index) =>
                          index === i ? { ...item, response: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
              </div>
            ))}
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-ink/[0.06] bg-paper p-4 text-sm leading-[21px] transition-colors has-[:checked]:border-brand-500/25 has-[:checked]:bg-brand-50">
            <input
              className="toggle"
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
            <div
              key={i}
              className="step-in space-y-3 rounded-2xl border border-ink/[0.06] bg-paper p-4"
            >
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
                  className="icon-btn hover:bg-red-50 hover:text-red-700"
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
        <section
          className="notice flex flex-wrap items-center justify-between gap-4 rounded-[22px] p-5 sm:p-6"
          aria-label="Publish"
        >
          <div className="min-w-0 text-sm" aria-live="polite">
            <p className="font-semibold text-cream">
              {live
                ? `Customers see these settings (version ${published?.version}).`
                : published
                  ? `Customers see version ${published.version}. The settings above are not live yet.`
                  : 'Nothing is published yet. Customers get the default settings.'}
            </p>
            <p className="mt-1 text-cream/70">
              {live && !changed
                ? 'Change something above to publish a new version.'
                : 'Publish saves and makes these settings live in one step. You can test a saved draft first in Test your bot.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ActionButton
              loading={pending === 'draft'}
              loadingLabel="Saving…"
              disabled={!changed}
              onClick={saveDraft}
            >
              {changed ? <Save className="size-4" /> : <Check className="pop-spin size-4" />}
              {changed ? 'Save draft' : 'Draft saved'}
            </ActionButton>
            <ActionButton
              className="btn-primary"
              loading={pending === 'publish'}
              loadingLabel="Publishing…"
              disabled={live && !changed}
              onClick={publish}
            >
              {live && !changed ? (
                <>
                  <Check className="pop-spin size-4" />
                  Published
                </>
              ) : changed ? (
                'Save and publish'
              ) : (
                'Publish'
              )}
            </ActionButton>
          </div>
        </section>
        {!!data.company.bot?.history.length && (
          <section className="card p-5 sm:p-6">
            <h2 className="panel-title">Published history</h2>
            <div className="stagger mt-4 space-y-1">
              {[...data.company.bot.history].reverse().map((v) => (
                <div
                  key={v.version}
                  className={cn(
                    '-mx-3 flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-1.5 text-sm transition-colors',
                    v.version === data.company.bot?.published?.version
                      ? 'bg-brand-50 font-semibold text-ink'
                      : 'text-stone-700 hover:bg-white/70',
                  )}
                >
                  <span>
                    Version {v.version} · {shortDate(v.publishedAt)}
                  </span>
                  {v.version !== data.company.bot?.published?.version && (
                    <ActionButton
                      loading={pending === `restore-${v.version}`}
                      loadingLabel="Restoring…"
                      onClick={() => {
                        // A saved draft or edits that are not live would be replaced: ask first.
                        setRestoreError('');
                        if (live && !changed) restore(v.version);
                        else setRestoring(v.version);
                      }}
                    >
                      Restore version {v.version}
                    </ActionButton>
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
