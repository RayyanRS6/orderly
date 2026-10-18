import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Workspace, type Toast, type ToastAction } from '../lib/workspace';
import type { ReadinessCheck } from '../shared/types';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Info, X } from 'lucide-react';
import { cn, label } from '../lib/utils';
import { ActionButton, Badge, CustomSelect, ErrorNotice } from './ui-basic';
export {
  ActionButton,
  Badge,
  CustomSelect,
  ErrorNotice,
  Field,
  Spinner,
  type SelectOption,
} from './ui-basic';

/**
 * A time of day such as “4:00 pm” in this browser’s time zone, for “back at …” notes.
 * The space before am/pm never breaks, so the time stays on one line.
 */
export function clockTime(value?: string | number | Date | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
/** For a dialog's onInteractOutside: dismissing a notification must not close the dialog. */
export function keepOpenForToasts(event: { target: EventTarget | null; preventDefault(): void }) {
  if ((event.target as Element | null)?.closest?.('[data-toaster]')) event.preventDefault();
}
/**
 * Our dialogs open from state, not a Radix Trigger, so Radix has nowhere to send focus when
 * they close and it lands on <body>. This remembers what had focus when the dialog opened
 * and returns there (when it still exists).
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus: (event: Event) => {
      // The opener can be gone (a confirmed action removed its button): fall back to the
      // dialog still open underneath, if any, rather than <body>.
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
      if (!target) return;
      event.preventDefault();
      target.focus();
    },
  };
}
/** Bottom-right notifications for saves and errors. */
export function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    // One lasting live region, so screen readers announce each new notification.
    <div
      data-toaster=""
      aria-live="polite"
      aria-label="Notifications"
      role="region"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[22rem]"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}
export function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = toast.tone === 'error' ? AlertCircle : toast.tone === 'info' ? Info : CheckCircle2;
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : undefined}
      className={cn(
        'glass-pop pointer-events-auto flex items-start gap-2.5 rounded-2xl px-4 py-3 text-[13px]',
        toast.tone === 'error'
          ? 'toast-fail text-red-800'
          : toast.tone === 'info'
            ? 'toast-ok text-stone-700'
            : 'toast-ok text-success-800',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'pop-spin mt-0.5 size-4 shrink-0 [--d:250ms]',
          toast.tone === 'error'
            ? 'text-red-600'
            : toast.tone === 'info'
              ? 'text-stone-500'
              : 'text-success-700',
        )}
      />
      {toast.action ? (
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-relaxed">{toast.message}</p>
          <ToastActionButton action={toast.action} />
        </div>
      ) : (
        <p className="min-w-0 flex-1 font-medium leading-relaxed">{toast.message}</p>
      )}
      <button
        type="button"
        className="-m-1 rounded-full p-1 opacity-60 transition-[opacity,scale] duration-200 hover:opacity-100 active:scale-90"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function ToastActionButton({ action }: { action: ToastAction }) {
  const [running, setRunning] = useState(false);
  return (
    <ActionButton
      className="mt-2"
      loading={running}
      loadingLabel={action.busyLabel ?? 'Working…'}
      onClick={async () => {
        setRunning(true);
        try {
          await action.run();
        } finally {
          setRunning(false);
        }
      }}
    >
      {action.label}
    </ActionButton>
  );
}

