import { useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Building2,
  Cable,
  Check,
  ExternalLink,
  KeyRound,
  MessageCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Table2,
  Trash2,
} from 'lucide-react';
import type { Company, Integration, IntegrationKind, Provider } from '../shared/types';
import { money } from '../shared/types';
import { MODEL_DEFAULTS } from '../shared/models';
import { useAction, useWorkspace } from '../lib/workspace';
import { cn, initials, label } from '../lib/utils';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CustomSelect,
  Empty,
  Field,
  Modal,
  PageHeading,
  Status,
} from './ui';
import { WhatsAppSignup } from './WhatsAppSignup';
import { WhatsAppConnection } from './WhatsAppConnection';

const providers: Record<Provider, { name: string; model: string }> = {
  mock: { name: 'Local demo · no API calls', model: MODEL_DEFAULTS.mock },
  openai: { name: 'OpenAI', model: MODEL_DEFAULTS.openai },
  anthropic: { name: 'Anthropic', model: MODEL_DEFAULTS.anthropic },
  gemini: { name: 'Google Gemini', model: MODEL_DEFAULTS.gemini },
};

export function Settings() {
  const { data, mutate, navigate } = useWorkspace();
  const { pending, run } = useAction();
  const edits = useRef(0);
  const [draft, setDraft] = useState<Company>(() => {
    const c = structuredClone(data.company || {});
    return {
      ...c,
      openingHours: c.openingHours || {
        start: '09:00',
        end: '22:00',
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      ai: c.ai || {
        provider: 'mock',
        model: 'mock',
        monthlyBudgetUsd: 10,
      },
      deliveryZones: c.deliveryZones || [],
      faqs: c.faqs || [],
    };
  });
  const [saved, setSaved] = useState(false);
  const canEdit = data.role !== 'staff';
  const usage = data.usage || [];
  const recordedSpend =
    data.summary?.monthlySpend ??
    usage
      .filter((u) => u.createdAt?.startsWith(new Date().toISOString().slice(0, 7)))
      .reduce((sum, u) => sum + (u.costUsd || 0), 0);
  const update = (values: Partial<Company>) => {
    edits.current++;
    setSaved(false);
    setDraft((d) => ({ ...d, ...values }));
  };
  return (
    <>
      <PageHeading
        title="Business settings"
        description="Set the details your assistant uses in every conversation."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const before = edits.current;
          void run('settings', async () => {
            // The spam limits are edited in Bot settings. Leaving them out keeps the saved
            // ones, instead of undoing a change made there after this page opened.
            const { aiLimits: _limits, ...body } = draft;
            await mutate(`/companies/${draft.id}`, body, 'PUT', { success: 'Settings saved.' });
            // Edits typed while saving are not saved yet.
            if (edits.current === before) setSaved(true);
          }).catch(() => undefined);
        }}
      >
        <fieldset disabled={!canEdit} className="stagger space-y-6 disabled:opacity-70">
          <section className="card group p-6">
            <div className="mb-6 flex items-center gap-3">
              <Building2 className="box-content size-[18px] shrink-0 -rotate-6 rounded-xl bg-ink p-[9px] text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.7)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-0" />
              <h2 className="panel-title">Business details</h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Business name">
                <input
                  className="input"
                  required
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field label="Contact number">
                <input
                  className="input"
                  type="tel"
                  value={draft.phone}
                  placeholder="+92 …"
                  onChange={(e) => update({ phone: e.target.value })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Pickup address">
                  <input
                    className="input"
                    value={draft.address}
                    onChange={(e) => update({ address: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Opens at">
                <input
                  className="input"
                  type="time"
                  required
                  value={draft.openingHours?.start || '09:00'}
                  onChange={(e) =>
                    update({
                      openingHours: {
                        ...(draft.openingHours || {
                          start: '09:00',
                          end: '22:00',
                          days: [0, 1, 2, 3, 4, 5, 6],
                        }),
                        start: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Closes at"
                hint="Matching opening and closing times means open 24 hours on selected days."
              >
                <input
                  className="input"
                  type="time"
                  required
                  value={draft.openingHours?.end || '22:00'}
                  onChange={(e) =>
                    update({
                      openingHours: {
                        ...(draft.openingHours || {
                          start: '09:00',
                          end: '22:00',
                          days: [0, 1, 2, 3, 4, 5, 6],
                        }),
                        end: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <div className="sm:col-span-2">
                <span className="field-label">Open days · Asia/Karachi</span>
                <div className="stagger flex flex-wrap gap-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => {
                    const openDays = draft.openingHours?.days || [];
                    return (
                      <label
                        key={day}
                        className={cn(
                          'flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-xs font-semibold transition-[background-color,border-color,color,box-shadow,scale] duration-200 ease-[var(--ease-soft)] active:scale-95',
                          openDays.includes(i)
                            ? 'border-ink bg-ink text-cream shadow-[0_8px_18px_-8px_rgb(14_6_4/0.7)]'
                            : 'border-ink/10 bg-white/70 text-stone-600 hover:border-ink/25 hover:bg-white hover:text-ink',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-3.5 accent-brand-500"
                          checked={openDays.includes(i)}
                          onChange={(e) =>
                            update({
                              openingHours: {
                                ...draft.openingHours,
                                days: e.target.checked
                                  ? [...openDays, i]
                                  : openDays.filter((d) => d !== i),
                              },
                            })
                          }
                        />
                        {day}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
          <section className="card p-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 className="panel-title">Delivery areas</h2>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  update({ deliveryZones: [...(draft.deliveryZones || []), { name: '', fee: 0 }] })
                }
              >
                <Plus className="size-4" />
                Add area
              </button>
            </div>
            <p className="mb-5 text-sm text-stone-500">
              Fulfillment follows your published bot settings. Delivery is limited to these areas,
              with cash payment.
            </p>
            {!(draft.deliveryZones || []).length && (
              <p className="step-in rounded-2xl border border-dashed border-ink/15 bg-cream/60 p-4 text-[13px] text-stone-500">
                Pickup only. Add an area to offer delivery.
              </p>
            )}
            <div className="stagger space-y-3">
              {(draft.deliveryZones || []).map((zone, i) => (
                <div className="flex items-end gap-3" key={i}>
                  <div className="flex-1">
                    <Field label="Area">
                      <input
                        className="input"
                        required
                        value={zone.name}
                        onChange={(e) =>
                          update({
                            deliveryZones: (draft.deliveryZones || []).map((z, j) =>
                              j === i ? { ...z, name: e.target.value } : z,
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="Fee (PKR)">
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={zone.fee / 100}
                        onChange={(e) =>
                          update({
                            deliveryZones: (draft.deliveryZones || []).map((z, j) =>
                              j === i ? { ...z, fee: Math.round(Number(e.target.value) * 100) } : z,
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <button
                    className="icon-btn hover:bg-red-50 hover:text-red-700"
                    type="button"
                    aria-label={`Remove delivery area ${zone.name || i + 1}`}
                    onClick={() =>
                      update({
                        deliveryZones: (draft.deliveryZones || []).filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="card group p-6">
            <div className="mb-6 flex items-center gap-3">
              <Bot className="box-content size-[18px] shrink-0 -rotate-6 rounded-xl bg-ink p-[9px] text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.7)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-0" />
              <h2 className="panel-title">Assistant & menu</h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <button type="button" className="btn btn-ink" onClick={() => navigate('bot')}>
                  Open bot behavior & model settings
                </button>
              </div>
              <Field
                label="Menu source"
                hint="One source controls item prices and availability for this business."
              >
                <CustomSelect
                  value={draft.catalogSource}
                  onChange={(val) => update({ catalogSource: val as 'app' | 'sheets' })}
                  options={[
                    { value: 'app', label: 'Manage here · forms or CSV' },
                    { value: 'sheets', label: 'Connected Google Sheet' },
                  ]}
                />
              </Field>
              <label className="flex cursor-pointer items-center gap-3 self-start rounded-2xl border border-ink/[0.06] bg-paper p-4 text-[13px] transition-colors has-[:checked]:border-brand-500/25 has-[:checked]:bg-brand-50">
                <input
                  className="toggle"
                  type="checkbox"
                  checked={draft.botEnabled}
                  onChange={(e) => update({ botEnabled: e.target.checked })}
                />
                <span>
                  <span className="block font-medium">Automatic replies</span>
                  <span className="mt-1 block text-xs text-stone-500">
                    Staff takeover pauses individual conversations.
                  </span>
                </span>
              </label>
            </div>
            <div className="notice mt-6 p-4 sm:p-5 text-[13px] leading-relaxed">
              The ordering rules stay the same whichever model you choose: check the menu, calculate
              the price, ask for confirmation, then save a pending order for staff.
            </div>
          </section>
          <section className="card p-6">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="panel-title">Common questions</h2>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  update({ faqs: [...(draft.faqs || []), { question: '', answer: '' }] })
                }
              >
                <Plus className="size-4" />
                Add answer
              </button>
            </div>
            <p className="mb-5 text-sm text-stone-500">
              Give your assistant approved answers about your restaurant.
            </p>
            <div className="stagger space-y-4">
              {(draft.faqs || []).map((faq, i) => (
                <div key={i} className="rounded-2xl border border-ink/[0.06] bg-paper p-4 sm:p-5">
                  <div className="mb-3 flex gap-2">
                    <div className="flex-1">
                      <Field label="Question">
                        <input
                          className="input"
                          required
                          value={faq.question}
                          onChange={(e) =>
                            update({
                              faqs: (draft.faqs || []).map((f, j) =>
                                j === i ? { ...f, question: e.target.value } : f,
                              ),
                            })
                          }
                        />
                      </Field>
                    </div>
                    <button
                      className="icon-btn self-end hover:bg-red-50 hover:text-red-700"
                      type="button"
                      aria-label={`Remove question ${i + 1}`}
                      onClick={() => update({ faqs: (draft.faqs || []).filter((_, j) => j !== i) })}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <Field label="Answer">
                    <textarea
                      className="input min-h-20"
                      required
                      value={faq.answer}
                      onChange={(e) =>
                        update({
                          faqs: (draft.faqs || []).map((f, j) =>
                            j === i ? { ...f, answer: e.target.value } : f,
                          ),
                        })
                      }
                    />
                  </Field>
                </div>
              ))}
            </div>
          </section>
          <div className="flex items-center justify-end gap-4">
            <span
              role="status"
              className={cn('text-[13px] font-semibold text-success-700', saved && 'enter-pop')}
            >
              {saved ? 'Settings saved.' : !canEdit ? 'Only an owner can edit settings.' : ''}
            </span>
            <ActionButton
              type="submit"
              className="btn-primary px-6"
              loading={pending === 'settings'}
              loadingLabel="Saving…"
            >
              <Save className="size-4" />
              Save settings
            </ActionButton>
          </div>
        </fieldset>
      </form>
      <section className="card mt-6 p-6">
        <h2 className="panel-title">AI usage this month</h2>
        <p className="pop-up mt-4 font-serif text-[44px] font-normal leading-none tracking-[-0.01em] text-ink tabular-nums">
          ${recordedSpend.toFixed(4)}
          <span className="ml-2 font-sans text-sm font-normal tracking-normal text-stone-500">
            recorded / ${(data.company.ai?.monthlyBudgetUsd ?? 10).toFixed(2)} allowance
          </span>
        </p>
        <p className="mt-3 text-xs leading-relaxed text-stone-500">
          UTC calendar month. Unsettled requests also reserve budget. Estimates use paid token rates
          even when your provider usage is free; this is not a billing invoice. WhatsApp and hosting
          are separate.
        </p>
      </section>
      <button className="btn mt-6" onClick={() => navigate('security')}>
        Manage team, security & privacy
      </button>
    </>
  );
}

const integrationInfo: Record<
  IntegrationKind,
  {
    title: string;
    description: string;
    icon: typeof Cable;
    fields: [string, string, string?][];
    secret: string;
  }
> = {
  whatsapp: {
    title: 'WhatsApp · official Meta',
    description:
      'Saved Meta Cloud API credentials. The connection method above determines which route is active.',
    icon: MessageCircle,
    fields: [
      ['phoneNumberId', 'Phone number ID'],
      ['wabaId', 'WhatsApp Business Account ID'],
      ['statusTemplate', 'Approved status template', 'orderly_order_status'],
      ['templateLanguage', 'Template language', 'en'],
    ],
    secret: 'Meta access token',
  },
  sheets: {
    title: 'Google Sheets',
    description: 'Keep orders in your spreadsheet and read a live menu.',
    icon: Table2,
    fields: [
      ['spreadsheetId', 'Spreadsheet ID'],
      ['clientEmail', 'Service account email'],
      ['catalogSheet', 'Menu tab name', 'Menu'],
      ['ordersSheet', 'Orders tab name', 'Orders'],
    ],
    secret: 'Service account private key (PEM)',
  },
  openai: {
    title: 'OpenAI',
    description: 'Use your business’s OpenAI API key.',
    icon: Bot,
    fields: [],
    secret: 'OpenAI API key',
  },
  anthropic: {
    title: 'Anthropic',
    description: 'Connect Claude to the same ordering engine.',
    icon: Bot,
    fields: [],
    secret: 'Anthropic API key',
  },
  gemini: {
    title: 'Google Gemini',
    description: 'Connect Gemini with your own API key.',
    icon: Bot,
    fields: [],
    secret: 'Gemini API key',
  },
};

export function Integrations() {
  const [disconnecting, setDisconnecting] = useState<Integration>();
  const [disconnectError, setDisconnectError] = useState('');
  const { data, mutate, navigate } = useWorkspace();
  const { pending, run } = useAction();
  const [editing, setEditing] = useState<Integration | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const canEdit = data.role !== 'staff';
  // Failures show as a notification from mutate.
  const act = (key: string, path: string, message: string) =>
    void run(key, () => mutate(path, {}, undefined, { success: message })).catch(() => undefined);
  return (
    <>
      <ConfirmDialog
        open={!!disconnecting}
        onOpenChange={(v) => {
          if (!v) setDisconnecting(undefined);
        }}
        title="Disconnect this integration?"
        description="Automation will pause, Orderly will delete the stored credential and cancel pending delivery work for this integration. Revoke Orderly access or the API key in the provider account separately. Existing provider data is kept."
        confirmLabel="Disconnect"
        busy={pending === 'disconnect'}
        busyLabel="Disconnecting…"
        error={disconnectError}
        onConfirm={() => {
          const target = disconnecting;
          if (!target) return;
          setDisconnectError('');
          void run('disconnect', async () => {
            try {
              await mutate(`/integrations/${target.kind}`, undefined, 'DELETE', {
                dialog: true,
                success: `${integrationInfo[target.kind]?.title ?? 'Integration'} disconnected.`,
              });
              setDisconnecting(undefined);
            } catch (e) {
              setDisconnectError((e as Error).message);
            }
          });
        }}
      />
      <PageHeading
        title="Everything, connected."
        description="Choose the tools behind your business. Each connection belongs to this workspace."
      />
      <div className="notice mb-7 flex items-start gap-4 rounded-[22px] p-5 sm:p-6">
        <ShieldCheck className="pop-in box-content size-5 shrink-0 -rotate-6 rounded-xl bg-brand-500 p-2 text-ink shadow-[0_12px_24px_-12px_rgb(255_105_44/0.8)]" />
        <div>
          <h2 className="font-serif text-[24px] font-normal leading-[1.05] tracking-[-0.01em] text-cream">
            Your keys stay on the server.
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-cream/70">
            Credentials are encrypted before storage. The local playground works without keys; live
            WhatsApp requires the deployed backend and your chosen connection setup.
          </p>
        </div>
      </div>
      <WhatsAppConnection />
      <WhatsAppSignup />
      <section className="card mb-6 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="panel-title">AI model</h2>
          <Status
            value={
              data.readiness?.find((check) => check.id === 'model')?.ready
                ? 'connected'
                : 'disconnected'
            }
          />
        </div>
        <p className="mt-3 inline-block max-w-full break-words rounded-full border border-ink/[0.06] bg-paper px-3.5 py-1.5 text-[13px] font-semibold text-ink">
          {(providers[data.company.ai?.provider] || providers.mock).name}
          {data.company.ai?.provider !== 'mock' && ` · ${data.company.ai.model}`}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-stone-500">
          The AI provider, this business’s API key and the model are all set up in one place: Bot
          settings → AI model. Paste the key there and click Connect and test.
        </p>
        <button className="btn btn-ink mt-4" onClick={() => navigate('bot')}>
          Set up the AI model
          <ArrowRight className="size-4" />
        </button>
      </section>
      <div className="stagger grid gap-5 md:grid-cols-2">
        {(data.integrations || [])
          .filter((integration) => integration.kind === 'whatsapp' || integration.kind === 'sheets')
          .map((integration) => {
            const info = integrationInfo[integration.kind];
            if (!info) return null;
            return (
              <section key={integration.kind} className="card group flex flex-col p-6">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div className="flex size-11 -rotate-6 items-center justify-center rounded-xl bg-ink text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.7)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-0 group-hover:scale-110">
                    <info.icon className="size-5" />
                  </div>
                  <Status value={integration.status} />
                </div>
                <h2 className="panel-title">{info.title}</h2>
                <p className="mb-6 mt-2 text-sm leading-relaxed text-stone-500">
                  {info.description}
                </p>
                {integration.error && (
                  <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                    {integration.error}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2">
                  <button
                    className={cn('btn', !integration.configured && 'btn-primary')}
                    disabled={!canEdit}
                    onClick={() => {
                      setEditing(integration);
                      setConfig(
                        Object.fromEntries(
                          info.fields.map(([key, , fallback]) => [
                            key,
                            integration.config[key] || fallback || '',
                          ]),
                        ),
                      );
                      setSecret('');
                    }}
                  >
                    {integration.configured ? 'Manage connection' : 'Connect'}
                    <ArrowRight className="size-4" />
                  </button>
                  {integration.configured && (
                    <ActionButton
                      className="btn-quiet"
                      disabled={!canEdit}
                      loading={pending === `test-${integration.kind}`}
                      loadingLabel="Testing…"
                      onClick={() =>
                        act(
                          `test-${integration.kind}`,
                          `/integrations/${integration.kind}/test`,
                          `${info.title} credentials verified. Live message delivery still needs end-to-end testing.`,
                        )
                      }
                    >
                      <RefreshCw className="size-4" />
                      Test
                    </ActionButton>
                  )}
                </div>
                {integration.configured && (
                  <button
                    disabled={!canEdit}
                    className="btn mt-3 text-red-700 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
                    onClick={() => {
                      setDisconnectError('');
                      setDisconnecting(integration);
                    }}
                  >
                    Disconnect
                  </button>
                )}
                {integration.checkedAt && (
                  <p className="mt-4 font-mono text-[11px] text-stone-400">
                    Last checked {new Date(integration.checkedAt).toLocaleString()}
                  </p>
                )}
              </section>
            );
          })}
      </div>
      <section className="card mt-6 p-6">
        <h2 className="panel-title">Before connecting a restaurant number</h2>
        <div className="mt-4 grid gap-6 text-sm leading-relaxed text-stone-500 md:grid-cols-2">
          <div>
            <p className="font-semibold text-ink">Customers stay in WhatsApp.</p>
            <p className="mt-1">
              Messages arrive at the company number and bot replies appear in the same chat. Your
              team can monitor conversations and take over in the Inbox.
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink">Want the WhatsApp Business mobile app too?</p>
            <p className="mt-1">
              Use Meta’s eligible Business App coexistence onboarding. Standard Cloud API setup
              alone does not provide a mobile inbox. Account eligibility and Meta approval apply.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <ActionButton
            disabled={!canEdit || !data.integrations.find((i) => i.kind === 'whatsapp')?.configured}
            loading={pending === 'template'}
            loadingLabel="Submitting…"
            onClick={() =>
              act(
                'template',
                '/whatsapp/templates/status',
                'Status template submitted to Meta. Check its approval in WhatsApp Manager before using it.',
              )
            }
          >
            <MessageCircle className="size-4" />
            Submit status template
          </ActionButton>
          <ActionButton
            disabled={!canEdit}
            loading={pending === 'retry'}
            loadingLabel="Queuing…"
            onClick={() =>
              act(
                'retry',
                '/jobs/retry',
                'Failed jobs queued for another attempt. Check activity for the outcome.',
              )
            }
          >
            <RefreshCw className="size-4" />
            Retry failed jobs
          </ActionButton>
          <button className="btn btn-quiet" onClick={() => navigate('bot')}>
            Choose your active model
            <ArrowRight className="size-4" />
          </button>
        </div>
      </section>
      <Modal
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setSecret('');
          }
        }}
        title={editing ? `Connect ${integrationInfo[editing.kind].title}` : 'Connect'}
        description="These credentials are only used for the selected business."
      >
        {editing && (
          <form
            className="stagger space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              // Errors show inside this dialog (Modal), so no notification is needed.
              void run('save-connection', async () => {
                await mutate(
                  `/integrations/${editing.kind}`,
                  { config, ...(secret.trim() ? { secret: secret.trim() } : {}) },
                  undefined,
                  { dialog: true, success: 'Connection saved. Use Test to verify account access.' },
                );
                setEditing(null);
                setSecret('');
              }).catch(() => undefined);
            }}
          >
            {integrationInfo[editing.kind].fields.map(([key, title]) => (
              <Field key={key} label={title}>
                <input
                  className="input"
                  value={config[key] || ''}
                  onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                  required={['phoneNumberId', 'wabaId', 'spreadsheetId', 'clientEmail'].includes(
                    key,
                  )}
                  autoComplete="off"
                />
              </Field>
            ))}
            <Field
              label={integrationInfo[editing.kind].secret}
              hint={
                editing.configured
                  ? 'Leave empty to keep the saved credential. Saved secrets are never shown here.'
                  : 'Stored encrypted on this server.'
              }
            >
              {editing.kind === 'sheets' ? (
                <textarea
                  className="input min-h-32 font-mono text-xs"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  required={!editing.configured}
                  autoComplete="off"
                />
              ) : (
                <input
                  className="input"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  required={!editing.configured}
                  autoComplete="new-password"
                />
              )}
            </Field>
            {editing.kind === 'sheets' && (
              <p className="rounded-2xl border border-ink/[0.06] bg-paper p-3.5 text-xs leading-relaxed text-stone-600">
                Create separate Menu and Orders tabs. Share this spreadsheet with the service
                account email as Editor. Menu columns: id, name, description, category, price,
                available, emoji, aliases, variants, modifiers. Prices in the sheet use PKR rupees.
              </p>
            )}
            <ActionButton
              type="submit"
              className="btn-primary w-full"
              loading={pending === 'save-connection'}
              loadingLabel="Saving…"
            >
              <KeyRound className="size-4" />
              Save connection
            </ActionButton>
          </form>
        )}
      </Modal>
    </>
  );
}

export function Businesses() {
  const { data, mutate, switchCompany } = useWorkspace();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <>
      <PageHeading
        title="Room for every business."
        description="Each workspace has its own menu, conversations, orders, and connections."
      >
        {data.role === 'admin' && (
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Add business
          </button>
        )}
      </PageHeading>
      <div className="stagger grid gap-5 md:grid-cols-2">
        {data.companies.map((company) => (
          <section key={company.id} className="card group p-6 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div className="flex size-12 -rotate-6 items-center justify-center rounded-xl bg-ink font-serif text-[24px] font-normal leading-none text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.7)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-0 group-hover:scale-110">
                {initials(company.name)}
              </div>
              {company.id === data.company.id && (
                <Badge tone="green">
                  <Check className="pop-spin size-3" />
                  Current workspace
                </Badge>
              )}
            </div>
            <h2 className="panel-title mt-5">{company.name}</h2>
            <p className="mt-2 min-h-10 text-sm text-stone-500">
              {company.address || 'Add a pickup address in Settings.'}
            </p>
            <div className="mb-6 mt-5 flex flex-wrap gap-2">
              <Badge tone="neutral">{company.botEnabled ? 'Bot enabled' : 'Bot paused'}</Badge>
              <Badge tone="neutral">{company.currency}</Badge>
              <Badge tone="neutral">
                {(providers[company.ai?.provider] || providers.mock).name}
              </Badge>
            </div>
            <button
              className="btn btn-ink w-full"
              disabled={company.id === data.company.id}
              onClick={() => switchCompany(company.id)}
            >
              Open workspace
              <ArrowRight className="size-4" />
            </button>
          </section>
        ))}
      </div>
      <div className="mt-7 flex items-start gap-3 rounded-2xl border border-ink/[0.05] bg-cream/70 px-4 py-3.5 text-sm leading-relaxed text-stone-600">
        <ShieldCheck className="mt-px size-5 shrink-0 text-brand-600" />
        <p>
          Access is checked for each request. Owners manage their business; staff handle
          conversations and orders. Only the platform administrator can add businesses.
        </p>
      </div>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a business"
        description="Start with an empty menu and a paused assistant."
      >
        <form
          className="stagger space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run('create', async () => {
              const company = await mutate<Company>(
                '/companies',
                { name, address, phone },
                undefined,
                { dialog: true, success: `${name.trim()} created.` },
              );
              setOpen(false);
              setName('');
              setAddress('');
              setPhone('');
              switchCompany(company.id);
            }).catch(() => undefined);
          }}
        >
          <Field label="Business name">
            <input
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your restaurant"
            />
          </Field>
          <Field label="Pickup address">
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Contact number">
            <input
              className="input"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <ActionButton
            type="submit"
            className="btn-primary w-full"
            loading={pending === 'create'}
            loadingLabel="Creating…"
          >
            <Plus className="size-4" />
            Create workspace
          </ActionButton>
        </form>
      </Modal>
    </>
  );
}

function Team() {
  const { data } = useWorkspace();
  return (
    <section className="card mt-6 p-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="size-5 text-brand-500" />
        <h2 className="panel-title">Team access</h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-stone-500">
        Your role is {label(data.role).toLowerCase()}. In live mode, the platform administrator
        creates Supabase accounts and assigns owner or staff membership to this company. Staff can
        manage orders and reply to customers. Owners can also change menus and connections.
      </p>
      <p className="mt-3 break-all rounded-xl border border-white bg-white/60 p-3.5 font-mono text-xs text-stone-500">
        Company ID: {data.company.id}
      </p>
    </section>
  );
}
