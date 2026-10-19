import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Smartphone, ShieldAlert, X } from 'lucide-react';
import type { WhatsAppConnection as Connection } from '../shared/whatsapp';
import { api, ApiError } from '../lib/api';
import { dialogOpen, useAction, useWorkspace } from '../lib/workspace';
import { cn } from '../lib/utils';
import { ActionButton, ConfirmDialog, ErrorNotice, Field } from './ui';

/**
 * The linked-phone risk notice shown on this page (the box and the tick below it). Sent with
 * each pairing and recorded by the server, so it must change whenever that text does; the
 * server refuses a pairing from a page showing an older notice.
 */
export const LINKED_RISK_NOTICE_VERSION = 'linked-device-risk-2026-10-18';
/** The same risk, in short, for the pairing confirmation. */
export const LINKED_RISK_SUMMARY =
  'This unofficial connection is against WhatsApp’s terms. WhatsApp can ban the whole number, temporarily or permanently, including the restaurant’s own WhatsApp app. Messages are decrypted on Orderly’s gateway server, and sent replies are kept there, encrypted, for up to 3 days.';
/** What GET /whatsapp/connection says about linked-phone pairing for this business. */
export type PairingAccess = {
  /** A new pairing can start here: the gateway runs and pairing is allowed. */
  enabled: boolean;
  /** Missing from servers older than the per-business approval. */
  gatewayEnabled?: boolean;
  pairingAllowed?: boolean;
  /**
   * The existing linked phone can be managed (status, reconnect), approved or not. Missing from
   * servers that do not send it: the gateway being on is then what counts.
   */
  manageable?: boolean;
};
/**
 * Which linked-phone controls show. Only a new pairing needs the admin's approval: an existing
 * linked phone can always be disconnected, and reconnected (and its status checked) while the
 * gateway runs, even after the approval was withdrawn (server/whatsapp/routes.ts).
 */
export function linkedControls(
  access: PairingAccess | undefined,
  connection: Pick<Connection, 'provider'> | null,
) {
  const linked = connection?.provider === 'baileys';
  const gateway = access?.manageable ?? access?.gatewayEnabled ?? !!access?.enabled;
  return {
    pair: !!access?.enabled,
    reconnect: linked && gateway,
    disconnect: linked,
    poll: linked && gateway,
  };
}
/** Why pairing can't start here, in words for the owner. */
export function pairingUnavailable(access: PairingAccess) {
  if (access.gatewayEnabled === false)
    return 'Linked-phone pairing is switched off on this Orderly server. The official WhatsApp Business Platform below is the supported route.';
  if (access.pairingAllowed === false)
    return 'Linked-phone pairing needs approval from Orderly support for this business. The official WhatsApp Business Platform below is the supported route and needs no approval.';
  return 'Linked-phone pairing is not available for this business. It needs approval from Orderly support. The official WhatsApp Business Platform below is the supported route.';
}
/** A new pairing, with the consent to the risk notice on this page. */
export function pairRequest(method: 'qr' | 'code', phone: string, accepted: boolean) {
  return {
    method,
    ...(method === 'code' ? { phone: phone.replace(/\D/g, '') } : {}),
    riskAccepted: accepted,
    switchConfirmed: true,
    ...(accepted && { consent: { version: LINKED_RISK_NOTICE_VERSION, accepted: true } }),
  };
}
/**
 * When to ask for the pairing status again: every 5 seconds while a QR code, a code or a
 * reconnect is in progress, otherwise not at all (the stored status is enough). Undefined: stop.
 */
export function pairingPollDelay(status?: Connection['status']) {
  return status === 'connecting' || status === 'awaiting_pairing' || status === 'reconnecting'
    ? 5000
    : undefined;
}
/** Seconds to wait after "too many checks" (429), when the server's wait can't be read. */
const STATUS_BACKOFF_S = 60;
/**
 * What the owner should do about the connection's state, if anything. `canPair` is false where
 * this business can't start a new pairing here, so the advice never sends the owner to a
 * button that isn't shown.
 */