export function Status({ value }: { value: string }) {
  const tone = ['accepted', 'ready', 'completed', 'synced', 'connected', 'bot'].includes(value)
    ? 'green'
    : ['pending', 'preparing', 'configured', 'human', 'out_for_delivery'].includes(value)
      ? 'amber'
      : ['rejected', 'cancelled', 'failed', 'error'].includes(value)
        ? 'red'
        : 'neutral';
  return (
    <Badge tone={tone}>
      <span className="size-1.5 rounded-full bg-current shrink-0" />
      {label(value)}
    </Badge>
  );
}
export function Empty({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-5 py-14 text-center">
      <div className="bob mb-5 flex size-14 -rotate-6 items-center justify-center rounded-2xl bg-ink text-brand-500 shadow-[0_16px_30px_-14px_rgb(14_6_4/0.7)]">
        <Check className="pop-spin size-6 [--d:200ms]" />
      </div>
      <h3 className="panel-title text-[28px]">{title}</h3>
      <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-stone-500">{description}</p>
      {action && (
        <button className="btn btn-ink mt-6" onClick={onAction}>
          {action}
          <ArrowRight className="size-4" />
        </button>
      )}
    </div>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
  dismissable = true,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  /** false: a click on the dimmed backdrop doesn't close it (long forms). Escape and Close still do. */
  dismissable?: boolean;
}) {
  const workspace = useContext(Workspace);
  const clearError = useRef(workspace?.clearError);
  const errorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus();
  useEffect(() => {
    clearError.current = workspace?.clearError;
  });
  // A failure from an earlier dialog must not greet the next one.
  useEffect(() => {
    if (open) clearError.current?.();
  }, [open]);
  // A failed save shows above the form; bring it into view when the dialog is scrolled down
  // at its buttons. Only when a new error appears, so scrolling to fix a field isn't undone.
  useEffect(() => {
    if (workspace?.error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [workspace?.error]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40" />
        <Dialog.Content
          {...returnFocus}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onInteractOutside={(event) => {
            if (!dismissable) event.preventDefault();
            else keepOpenForToasts(event);
          }}
          // Escape with a dropdown open closes just the dropdown (CustomSelect handles it),
          // not the whole dialog and what was typed in it.
          onEscapeKeyDown={(event) => {
            // Any open list in the dialog: Safari doesn't focus a clicked trigger.
            if (contentRef.current?.querySelector('[role="combobox"][aria-expanded="true"]'))
              event.preventDefault();
          }}
          ref={contentRef}
          className={cn(
            'dialog-content fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-[28px] border border-white/90 bg-cream p-6 sm:p-8 shadow-[inset_0_1px_0_#fff,0_40px_80px_-30px_rgb(14_6_4/0.45),0_12px_28px_-14px_rgb(14_6_4/0.2)]',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          {/* On phones a tall dialog scrolls: this zero-height strip stays at the top, so Close
              stays in reach. From sm up it is not drawn and Close sits where it always did. */}
          <div className="sticky top-6 z-10 h-0 sm:contents">
            <Dialog.Close
              className="icon-btn absolute right-5 top-5 bg-ink/[0.04] max-sm:-right-1 max-sm:-top-1 max-sm:bg-[#f1edeb]"
              aria-label="Close dialog"
            >
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="mb-6 pr-10">
            <Dialog.Title className="break-words font-serif text-[28px] font-normal leading-[1.05] tracking-[-0.01em] text-ink sm:text-[32px]">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description className="mt-2 text-[13.5px] leading-relaxed text-stone-500">
                {description}
              </Dialog.Description>
            )}
          </div>
          {workspace?.error && (
            <div ref={errorRef} className="mb-4">
              <ErrorNotice message={workspace.error} onDismiss={workspace.clearError} />
            </div>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  busy,
  busyLabel = 'Working…',
  error,
  confirmLabel = 'Remove item',
  tone = 'danger',
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  /** This dialog's own action is running. */
  busy?: boolean;
  busyLabel?: string;
  /** Shown inside the dialog: notifications behind an open dialog are hidden from screen readers. */
  error?: string;
  confirmLabel?: string;
  /** 'primary' for a change that is not a removal, such as a new role. */
  tone?: 'danger' | 'primary';
}) {
  const returnFocus = useReturnFocus();
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay fixed inset-0 z-40" />
        <AlertDialog.Content
          {...returnFocus}
          className="dialog-content fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] max-w-md -translate-y-1/2 overflow-y-auto rounded-[28px] border border-white/90 bg-cream p-6 sm:p-7 shadow-[inset_0_1px_0_#fff,0_40px_80px_-30px_rgb(14_6_4/0.45),0_12px_28px_-14px_rgb(14_6_4/0.2)]"
        >
          {/* Titles often name an email address: let a long one wrap inside the dialog. */}
          <AlertDialog.Title className="break-words font-serif text-[28px] font-normal leading-[1.05] tracking-[-0.01em] text-ink">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-[13.5px] text-stone-500 leading-relaxed">
            {description}
          </AlertDialog.Description>
          {error && (
            <div className="mt-4">
              <ErrorNotice message={error} />
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2.5">
            <AlertDialog.Cancel className="btn">Go back</AlertDialog.Cancel>
            <ActionButton
              className={
                tone === 'primary'
                  ? 'btn-primary'
                  : 'border-red-700 bg-red-700 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_12px_24px_-12px_rgb(185_28_28/0.8)] hover:border-red-800 hover:bg-red-800 hover:text-white'
              }
              loading={busy}
              loadingLabel={busyLabel}
              onClick={onConfirm}
            >
              {confirmLabel}
            </ActionButton>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
/** A readiness row's way to where it is fixed, when it has one and is not done yet. */
export function ReadinessLink({ check }: { check: ReadinessCheck }) {
  const workspace = useContext(Workspace);
  if (check.id !== 'fulfillment' || check.ready || !workspace) return null;
  return (
    <button
      type="button"
      className="ml-auto shrink-0 font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
      onClick={() => {
        workspace.navigate('settings');
        // Settings shows once this click has been handled; then bring Delivery areas into view.
        setTimeout(() =>
          document.getElementById('delivery-areas')?.scrollIntoView({ block: 'start' }),
        );
      }}
    >
      Delivery settings
    </button>
  );
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 sm:mb-[26px] flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-2 text-[14px] text-stone-500 max-w-xl leading-relaxed">{description}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{children}</div>}
    </div>
  );
}

export const Select = CustomSelect;

export { ErrorBoundary } from './ErrorBoundary';
