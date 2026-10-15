import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { Bootstrap } from '../shared/types';
import type { SupabaseClient } from '@supabase/supabase-js';
export type Page =
  | 'overview'
  | 'orders'
  | 'menu'
  | 'inbox'
  | 'playground'
  | 'bot'
  | 'flow'
  | 'activity'
  | 'security'
  | 'integrations'
  | 'settings'
  | 'businesses';
export type ToastTone = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}
export interface MutateOptions {
  /** Shown as a bottom-right notification once the change is saved. */
  success?: string;
  /** The caller reports a failure itself: no notification. */
  quiet?: boolean;
  /**
   * The failure shows inside the caller's dialog (notifications behind an open dialog are
   * hidden from screen readers). If no dialog is open any more, it is a notification.
   */
  dialog?: boolean;
}
/** Whether a dialog is open now, so a failure can be shown inside it. */
export function dialogOpen() {
  return (
    typeof document !== 'undefined' &&
    !!document.querySelector('[role="dialog"], [role="alertdialog"]')
  );
}
export interface WorkspaceContext {
  data: Bootstrap;
  /** True while any change is being saved. Only for pausing background refreshes. */
  busy: boolean;
  /** The last failed change, shown inside open dialogs. */
  error: string;
  clearError: () => void;
  page: Page;
  navigate: (page: Page, id?: string) => void;
  detailId?: string;
  auth?: SupabaseClient;
  switchCompany: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: ToastTone) => void;
  mutate: <T = unknown>(
    path: string,
    body?: unknown,
    method?: string,
    options?: MutateOptions,
  ) => Promise<T>;
}
export const Workspace = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const context = useContext(Workspace);
  if (!context) throw new Error('Workspace unavailable');
  return context;
}
/**
 * Tracks which of a section's actions is running, so only the pressed button shows a
 * spinner. While one runs, the section ignores further actions (a ref, because React
 * state updates too late to stop a double click); pressing a different button says why.
 * Resolves true once the work finished, false when it was skipped. Errors still reach
 * the caller.
 */
export function useAction() {
  const workspace = useContext(Workspace);
  const notify = useRef(workspace?.notify);
  notify.current = workspace?.notify;
  const running = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState<string>();
  const run = useCallback(async (key: string, work: () => Promise<unknown>) => {
    if (running.current !== undefined) {
      if (running.current !== key)
        notify.current?.('Still finishing your last action. Try again in a moment.', 'info');
      return false;
    }
    running.current = key;
    setPending(key);
    try {
      await work();
      return true;
    } finally {
      running.current = undefined;
      setPending(undefined);
    }
  }, []);
  return { pending, run };
}
