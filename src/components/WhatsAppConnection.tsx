import { useEffect, useState } from 'react';
import { RefreshCw, Smartphone, ShieldAlert } from 'lucide-react';
import type { WhatsAppConnection as Connection } from '../shared/whatsapp';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { Field, ConfirmDialog } from './ui';

type Snapshot = {
  status: Connection['status'];
  qr?: string;
  code?: string;
  expiresAt?: string;
  errorCode?: string;
};
export function WhatsAppConnection() {
  const { data, refresh } = useWorkspace();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [method, setMethod] = useState<'qr' | 'code'>('qr');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'pair' | 'disconnect' | 'select-meta'>();
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
  const run = async (action: 'pair' | 'disconnect' | 'select-meta' | 'reconnect') => {
    setBusy(true);
    setError('');
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
      const result = await api<{ enabled: boolean; connection: Connection | null }>(
        '/whatsapp/connection',
        companyId,
      );
      setConnection(result.connection);
      setEnabled(result.enabled);
      setConfirm(undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      setConfirm(undefined);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit) return null;
  const state = snapshot?.status ?? connection?.status ?? 'disconnected';
  return (
    <section className="card mb-6 p-6">
      <div className="flex items-center gap-3">
        <Smartphone className="size-5 text-brand-500" />
        <h2 className="panel-title">WhatsApp connection method</h2>
      </div>
      <p className="mt-3 text-sm text-stone-600">
        Active route:{' '}
        {connection?.provider === 'baileys'
          ? 'Orderly linked device · unofficial'
          : 'Official Meta Cloud API'}
        . Both use your published bot, menu and orders.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="btn"
          disabled={
            busy ||
            !connection ||
            (connection.provider === 'meta' && connection.status !== 'disconnected')
          }
          onClick={() => setConfirm('select-meta')}
        >
          Use official Meta route
        </button>
        <span className="self-center text-xs text-stone-500">
          Official signup and access-token settings are below.
        </span>
      </div>
      <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="flex items-center gap-2 font-medium">
          <ShieldAlert className="size-4" />
          Unofficial linked-device connection
        </p>
        <p className="mt-2">
          Not approved by Meta. WhatsApp can disconnect or restrict the account. No ban-free
          guarantee. Use only a restaurant-owned number with its owner’s permission. No cold
          broadcasts.
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
          <div className="mt-5 flex gap-4">
            <label>
              <input
                type="radio"
                name="pairing-method"
                checked={method === 'qr'}
                onChange={() => setMethod('qr')}
              />{' '}
              Scan QR
            </label>
            <label>
              <input
                type="radio"
                name="pairing-method"
                checked={method === 'code'}
                onChange={() => setMethod('code')}
              />{' '}
              Link with phone number
            </label>
          </div>
          {method === 'code' && (
            <div className="mt-4">
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
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I have the owner’s permission and accept the unofficial connection risks.
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={
                busy ||
                !accepted ||
                (method === 'code' && !/^[1-9]\d{5,14}$/.test(phone.replace(/\D/g, '')))
              }
              onClick={() => setConfirm('pair')}
            >
              Start new pairing
            </button>
            {connection?.provider === 'baileys' && (
              <>
                <button
                  className="btn"
                  disabled={busy || ['logged_out', 'disconnected'].includes(state)}
                  onClick={() => void run('reconnect')}
                >
                  <RefreshCw className="size-4" />
                  Reconnect
                </button>
                <button className="btn" disabled={busy} onClick={() => setConfirm('disconnect')}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        </>
      )}
      {connection?.provider === 'baileys' && (
        <div className="mt-5" aria-live="polite">
          <p className="text-sm">
            Status: {state.replaceAll('_', ' ')}
            {connection.phoneNumber ? ` · ${connection.phoneNumber}` : ''}
          </p>
          {snapshot?.qr && (
            <img
              className="mt-3 rounded-lg"
              src={snapshot.qr}
              width={280}
              height={280}
              alt="WhatsApp linking QR code. Open WhatsApp, Linked devices, Link a device."
            />
          )}
          {snapshot?.code && (
            <>
              <p className="mt-3 font-mono text-3xl tracking-widest">{snapshot.code}</p>
              <p className="mt-2 text-sm">
                In WhatsApp, open Linked devices → Link a device → Link with phone number instead,
                and enter this code.
              </p>
            </>
          )}
          {state === 'connected' && (
            <p className="mt-2 text-sm">
              After the backend verifies this session, send a real test message before enabling
              Automatic replies. Pairing leaves automation paused.
            </p>
          )}
          {(snapshot?.errorCode || connection.errorCode) && (
            <p className="mt-2 text-sm text-red-700">
              Connection needs attention: {snapshot?.errorCode || connection.errorCode}. Try
              reconnecting, or start fresh pairing if logged out.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      <ConfirmDialog
        busy={busy}
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
        confirmLabel="Confirm"
        onConfirm={() => {
          if (confirm) void run(confirm);
        }}
      />
    </section>
  );
}