export function connectionAdvice(state: Connection['status'], errorCode?: string, canPair = true) {
  if (errorCode === 'INBOUND_EVENT_REJECTED')
    return 'A customer message could not be passed to Orderly. Check the restaurant phone for it and reply there; reconnecting does not help.';
  if (errorCode === 'DISCONNECT_405')
    return `WhatsApp refused the gateway’s WhatsApp version. The Orderly platform admin must update the gateway (GATEWAY_WA_VERSION); then ${canPair ? 'start a new pairing' : 'contact Orderly support to pair the phone again'}.`;
  if (state === 'reconnecting')
    return 'The gateway is reconnecting to WhatsApp by itself. This usually takes a minute; there is nothing to do yet.';
  if (errorCode)
    return canPair
      ? 'Try reconnecting, or start a new pairing if WhatsApp logged this device out.'
      : 'Try reconnecting. If WhatsApp logged this device out, contact Orderly support to pair it again.';
}
/** Gateway problems with one thing to do, said in full instead of "needs attention". */
export const GATEWAY_PROBLEMS: Record<string, string> = {
  PAIRING_EXPIRED: 'The pairing code expired. Start pairing again.',
  SESSION_CAPACITY_REACHED:
    'Orderly’s linked-phone service is full right now. Contact Orderly support.',
};
/** An unfinished pairing that ended where a new one can't start here (no approval, or no gateway). */
export const PAIRING_ENDED =
  'This pairing ended before it finished. A new pairing isn’t available for this business: contact Orderly support, or use the official WhatsApp Business Platform below.';
/** A failed request's words, or the plain words for a gateway code it carries. */
export function gatewayMessage(e: unknown, fallback: string, canPair = true) {
  if (!canPair && e instanceof ApiError && e.code === 'PAIRING_EXPIRED') return PAIRING_ENDED;
  if (e instanceof ApiError && e.code && GATEWAY_PROBLEMS[e.code]) return GATEWAY_PROBLEMS[e.code]!;
  return e instanceof Error ? e.message : fallback;
}
/** What the status box says about a connection problem. */
export function connectionProblem(state: Connection['status'], errorCode: string, canPair = true) {
  if (!canPair && errorCode === 'PAIRING_EXPIRED') return PAIRING_ENDED;
  return (
    GATEWAY_PROBLEMS[errorCode] ??
    `Connection needs attention: ${reason(errorCode)}. ${connectionAdvice(state, errorCode, canPair) ?? ''}`.trim()
  );
}
/** Said when a switch or disconnect could not end the old linked-phone session itself. */
export const LINKED_CLEANUP =
  'Also remove Orderly under WhatsApp → Linked devices on the restaurant phone: the old session could not be ended from here.';
/** The cleanup step, kept on screen until the owner dismisses it. */
export function LinkedCleanupNote({
  onDismiss,
  className = 'mt-4',
}: {
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'step-in flex items-start gap-2.5 rounded-2xl border border-sun/50 bg-sun/10 p-4 text-sm leading-relaxed text-stone-800',
        className,
      )}
    >
      <p className="min-w-0 flex-1 font-medium">{LINKED_CLEANUP}</p>
      <button
        type="button"
        className="-m-1 rounded-full p-1 text-stone-500 transition-[color,scale] duration-200 hover:text-ink active:scale-90"
        aria-label="Dismiss note"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Start new pairing, Reconnect and Disconnect, each only where linkedControls allows it. */
