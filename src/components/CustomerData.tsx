import { useState } from 'react';
import type { Conversation } from '../shared/types';
import { api, ApiError } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { ActionButton, ConfirmDialog } from './ui';
import { download, erasedMessage, exportedMessage, NO_CHAT_RECORDS } from './Operations';

/** Everything Orderly holds for the customer of one chat, as a file. */
export const customerExportPath = (conversationId: string) =>
  `/privacy/customer?conversationId=${encodeURIComponent(conversationId)}`;
/** Deleting the customer of one chat. The server needs the outside copies acknowledged. */
export const eraseChatRequest = (conversationId: string) => ({
  conversationId,
  externalCopiesAcknowledged: true as const,
});
export const ERASE_CHAT_DESCRIPTION =
  'This permanently removes this chat, the customer’s other chats with this business and their orders from Orderly’s active database. Copies outside Orderly stay: rows in your Google Sheet, the messages in WhatsApp on the customer’s and the restaurant’s phones, downloaded exports and AI provider records. Remove the ones you control yourself. Orderly’s encrypted backups expire on their own.';
export const ERASE_CHAT_ACK =
  'I have verified this request and will handle the copies in Google Sheets, WhatsApp and downloaded exports myself.';

/**
 * Export or delete one customer's data from their chat, also for a chat where WhatsApp never
 * shared the number (a privacy ID). Owners and admins only, as on the server.
 */
export function CustomerDataActions({
  conversation,
  onErased,
}: {
  conversation: Pick<Conversation, 'id'>;
  /** The chat's customer was deleted: the chat is gone. */
  onErased: (conversationId: string) => void;
}) {
  const { data, mutate, notify } = useWorkspace();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  if (data.role === 'staff') return null;
  const id = conversation.id;
  const paused = !data.company.botEnabled;
  const exportData = () =>
    void run('export', async () => {
      let found: { conversations: unknown[]; orders: unknown[] };
      try {
        found = await api<typeof found>(customerExportPath(id), data.company.id);
      } catch (e) {
        // "No records found for this chat" (404) is a note, not a failure.
        notify((e as Error).message, e instanceof ApiError && e.status === 404 ? 'info' : 'error');
        return;
      }
      download('orderly-customer-export.json', found);
      notify(exportedMessage(found.conversations.length, found.orders.length));
    });
  const erase = () => {
    setError('');
    void run('erase', async () => {
      try {
        const r = await mutate<{ deleted: number }>(
          '/privacy/erase',
          eraseChatRequest(id),
          undefined,
          { dialog: true },
        );
        setOpen(false);
        // Older servers answer 0 instead of 404 when nothing was there to remove.
        if (r.deleted) notify(erasedMessage(r.deleted));
        else notify(NO_CHAT_RECORDS, 'info');
        onErased(id);
      } catch (e) {
        // Also "No records found…" (404) and running work (409): the dialog shows them.
        setError((e as Error).message);
      }
    });
  };
  return (
    <>
      <ActionButton
        className="btn-quiet"
        loading={pending === 'export'}
        loadingLabel="Preparing export…"
        onClick={exportData}
      >
        Export this customer’s data
      </ActionButton>
      <button
        className="btn btn-quiet text-red-700 hover:bg-red-50 hover:text-red-800"
        disabled={!paused}
        title={paused ? undefined : 'Pause automation in Bot settings first.'}
        onClick={() => {
          setAck(false);
          setError('');
          setOpen(true);
        }}
      >
        Delete this customer’s data
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setError('');
        }}
        title="Delete this customer’s data?"
        description={ERASE_CHAT_DESCRIPTION}
        confirmLabel="Delete customer data"
        busy={pending === 'erase'}
        busyLabel="Deleting…"
        error={error}
        confirmDisabled={!ack}
        confirmTitle="Tick the confirmation above first."
        onConfirm={erase}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white bg-white/50 p-3.5 text-sm leading-6 transition-colors hover:bg-white/80 has-checked:border-brand-500/35 has-checked:bg-brand-500/[0.07]">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-brand-500 transition-transform active:scale-90"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>{ERASE_CHAT_ACK}</span>
        </label>
      </ConfirmDialog>
    </>
  );
}
