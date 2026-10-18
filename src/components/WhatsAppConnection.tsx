import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Smartphone, ShieldAlert } from 'lucide-react';
import type { WhatsAppConnection as Connection } from '../shared/whatsapp';
import { api } from '../lib/api';
import { dialogOpen, useAction, useWorkspace } from '../lib/workspace';
import { ActionButton, ConfirmDialog, ErrorNotice, Field } from './ui';

type Action = 'pair' | 'disconnect' | 'select-meta' | 'reconnect';
const DONE: Record<Action, string> = {
  pair: 'New pairing started. Scan the QR code or enter the code in WhatsApp.',
  disconnect: 'WhatsApp disconnected. Automatic replies are paused.',
  'select-meta': 'Switched to the official Meta route.',
  reconnect: 'Reconnecting to WhatsApp…',
};
type Snapshot = {
  status: Connection['status'];
  qr?: string;
  code?: string;
  expiresAt?: string;
  errorCode?: string;
};
// Plain words for the gateway's codes. An unknown code shows as it is. A DISCONNECT_ code
// keeps its number, which the gateway troubleshooting guide looks up (e.g. DISCONNECT_405).
const REASONS: Record<string, string> = {
  PAIRING_EXPIRED: 'the pairing code expired',
  LOGGED_OUT: 'WhatsApp logged this device out',
  RECONNECT_EXHAUSTED: 'reconnecting failed several times',
  SESSION_CRASH: 'the connection stopped unexpectedly',
  GATEWAY_START_FAILED: 'the connection could not start',
  INVALID_ACCOUNT_IDENTITY: 'WhatsApp did not confirm the linked account',
};
const reason = (code: string) =>
  REASONS[code] ??
  (code.startsWith('DISCONNECT_') ? `WhatsApp closed the connection (${code})` : code);
