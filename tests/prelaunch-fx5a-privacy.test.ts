// FX-5a (2): owners export or delete a customer's data from their chat in the Inbox, also for a
// chat where WhatsApp never shared the number (a privacy ID), through the conversationId routes.
// The dashboard's API client is answered by the local demo server: no network.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Radix draws dialogs into a portal, which server rendering skips: draw them in place.
vi.mock('@radix-ui/react-alert-dialog', async () => {
  const { createElement } = await import('react');
  type Props = { children?: ReactNode; className?: string };
  const tag =
    (name: string) =>
    ({ children, className }: Props) =>
      createElement(name, { className }, children);
  return {
    Root: ({ open, children }: Props & { open?: boolean }) => (open ? children : null),
    Portal: ({ children }: Props) => children,
    Overlay: tag('div'),
    Content: tag('div'),
    Title: tag('h2'),
    Description: tag('p'),
    Cancel: tag('button'),
  };
});
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { api, ApiError } from '../src/lib/api';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import {
  CustomerDataActions,
  customerExportPath,
  ERASE_CHAT_ACK,
  ERASE_CHAT_DESCRIPTION,
  eraseChatRequest,
} from '../src/components/CustomerData';
import { erasedMessage, exportedMessage, NO_CHAT_RECORDS } from '../src/components/Operations';
import { ConfirmDialog } from '../src/components/ui';
import { createConversation } from '../src/domain/engine';
import type { Bootstrap, Conversation, Role } from '../src/shared/types';
import { company, demoApp, minutesAgo } from './helpers/demo-app';
import { bootstrap } from './prelaunch-e-helpers';

const app = demoApp();
const repo = () => app.repo();
const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

function serve() {
  vi.stubEnv('VITE_API_BASE_URL', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) =>
      createApp(repo()).request(`http://127.0.0.1:4000${url}`, init),
    ),
  );
}
// A WhatsApp chat known only by its privacy ID: no number.
async function privacyIdChat(peer: string, generation = 1) {
  const connectionId = '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d';
  const chat: Conversation = {
    ...createConversation(
      company.id,
      `${connectionId}:${generation}:${peer}`,
      'whatsapp',
      minutesAgo(30),
    ),
    customerPhone: '',
    whatsappAddress: { connectionId, generation, provider: 'baileys', peer },
    messages: [{ id: randomUUID(), role: 'customer', text: 'hi', createdAt: minutesAgo(30) }],
    version: 1,
  };
  expect(await repo().saveConversation(chat, 0)).toBe(true);
  return chat;
}
const renderActions = (role: Role, botEnabled = false) => {
  const data: Bootstrap = bootstrap({ role, company: { ...company, botEnabled } });
  const value: WorkspaceContext = {
    data,
    busy: false,
    error: '',
    clearError: () => {},
    page: 'inbox',
    navigate: () => {},
    switchCompany: () => {},
    refresh: async () => {},
    notify: () => {},
    mutate: async <T>() => ({}) as T,
  };
  return renderToStaticMarkup(
    createElement(
      Workspace.Provider,
      { value },
      createElement(CustomerDataActions, { conversation: { id: 'chat-1' }, onErased: () => {} }),
    ),
  );
};