export function LinkedPhoneActions({
  controls,
  state,
  pending,
  startDisabled,
  startTitle,
  onStart,
  onReconnect,
  onDisconnect,
}: {
  controls: ReturnType<typeof linkedControls>;
  state: Connection['status'];
  pending?: string;
  startDisabled: boolean;
  startTitle?: string;
  onStart: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  if (!controls.pair && !controls.disconnect) return null;
  const ended = ['logged_out', 'disconnected'].includes(state);
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {controls.pair && (
        <button
          className="btn btn-primary"
          disabled={startDisabled}
          title={startTitle}
          onClick={onStart}
        >
          Start new pairing
        </button>
      )}
      {controls.reconnect && (
        <ActionButton
          disabled={ended}
          title={
            ended
              ? `This session ended.${controls.pair ? ' Start a new pairing instead.' : ''}`
              : undefined
          }
          loading={pending === 'reconnect'}
          loadingLabel="Reconnecting…"
          onClick={onReconnect}
        >
          <RefreshCw className="size-4" />
          Reconnect
        </ActionButton>
      )}
      {controls.disconnect && (
        <button
          className="btn text-red-700 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

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
  INBOUND_EVENT_REJECTED: 'a customer message did not reach Orderly',
};
const reason = (code: string) =>
  REASONS[code] ??
  (code.startsWith('DISCONNECT_') ? `WhatsApp closed the connection (${code})` : code);
const PROBLEM_BOX = 'mt-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700';
export function WhatsAppConnection() {
  const { data, refresh, notify } = useWorkspace();
  const act = useAction();
  const pending = act.pending;
  const [connection, setConnection] = useState<Connection | null>(null);
  // Undefined until the connection has loaded.
  const [access, setAccess] = useState<PairingAccess>();
  const enabled = !!access?.enabled;
  const controls = linkedControls(access, connection);
  // Bumped after each action, so the status is checked again even if the saved one is unchanged
  // (a reconnect from 'error' reports its progress only through the status check).
  const [checks, setChecks] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [method, setMethod] = useState<'qr' | 'code'>('qr');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  // The old linked session still needs removing on the phone (gatewayCleanupPending).
  const [cleanup, setCleanup] = useState(false);
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
  const loadConnection = () =>
    api<PairingAccess & { connection: Connection | null }>('/whatsapp/connection', companyId);
  const showConnection = ({
    connection,
    ...result
  }: Awaited<ReturnType<typeof loadConnection>>) => {
    setAccess({
      enabled: result.enabled,
      gatewayEnabled: result.gatewayEnabled,
      pairingAllowed: result.pairingAllowed,
      manageable: result.manageable,
    });
    setConnection(connection);
  };
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    setConnection(null);
    setAccess(undefined);
    setSnapshot(undefined);
    setError('');
    setAccepted(false);
    setCleanup(false);
    void loadConnection()
      .then((result) => {
        if (active) showConnection(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [companyId, canEdit]);
  // One check when the page opens or the status changes, then every 5 seconds only while a
  // pairing or reconnect is in progress and this tab is on screen. An existing linked phone is
  // checked whether or not a new pairing is allowed.
  useEffect(() => {
    if (
      !controls.poll ||
      connection?.provider !== 'baileys' ||
      ['disconnected', 'logged_out'].includes(connection.status)
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    // Set when a check was skipped in a background tab: the tab being shown again checks at once.
    let waiting = false;
    // Failed checks in a row: after a few, ask once a minute instead of every 5 seconds.
    let failures = 0;
    let status: Connection['status'] = connection.status;
    const poll = async () => {
      if (document.hidden) {
        waiting = true;
        return;
      }
      let delay: number | undefined;
      try {
        const result = await api<{ connection: Connection; snapshot: Snapshot }>(
          '/whatsapp/pairing-status',
          companyId,
          {},
        );
        if (!active) return;
        failures = 0;
        setConnection(result.connection);
        setSnapshot(result.snapshot);
        setError('');
        status = result.snapshot?.status ?? result.connection.status;
        delay = pairingPollDelay(status);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && e.status === 429) {
          // Too many checks (every open tab counts): keep what is shown and wait.
          delay = (e.retryAfter ?? STATUS_BACKOFF_S) * 1000;
        } else {
          setSnapshot(undefined);
          setError(gatewayMessage(e, 'Connection unavailable.', enabled));
          failures++;
          // 409: no linked phone any more (switched in another tab); asking again won't help.
          delay =
            e instanceof ApiError && e.status === 409
              ? undefined
              : failures >= 3 && pairingPollDelay(status)
                ? STATUS_BACKOFF_S * 1000
                : pairingPollDelay(status);
        }
      }
      if (active && delay !== undefined) timer = setTimeout(() => void poll(), delay);
    };
    const shown = () => {
      if (document.hidden || !waiting) return;
      waiting = false;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener('visibilitychange', shown);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [
    companyId,
    controls.poll,
    enabled,
    connection?.id,
    connection?.generation,
    connection?.provider,
    connection?.status,
    checks,
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
      let result: { gatewayCleanupPending?: boolean } | undefined;
      try {
        result = await api(
          `/whatsapp/${action}`,
          companyId,
          action === 'pair'
            ? pairRequest(method, phone, accepted)
            : action === 'reconnect'
              ? {}
              : { confirmed: true },
        );
      } catch (e) {
        const message = gatewayMessage(e, 'Connection failed.', enabled);
        // Its confirmation shows the failure while still open for this action. Reconnect
        // has none, and a confirmation closed meanwhile can't, so those show below (and
        // as a notification).
        if (action !== 'reconnect' && asked.current === action && dialogOpen())
          setConfirmError(message);
        else {
          setError(message);
          if (action !== 'reconnect') notify(message, 'error');
        }
        // A failed pairing can leave the official route restored: show what is saved now.
        if (action === 'pair')
          void loadConnection()
            .then(showConnection)
            .catch(() => undefined);
        return;
      }
      // Only close the confirmation if it still belongs to this action.
      setConfirm((current) => (current === action ? undefined : current));
      notify(DONE[action], action === 'reconnect' ? 'info' : 'success');
      // The switch is saved, but the old linked session could not be ended from here: the
      // owner removes it on the phone. Kept on screen, since a notification goes away.
      if (result?.gatewayCleanupPending) setCleanup(true);
      // The change is saved, so a failed reload only delays the new status.
      try {
        showConnection(await loadConnection());
        setChecks((n) => n + 1);
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
      {access && !enabled && (
        <p className="mt-4 text-sm text-stone-600">{pairingUnavailable(access)}</p>
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
        </>
      )}
      {/* Reconnect and Disconnect stay for an existing linked phone without pairing approval. */}
      <LinkedPhoneActions
        controls={controls}
        state={state}
        pending={pending}
        startDisabled={!accepted || !phoneValid}
        startTitle={
          !accepted
            ? 'Tick the permission box above first.'
            : !phoneValid
              ? 'Enter the WhatsApp number with its country code.'
              : undefined
        }
        onStart={() => ask('pair')}
        onReconnect={() => void run('reconnect')}
        onDisconnect={() => ask('disconnect')}
      />
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
            <>
              <p className="step-in mt-2 text-sm leading-relaxed text-stone-600">
                After the backend verifies this session, send a real test message before enabling
                Automatic replies. Pairing leaves automation paused.
              </p>
              <p className="step-in mt-2 text-sm leading-relaxed text-stone-600">
                While this phone is linked, turn off the WhatsApp Business app’s greeting and away
                messages. Orderly reads them as a staff reply and stops the bot for that chat.
              </p>
            </>
          )}
          {state === 'reconnecting' && !(snapshot?.errorCode || connection.errorCode) && (
            <p className="step-in mt-2 text-sm leading-relaxed text-stone-600">
              {connectionAdvice(state)}
            </p>
          )}
          {(snapshot?.errorCode || connection.errorCode) &&
            // Where no new pairing can start, the advice never says to start one.
            (enabled ? (
              <p className={PROBLEM_BOX}>
                {connectionProblem(state, snapshot?.errorCode || connection.errorCode || '')}
              </p>
            ) : (
              <p className={PROBLEM_BOX}>
                {connectionProblem(state, snapshot?.errorCode || connection.errorCode || '', false)}
              </p>
            ))}
        </div>
      )}
      {cleanup && <LinkedCleanupNote onDismiss={() => setCleanup(false)} />}
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
        description={`${confirm === 'pair' ? `${LINKED_RISK_SUMMARY} ` : ''}Automatic replies will pause. Pending messages and old chats will not be sent through the new connection. Existing orders and chat history will remain. Also remove the old Orderly session from WhatsApp’s Linked devices.`}
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
