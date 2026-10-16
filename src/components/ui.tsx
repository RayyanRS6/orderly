import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Workspace, type Toast } from '../lib/workspace';
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
      <p className="min-w-0 flex-1 font-medium leading-relaxed">{toast.message}</p>
      <button
        type="button"
        className="rounded-full opacity-60 transition-[opacity,scale] duration-200 hover:opacity-100 active:scale-90"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X className="size-4" />
      </button>
    </div>
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
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const workspace = useContext(Workspace);
  const clearError = useRef(workspace?.clearError);
  useEffect(() => {
    clearError.current = workspace?.clearError;
  });
  // A failure from an earlier dialog must not greet the next one.
  useEffect(() => {
    if (open) clearError.current?.();
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40" />
        <Dialog.Content
          onInteractOutside={keepOpenForToasts}
          className={cn(
            'dialog-content fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-[28px] border border-white/90 bg-cream p-6 sm:p-8 shadow-[inset_0_1px_0_#fff,0_40px_80px_-30px_rgb(14_6_4/0.45),0_12px_28px_-14px_rgb(14_6_4/0.2)]',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="mb-6 pr-10">
            <Dialog.Title className="font-serif text-[28px] font-normal leading-[1.05] tracking-[-0.01em] text-ink sm:text-[32px]">
              {title}
            </Dialog.Title>
            <Dialog.Description
              className={cn(
                'mt-2 text-[13.5px] leading-relaxed text-stone-500',
                !description && 'sr-only',
              )}
            >
              {description || title}
            </Dialog.Description>
          </div>
          <Dialog.Close
            className="icon-btn absolute right-5 top-5 bg-ink/[0.04]"
            aria-label="Close dialog"
          >
            <X className="size-5" />
          </Dialog.Close>
          {workspace?.error && (
            <div className="mb-4">
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
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay fixed inset-0 z-40" />
        <AlertDialog.Content className="dialog-content fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-[28px] border border-white/90 bg-cream p-6 sm:p-7 shadow-[inset_0_1px_0_#fff,0_40px_80px_-30px_rgb(14_6_4/0.45),0_12px_28px_-14px_rgb(14_6_4/0.2)]">
          <AlertDialog.Title className="font-serif text-[28px] font-normal leading-[1.05] tracking-[-0.01em] text-ink">
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
              className="border-red-700 bg-red-700 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_12px_24px_-12px_rgb(185_28_28/0.8)] hover:border-red-800 hover:bg-red-800 hover:text-white"
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