describe('FX-5a: customer data from the Inbox chat', () => {
  it('offers export and deletion to owners and admins, never to staff', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = renderActions(role);
      expect(html).toContain('Export this customer’s data');
      expect(html).toMatch(
        /<button class="btn btn-quiet text-red-700[^"]*">Delete this customer’s data/,
      );
    }
    expect(renderActions('staff')).toBe('');
    // Deleting waits for automation to be paused, as on the server; exporting does not.
    const live = renderActions('owner', true);
    expect(live).toMatch(
      /<button[^>]*disabled=""[^>]*title="Pause automation in Bot settings first\."[^>]*>Delete this customer’s data/,
    );
    expect(live).not.toMatch(/disabled=""[^>]*>Export this customer’s data/);
  });

  it('asks for the acknowledgement in a danger confirmation that names the copies that stay', () => {
    expect(ERASE_CHAT_DESCRIPTION).toMatch(/permanently removes this chat/);
    expect(ERASE_CHAT_DESCRIPTION).toMatch(
      /Copies outside Orderly stay: rows in your Google Sheet, the messages in WhatsApp/,
    );
    const dialog = (confirmDisabled: boolean) =>
      renderToStaticMarkup(
        createElement(
          ConfirmDialog,
          {
            open: true,
            onOpenChange: () => {},
            title: 'Delete this customer’s data?',
            description: ERASE_CHAT_DESCRIPTION,
            confirmLabel: 'Delete customer data',
            confirmDisabled,
            confirmTitle: 'Tick the confirmation above first.',
            onConfirm: () => {},
          },
          createElement('label', null, ERASE_CHAT_ACK),
        ),
      );
    const unticked = dialog(true);
    expect(unticked).toContain(ERASE_CHAT_ACK);
    expect(unticked).toContain('bg-red-700');
    expect(unticked).toMatch(
      /<button[^>]*disabled=""[^>]*title="Tick the confirmation above first\."[^>]*>Delete customer data/,
    );
    expect(dialog(false)).not.toContain('Tick the confirmation above first.');
    const page = source('src/components/CustomerData.tsx');
    expect(page).toContain('confirmDisabled={!ack}');
    expect(page).not.toContain('tone="primary"');
    expect(page).toContain('<span>{ERASE_CHAT_ACK}</span>');
  });

  it('exports and deletes a chat with no number, with the real counts or the server’s words', async () => {
    serve();
    await repo().saveCompany({ ...company, botEnabled: false });
    const target = await privacyIdChat('100000021@lid');
    // The same person after the linked phone reconnected.
    await privacyIdChat('100000021@lid', 2);
    const other = await privacyIdChat('100000022@lid');
    expect(customerExportPath(target.id)).toBe(
      `/privacy/customer?conversationId=${encodeURIComponent(target.id)}`,
    );
    const found = await api<{ conversations: Conversation[]; orders: unknown[] }>(
      customerExportPath(target.id),
      company.id,
    );
    expect(found.conversations).toHaveLength(2);
    expect(exportedMessage(found.conversations.length, found.orders.length)).toBe(
      'Customer export downloaded: 2 conversations and 0 orders.',
    );
    expect(exportedMessage(1, 1)).toBe('Customer export downloaded: 1 conversation and 1 order.');
    expect(eraseChatRequest(target.id)).toEqual({
      conversationId: target.id,
      externalCopiesAcknowledged: true,
    });
    const r = await api<{ deleted: number }>(
      '/privacy/erase',
      company.id,
      eraseChatRequest(target.id),
    );
    expect(r).toEqual({ deleted: 2 });
    expect(erasedMessage(r.deleted)).toBe(
      'Removed 2 conversations and their orders from Orderly’s active database.',
    );
    expect(await repo().getConversation(company.id, other.id)).toBeDefined();
    // Asked again: the server's 404 words, for both actions.
    for (const again of [
      api('/privacy/erase', company.id, eraseChatRequest(target.id)),
      api(customerExportPath(target.id), company.id),
    ]) {
      const error = (await again.catch((e: unknown) => e)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(404);
      expect(error.message).toBe(NO_CHAT_RECORDS);
    }
    // With automation on, the server refuses, and the dialog shows its words.
    await repo().saveCompany({ ...company, botEnabled: true });
    await expect(
      api('/privacy/erase', company.id, eraseChatRequest(other.id)),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Pause automation and wait for running work before deleting customer data.',
    });
  });

  it('sits in the open chat’s header and goes back to the list once the chat is gone', () => {
    const inbox = source('src/components/Inbox.tsx');
    expect(inbox).toMatch(
      /<CustomerDataActions\s+key=\{conversation\.id\}\s+conversation=\{conversation\}/,
    );
    expect(inbox).toContain(
      "if (shown.current === id) navigate('inbox', undefined, { keepScroll: true });",
    );
    const page = source('src/components/CustomerData.tsx');
    // A 404 while exporting is a note, not a failure; the deletion keeps the dialog open on one.
    expect(page).toContain("e instanceof ApiError && e.status === 404 ? 'info' : 'error'");
    expect(page).toMatch(/\{ dialog: true \},\s*\);\s*setOpen\(false\);/);
  });
});
