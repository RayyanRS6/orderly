import { useState } from 'react';
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
import { useWorkspace } from '../lib/workspace';
import { cn, initials, label } from '../lib/utils';
import { Badge, CustomSelect, Empty, Field, Modal, PageHeading, Status } from './ui';
import { WhatsAppSignup } from './WhatsAppSignup';

const providers: Record<Provider, { name: string; model: string }> = {
  mock: { name: 'Local demo · no API calls', model: 'deterministic-demo' },
  openai: { name: 'OpenAI', model: 'gpt-5.4-mini' },
  anthropic: { name: 'Anthropic', model: 'claude-haiku-4-5' },
  gemini: { name: 'Google Gemini', model: 'gemini-3.5-flash-lite' },
};

export function Settings() {
  const { data, mutate, busy } = useWorkspace();
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
        keyMode: 'platform',
        monthlyBudgetUsd: 10,
      },
      deliveryZones: c.deliveryZones || [],
      faqs: c.faqs || [],
    };
  });
  const [saved, setSaved] = useState(false);
  const canEdit = data.role !== 'staff';
  const usage = data.usage || [];
  const recordedSpend = usage
    .filter((u) => u.createdAt?.startsWith(new Date().toISOString().slice(0, 7)))
    .reduce((sum, u) => sum + (u.costUsd || 0), 0);
  const update = (values: Partial<Company>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...values }));
  };
  return (
    <>
      <PageHeading
        title="A bot that knows your business."
        description="Set the details your assistant uses in every conversation."
      />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await mutate(`/companies/${draft.id}`, draft, 'PUT');
            setSaved(true);
          } catch {}
        }}
      >
        <fieldset disabled={!canEdit || busy} className="space-y-6 disabled:opacity-70">
          <section className="card p-6">
            <div className="mb-6 flex items-center gap-3">
              <Building2 className="size-5 text-emerald-800" />
              <h2 className="font-semibold">Business details</h2>
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
                <div className="flex flex-wrap gap-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => {
                    const openDays = draft.openingHours?.days || [];
                    return (
                      <label
                        key={day}
                        className={cn(
                          'flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-xs font-semibold cursor-pointer transition-all',
                          openDays.includes(i)
                            ? 'border-emerald-800 bg-emerald-50 text-emerald-900 shadow-2xs'
                            : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="accent-emerald-700"
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
              <h2 className="font-semibold">Delivery areas</h2>
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
              Pickup is always available during opening hours. Delivery is limited to these areas,
              with cash payment.
            </p>
            {!(draft.deliveryZones || []).length && (
              <p className="rounded-lg bg-stone-50 p-4 text-sm text-stone-500">
                Pickup only. Add an area to offer delivery.
              </p>
            )}
            <div className="space-y-3">
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
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove delivery area ${zone.name || i + 1}`}
                    onClick={() =>
                      update({ deliveryZones: (draft.deliveryZones || []).filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="card p-6">
            <div className="mb-6 flex items-center gap-3">
              <Bot className="size-5 text-emerald-800" />
              <h2 className="font-semibold">Assistant & menu</h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="AI provider">
                <CustomSelect
                  value={draft.ai?.provider || 'mock'}
                  onChange={(val) => {
                    const provider = val as Provider;
                    const defaultModel = (providers[provider] || providers.mock).model;
                    update({
                      ai: {
                        ...(draft.ai || {
                          provider: 'mock',
                          model: 'mock',
                          keyMode: 'platform',
                          monthlyBudgetUsd: 10,
                        }),
                        provider,
                        model: defaultModel,
                      },
                    });
                  }}
                  options={Object.entries(providers).map(([id, p]) => ({
                    value: id,
                    label: p.name,
                  }))}
                />
              </Field>
              <Field
                label="Model"
                hint="Custom models require matching prices in the server configuration."
              >
                <input
                  className="input"
                  required
                  value={draft.ai?.model || 'mock'}
                  onChange={(e) =>
                    update({
                      ai: {
                        ...(draft.ai || {
                          provider: 'mock',
                          model: 'mock',
                          keyMode: 'platform',
                          monthlyBudgetUsd: 10,
                        }),
                        model: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <Field label="API key source">
                <CustomSelect
                  value={draft.ai?.keyMode || 'platform'}
                  onChange={(val) =>
                    update({
                      ai: {
                        ...(draft.ai || {
                          provider: 'mock',
                          model: 'mock',
                          keyMode: 'platform',
                          monthlyBudgetUsd: 10,
                        }),
                        keyMode: val as 'own' | 'platform',
                      },
                    })
                  }
                  options={[
                    { value: 'platform', label: 'Platform account' },
                    { value: 'own', label: "This business's API key" },
                  ]}
                />
              </Field>
              <Field
                label="Monthly AI limit (USD)"
                hint="When this allowance is exhausted, new AI requests go to staff. A $0 limit blocks model calls, including free-tier calls."
              >
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="10000"
                  step="0.01"
                  value={draft.ai?.monthlyBudgetUsd ?? 10}
                  onChange={(e) =>
                    update({
                      ai: {
                        ...(draft.ai || {
                          provider: 'mock',
                          model: 'mock',
                          keyMode: 'platform',
                          monthlyBudgetUsd: 10,
                        }),
                        monthlyBudgetUsd: Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
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
              <label className="flex items-center gap-3 self-start rounded-2xl border border-stone-200/90 p-4 text-sm">
                <input
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
            <div className="mt-6 rounded-2xl border border-emerald-200/80 bg-emerald-50/80 p-4 sm:p-5 text-sm leading-relaxed text-emerald-900">
              The ordering rules stay the same whichever model you choose: check the menu, calculate
              the price, ask for confirmation, then save a pending order for staff.
            </div>
          </section>
          <section className="card p-6">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="font-semibold">Common questions</h2>
              <button
                className="btn rounded-full shadow-xs"
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
            <div className="space-y-5">
              {(draft.faqs || []).map((faq, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-stone-200/90 p-4 sm:p-5 bg-stone-50/40"
                >
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
                      className="icon-btn self-end rounded-full"
                      type="button"
                      aria-label={`Remove question ${i + 1}`}
                      onClick={() =>
                        update({ faqs: (draft.faqs || []).filter((_, j) => j !== i) })
                      }
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
            <span role="status" className="text-sm font-medium text-emerald-800">
              {saved ? 'Settings saved.' : !canEdit ? 'Only an owner can edit settings.' : ''}
            </span>
            <button className="btn btn-primary rounded-full px-6 shadow-sm">
              <Save className="size-4" />
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </fieldset>
      </form>
      <section className="card mt-6 p-6">
        <h2 className="font-semibold">AI usage this month</h2>
        <p className="mt-3 text-2xl font-semibold tabular-nums">
          ${recordedSpend.toFixed(4)}
          <span className="ml-2 text-sm font-normal text-stone-500">
            recorded / ${(data.company.ai?.monthlyBudgetUsd ?? 10).toFixed(2)} allowance
          </span>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          UTC calendar month. Unsettled requests also reserve budget. Estimates use paid token rates
          even when your provider usage is free; this is not a billing invoice. WhatsApp and hosting
          are separate.
        </p>
      </section>
      <Team />
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
    title: 'WhatsApp',
    description: 'Receive messages and reply from your business number.',
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
  const { data, mutate, busy, navigate } = useWorkspace();
  const [editing, setEditing] = useState<Integration | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [notice, setNotice] = useState('');
  const canEdit = data.role !== 'staff';
  const run = async (path: string, message: string, body: Record<string, string> = {}) => {
    setNotice('');
    try {
      await mutate(path, body);
      setNotice(message);
    } catch {}
  };
  return (
    <>
      <PageHeading
        title="Everything, connected."
        description="Choose the tools behind your business. Each connection belongs to this workspace."
      />
      <div className="mb-7 flex items-start gap-3.5 rounded-2xl sm:rounded-3xl border border-emerald-200/80 bg-emerald-50/70 p-5 sm:p-6 shadow-2xs">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-800" />
        <div>
          <h2 className="text-sm font-bold text-emerald-950 tracking-tight">
            Your keys stay on the server.
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-emerald-900">
            Credentials are encrypted before storage. The local playground works without keys; live
            WhatsApp requires the deployed backend and Meta setup.
          </p>
        </div>
      </div>
      <WhatsAppSignup />
      {notice && (
        <p
          role="status"
          className="mb-5 rounded-2xl border border-emerald-200/80 bg-emerald-50 p-4 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}
      <section className="card mb-6 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Selected AI connection</h2>
          <Status value={data.aiConnection?.configured ? 'configured' : 'disconnected'} />
        </div>
        {(() => {
          const aiConn = data.aiConnection || {
            provider: 'mock',
            keyMode: 'platform',
            configured: true,
          };
          const providerDef = providers[aiConn.provider] || providers.mock;
          return (
            <>
              <p className="mt-3 text-sm text-stone-700">
                {providerDef.name}
                {aiConn.provider !== 'mock' &&
                  ` · ${aiConn.keyMode === 'platform' ? 'Platform account' : 'This business’s API key'}`}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-stone-500">
                {aiConn.provider === 'mock'
                  ? 'The local demo does not need an API key.'
                  : aiConn.configured
                    ? 'The selected key is available. Test account access, then try a natural-language order in Test your bot to check the model.'
                    : aiConn.keyMode === 'platform'
                      ? 'The platform key is missing. Ask the platform administrator to connect this provider.'
                      : 'Add this business’s provider key below to use the selected model.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {aiConn.provider !== 'mock' && aiConn.configured && (
                  <button
                    className="btn"
                    disabled={!canEdit || busy}
                    onClick={() =>
                      void run(
                        `/integrations/${aiConn.provider}/test`,
                        `${providerDef.name} ${aiConn.keyMode === 'platform' ? 'platform' : 'business'} key verified. Test a natural-language order to check the selected model.`,
                        { keyMode: aiConn.keyMode },
                      )
                    }
                  >
                    <RefreshCw className="size-4" />
                    Test selected key
                  </button>
                )}
                <button className="btn btn-quiet" onClick={() => navigate('settings')}>
                  Change AI settings
                  <ArrowRight className="size-4" />
                </button>
              </div>
            </>
          );
        })()}
      </section>
      <div className="grid gap-5 md:grid-cols-2">
        {(data.integrations || []).map((integration) => {
          const info = integrationInfo[integration.kind];
          if (!info) return null;
          return (
            <section key={integration.kind} className="card flex flex-col p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="flex size-11 items-center justify-center rounded-xl bg-stone-100">
                  <info.icon className="size-5 text-stone-700" />
                </div>
                <Status value={integration.status} />
              </div>
              <h2 className="text-lg font-semibold">{info.title}</h2>
              <p className="mb-6 mt-2 text-sm leading-relaxed text-stone-500">{info.description}</p>
              {integration.error && (
                <p className="mb-4 text-xs text-red-700">{integration.error}</p>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  className="btn"
                  disabled={!canEdit || busy}
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
                  <button
                    className="btn btn-quiet"
                    disabled={!canEdit || busy}
                    onClick={() =>
                      void run(
                        `/integrations/${integration.kind}/test`,
                        `${info.title} credentials verified. Live message delivery still needs end-to-end testing.`,
                        { keyMode: 'own' },
                      )
                    }
                  >
                    <RefreshCw className="size-4" />
                    Test
                  </button>
                )}
              </div>
              {integration.checkedAt && (
                <p className="mt-4 text-xs text-stone-400">
                  Last checked {new Date(integration.checkedAt).toLocaleString()}
                </p>
              )}
            </section>
          );
        })}
      </div>
      <section className="card mt-6 p-6">
        <h2 className="font-semibold">Before connecting a restaurant number</h2>
        <div className="mt-4 grid gap-6 text-sm leading-relaxed text-stone-500 md:grid-cols-2">
          <div>
            <p className="font-medium text-stone-800">Customers stay in WhatsApp.</p>
            <p className="mt-1">
              Messages arrive at the company number and bot replies appear in the same chat. Your
              team can monitor conversations and take over in the Inbox.
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-800">Want the WhatsApp Business mobile app too?</p>
            <p className="mt-1">
              Use Meta’s eligible Business App coexistence onboarding. Standard Cloud API setup
              alone does not provide a mobile inbox. Account eligibility and Meta approval apply.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={
              !canEdit || busy || !data.integrations.find((i) => i.kind === 'whatsapp')?.configured
            }
            onClick={() =>
              void run(
                '/whatsapp/templates/status',
                'Status template submitted to Meta. Check its approval in WhatsApp Manager before using it.',
              )
            }
          >
            <MessageCircle className="size-4" />
            Submit status template
          </button>
          <button
            className="btn"
            disabled={!canEdit || busy}
            onClick={() =>
              void run(
                '/jobs/retry',
                'Failed jobs queued for another attempt. Check activity for the outcome.',
              )
            }
          >
            <RefreshCw className="size-4" />
            Retry failed jobs
          </button>
          <button className="btn btn-quiet" onClick={() => navigate('settings')}>
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
            className="space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await mutate(`/integrations/${editing.kind}`, {
                  config,
                  ...(secret.trim() ? { secret: secret.trim() } : {}),
                });
                setEditing(null);
                setSecret('');
                setNotice('Connection saved. Use Test to verify account access.');
              } catch {}
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
              <p className="rounded-2xl border border-stone-200/80 bg-stone-50/80 p-3.5 text-xs leading-relaxed text-stone-600">
                Create separate Menu and Orders tabs. Share this spreadsheet with the service
                account email as Editor. Menu columns: id, name, description, category, price,
                available, emoji, aliases, variants, modifiers. Prices in the sheet use PKR rupees.
              </p>
            )}
            {['openai', 'anthropic', 'gemini'].includes(editing.kind) && (
              <p className="text-xs leading-relaxed text-stone-500">
                To use this key, choose this provider and “This business’s API key” in Settings.
              </p>
            )}
            <button className="btn btn-primary w-full" disabled={busy}>
              <KeyRound className="size-4" />
              {busy ? 'Saving…' : 'Save connection'}
            </button>
          </form>
        )}
      </Modal>
    </>
  );
}

export function Businesses() {
  const { data, mutate, busy, switchCompany } = useWorkspace();
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
          <button className="btn btn-primary rounded-full shadow-xs" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Add business
          </button>
        )}
      </PageHeading>
      <div className="grid gap-5 md:grid-cols-2">
        {data.companies.map((company) => (
          <section
            key={company.id}
            className="card p-6 sm:p-7 rounded-3xl border border-stone-200/80 bg-white shadow-xs hover:border-stone-300 transition-all"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-50 font-bold text-emerald-800 ring-1 ring-emerald-200/70">
                {initials(company.name)}
              </div>
              {company.id === data.company.id && (
                <Badge tone="green">
                  <Check className="size-3" />
                  Current workspace
                </Badge>
              )}
            </div>
            <h2 className="mt-5 text-lg font-bold text-stone-900 tracking-tight">{company.name}</h2>
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
              className="btn rounded-full w-full shadow-xs"
              disabled={company.id === data.company.id || busy}
              onClick={() => switchCompany(company.id)}
            >
              Open workspace
              <ArrowRight className="size-4" />
            </button>
          </section>
        ))}
      </div>
      <div className="mt-7 flex gap-3 text-sm text-stone-500">
        <ShieldCheck className="size-5 shrink-0 text-emerald-800" />
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
          className="space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const company = await mutate<Company>('/companies', { name, address, phone });
              setOpen(false);
              setName('');
              setAddress('');
              setPhone('');
              switchCompany(company.id);
            } catch {}
          }}
        >
          <Field label="Business name">
            <input
              className="input rounded-xl"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your restaurant"
            />
          </Field>
          <Field label="Pickup address">
            <input
              className="input rounded-xl"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <Field label="Contact number">
            <input
              className="input rounded-xl"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <button className="btn btn-primary rounded-full w-full shadow-xs" disabled={busy}>
            <Plus className="size-4" />
            Create workspace
          </button>
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
        <ShieldCheck className="size-5 text-emerald-800" />
        <h2 className="font-semibold">Team access</h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-stone-500">
        Your role is {label(data.role).toLowerCase()}. In live mode, the platform administrator
        creates Supabase accounts and assigns owner or staff membership to this company. Staff can
        manage orders and reply to customers. Owners can also change menus and connections.
      </p>
      <p className="mt-3 break-all rounded-2xl border border-stone-200/80 bg-stone-50/80 p-3.5 font-mono text-xs text-stone-500">
        Company ID: {data.company.id}
      </p>
    </section>
  );
}