export function WhatsAppConnection() {
  const { data, refresh, notify } = useWorkspace();
  const act = useAction();
  const pending = act.pending;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [method, setMethod] = useState<'qr' | 'code'>('qr');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [confirm, setConfirm] = useState<'pair' | 'disconnect' | 'select-meta'>();
  // The open confirmation, readable from a request that finishes later.
  const asked = useRef(confirm);
  useEffect(() => {
    asked.current = confirm;
  }, [confirm]);
  const ask = (action: 'pair' | 'disconnect' | 'select-meta') => {
    setConfirmError('');
    setConfirm(action);
  };
  const canEdit = data.role !== 'staff';
  const companyId = data.company.id;
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    setConnection(null);
    setSnapshot(undefined);
    setError('');
    setAccepted(false);
    void api<{ enabled: boolean; connection: Connection | null }>('/whatsapp/connection', companyId)
      .then((result) => {
        if (active) {
          setEnabled(result.enabled);
          setConnection(result.connection);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [companyId, canEdit]);
  useEffect(() => {
    if (
      !enabled ||
      connection?.provider !== 'baileys' ||
      ['disconnected', 'logged_out'].includes(connection.status)
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<{ connection: Connection; snapshot: Snapshot }>(
          '/whatsapp/pairing-status',
          companyId,
          {},
        );
        if (active) {
          setConnection(result.connection);
          setSnapshot(result.snapshot);
          setError('');
        }
      } catch (e) {
        if (active) {
          setSnapshot(undefined);
          setError(e instanceof Error ? e.message : 'Connection unavailable.');
        }
      }
      if (active) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    companyId,
    enabled,
    connection?.id,
    connection?.generation,
    connection?.provider,
    connection?.status,
  ]);
  // Never leave an expired pairing secret visible while the tab is idle.
  useEffect(() => {
    if (!snapshot?.expiresAt) return;
    const timer = setTimeout(
      () =>
        setSnapshot((s) =>
          s ? { ...s, qr: undefined, code: undefined, errorCode: 'PAIRING_EXPIRED' } : s,
        ),
      Math.max(0, Date.parse(snapshot.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot?.expiresAt]);
  const run = (action: Action) =>
    act.run(action, async () => {
      setError('');
      setConfirmError('');
      setSnapshot(undefined);
      try {
        await api(
          `/whatsapp/${action}`,
          companyId,
          action === 'pair'
            ? {
                method,
                ...(method === 'code' ? { phone: phone.replace(/\D/g, '') } : {}),
                riskAccepted: accepted,
                switchConfirmed: true,
              }
            : action === 'reconnect'
              ? {}
              : { confirmed: true },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Connection failed.';
        // Its confirmation shows the failure while still open for this action. Reconnect
        // has none, and a confirmation closed meanwhile can't, so those show below (and
        // as a notification).
        if (action !== 'reconnect' && asked.current === action && dialogOpen())
          setConfirmError(message);
        else {
          setError(message);
          if (action !== 'reconnect') notify(message, 'error');
        }
        return;
      }
      // Only close the confirmation if it still belongs to this action.
      setConfirm((current) => (current === action ? undefined : current));
      notify(DONE[action], action === 'reconnect' ? 'info' : 'success');
      // The change is saved, so a failed reload only delays the new status.
      try {
        const result = await api<{ enabled: boolean; connection: Connection | null }>(
          '/whatsapp/connection',
          companyId,
        );
        setConnection(result.connection);
        setEnabled(result.enabled);
        await refresh();
      } catch {
        notify('Saved. Reload the page to see the latest status.', 'info');
      }
    });
  if (!canEdit) return null;
  const state = snapshot?.status ?? connection?.status ?? 'disconnected';
  const phoneValid = method !== 'code' || /^[1-9]\d{5,14}$/.test(phone.replace(/\D/g, ''));
  // Older Meta setups have saved credentials but no connection row.
  const metaConfigured = !!(data.integrations || []).find((i) => i.kind === 'whatsapp')?.configured;
  const noRoute = connection?.status === 'disconnected' || (!connection && !metaConfigured);
  return (
    <section className="card group mb-6 p-6">
      <div className="flex items-center gap-3">
        <Smartphone className="box-content size-[18px] shrink-0 -rotate-6 rounded-xl bg-ink p-[9px] text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.7)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-0" />
        <h2 className="panel-title">WhatsApp connection method</h2>
      </div>
      <p className="mt-3 text-sm text-stone-600">
        Active route:{' '}
        {noRoute
          ? 'none connected yet'
          : connection?.provider === 'baileys'
            ? 'Orderly linked device · unofficial'
            : 'Official Meta Cloud API'}
        . Both use your published bot, menu and orders.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="btn"
          disabled={
            !connection || (connection.provider === 'meta' && connection.status !== 'disconnected')
          }
          title={
            !connection && !metaConfigured
              ? 'Nothing is connected yet. Use the official signup below.'
              : !connection ||
                  (connection.provider === 'meta' && connection.status !== 'disconnected')
                ? 'The official Meta route is already in use.'
                : undefined
          }
          onClick={() => ask('select-meta')}
        >
          Use official Meta route
        </button>
        <span className="self-center text-xs text-stone-500">
          Official signup and access-token settings are below.
        </span>
      </div>
      <div className="mt-5 rounded-2xl border border-sun/50 bg-sun/10 p-4 text-sm text-stone-800">
        <p className="flex items-center gap-2.5 font-semibold text-ink">
          <ShieldAlert className="box-content size-4 shrink-0 -rotate-6 rounded-lg bg-sun p-1 text-ink shadow-[0_6px_12px_-6px_rgb(245_183_31/0.9)]" />
          Unofficial linked-device connection
        </p>
        <p className="mt-2 leading-relaxed">
          This links the restaurant’s WhatsApp to Orderly with an unofficial method that is against
          WhatsApp’s terms. WhatsApp can ban the whole number, temporarily or permanently, and the
          restaurant’s own WhatsApp app on that number stops working too. Messages are decrypted and
          processed on Orderly’s gateway server (Railway), and sent replies are kept there,
          encrypted, for up to 3 days.
        </p>
        <p className="mt-2 leading-relaxed">
          The supported route is the official WhatsApp Business Platform below. Its coexistence
          option keeps the WhatsApp Business app working. Use the linked device only with a
          restaurant-owned number and its owner’s permission. No cold broadcasts.
        </p>
      </div>
      {!enabled && (
        <p className="mt-4 text-sm text-stone-600">
          The self-hosted gateway has not been enabled. Your administrator must deploy it on a
          persistent server before pairing is available. Official Meta setup remains available.
        </p>
      )}
      {enabled && (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            <label
              className={
                method === 'qr'
                  ? 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-ink bg-ink px-4 text-[13px] font-semibold text-cream shadow-[0_8px_18px_-8px_rgb(14_6_4/0.7)] transition-[background-color,border-color,color,box-shadow,scale] duration-200 active:scale-95'
                  : 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-ink/10 bg-white/70 px-4 text-[13px] font-semibold text-stone-700 transition-[background-color,border-color,color,box-shadow,scale] duration-200 hover:border-ink/25 hover:bg-white hover:text-ink active:scale-95'
              }
            >
              <input
                className="accent-brand-500"
                type="radio"
                name="pairing-method"
                checked={method === 'qr'}
                onChange={() => setMethod('qr')}
              />{' '}
              Scan QR
            </label>
            <label
              className={
                method === 'code'
                  ? 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-ink bg-ink px-4 text-[13px] font-semibold text-cream shadow-[0_8px_18px_-8px_rgb(14_6_4/0.7)] transition-[background-color,border-color,color,box-shadow,scale] duration-200 active:scale-95'
                  : 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-ink/10 bg-white/70 px-4 text-[13px] font-semibold text-stone-700 transition-[background-color,border-color,color,box-shadow,scale] duration-200 hover:border-ink/25 hover:bg-white hover:text-ink active:scale-95'
              }
            >
              <input
                className="accent-brand-500"
                type="radio"
                name="pairing-method"
                checked={method === 'code'}
                onChange={() => setMethod('code')}
              />{' '}
              Link with phone number
            </label>
          </div>
          {method === 'code' && (
            <div className="step-in mt-4">
              <Field
                label="WhatsApp number with country code"
                hint="For example +92 300 1234567. Confirm linking inside the WhatsApp app."
              >
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-ink/[0.06] bg-paper px-4 py-3 text-sm leading-6 transition-colors has-[:checked]:border-brand-500/25 has-[:checked]:bg-brand-50">
            <input
              className="mt-1 size-4 shrink-0 accent-brand-500"
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I have the owner’s permission. I understand this unofficial connection is against
            WhatsApp’s terms, that WhatsApp can ban the whole number temporarily or permanently,
            including the restaurant’s own WhatsApp app, and that messages are processed on
            Orderly’s gateway server.
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={!accepted || !phoneValid}
              title={
                !accepted
                  ? 'Tick the permission box above first.'
                  : !phoneValid
                    ? 'Enter the WhatsApp number with its country code.'
                    : undefined
              }
              onClick={() => ask('pair')}
            >
              Start new pairing
            </button>
            {connection?.provider === 'baileys' && (
              <>
                <ActionButton
                  disabled={['logged_out', 'disconnected'].includes(state)}
                  title={
                    ['logged_out', 'disconnected'].includes(state)
                      ? 'This session ended. Start a new pairing instead.'
                      : undefined
                  }
                  loading={pending === 'reconnect'}
                  loadingLabel="Reconnecting…"
                  onClick={() => void run('reconnect')}
                >
                  <RefreshCw className="size-4" />
                  Reconnect
                </ActionButton>
                <button
                  className="btn text-red-700 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
                  onClick={() => ask('disconnect')}
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </>
      )}
      {connection?.provider === 'baileys' && (
        <div className="mt-5 rounded-2xl border border-ink/[0.06] bg-paper p-4" aria-live="polite">
          <p
            className={
              state === 'connected'
                ? 'text-sm font-semibold text-success-700'
                : 'text-sm font-semibold text-ink'
            }
          >
            Status: {state.replaceAll('_', ' ')}
            {connection.phoneNumber ? ` · ${connection.phoneNumber}` : ''}
          </p>
          {snapshot?.qr && (
            <img
              className="enter-pop mt-3 rounded-2xl bg-white p-2 shadow-[0_0_0_1px_rgb(14_6_4/0.06),0_24px_40px_-24px_rgb(14_6_4/0.45)]"
              src={snapshot.qr}
              width={280}
              height={280}
              alt="WhatsApp linking QR code. Open WhatsApp, Linked devices, Link a device."
            />
          )}
          {snapshot?.code && (
            <>
              <p className="enter-pop mt-3 inline-block max-w-full rounded-2xl bg-ink px-4 py-2 font-mono text-[26px] font-semibold tracking-widest break-all text-cream shadow-[0_10px_22px_-12px_rgb(14_6_4/0.7)] sm:text-3xl">
                {snapshot.code}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-stone-600">
                In WhatsApp, open Linked devices → Link a device → Link with phone number instead,
                and enter this code.
              </p>
            </>
          )}
          {state === 'connected' && (
            <p className="step-in mt-2 text-sm leading-relaxed text-stone-600">
              After the backend verifies this session, send a real test message before enabling
              Automatic replies. Pairing leaves automation paused.
            </p>
          )}
          {(snapshot?.errorCode || connection.errorCode) && (
            <p className="mt-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">
              Connection needs attention:{' '}
              {reason(snapshot?.errorCode || connection.errorCode || '')}. Try reconnecting, or
              start fresh pairing if logged out.
            </p>
          )}
        </div>
      )}
      {error && (
        <div className="mt-4">
          <ErrorNotice message={error} />
        </div>
      )}
      <ConfirmDialog
        busy={!!confirm && pending === confirm}
        busyLabel={
          confirm === 'disconnect'
            ? 'Disconnecting…'
            : confirm === 'pair'
              ? 'Starting…'
              : 'Switching…'
        }
        error={confirmError}
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(undefined)}
        title={
          confirm === 'pair'
            ? 'Start a new WhatsApp pairing?'
            : confirm === 'disconnect'
              ? 'Disconnect WhatsApp?'
              : 'Switch to official Meta?'
        }
        description="Automatic replies will pause. Pending messages and old chats will not be sent through the new connection. Existing orders and chat history will remain. Also remove the old Orderly session from WhatsApp’s Linked devices."
        confirmLabel={
          confirm === 'disconnect'
            ? 'Disconnect'
            : confirm === 'pair'
              ? 'Start pairing'
              : 'Switch to Meta'
        }
        onConfirm={() => {
          if (confirm) void run(confirm);
        }}
      />
    </section>
  );
}
