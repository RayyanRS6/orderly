import { useContext, type ReactNode } from 'react';
import { Workspace } from '../lib/workspace';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertCircle, ArrowRight, Check, X } from 'lucide-react';
import { cn, label } from '../lib/utils';

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'green' | 'amber' | 'neutral' | 'red';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium',
        {
          'bg-emerald-50 text-emerald-800': tone === 'green',
          'bg-amber-50 text-amber-800': tone === 'amber',
          'bg-stone-100 text-stone-600': tone === 'neutral',
          'bg-red-50 text-red-700': tone === 'red',
        },
      )}
    >
      {children}
    </span>
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
      <span className="size-1.5 rounded-full bg-current" />
      {label(value)}
    </Badge>
  );
}
export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1">{message}</p>
      {onDismiss && (
        <button aria-label="Dismiss error" onClick={onDismiss}>
          <X className="size-4" />
        </button>
      )}
    </div>
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
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-stone-100 text-stone-400">
        <Check className="size-5" />
      </div>
      <h3 className="font-semibold text-stone-800">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-stone-500">{description}</p>
      {action && (
        <button className="btn mt-5" onClick={onAction}>
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-stone-950/40" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-6 shadow-xl',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="mb-6 pr-10">
            <Dialog.Title className="text-xl font-semibold text-stone-900">{title}</Dialog.Title>
            <Dialog.Description
              className={cn('mt-2 text-sm text-stone-500', !description && 'sr-only')}
            >
              {description || title}
            </Dialog.Description>
          </div>
          <Dialog.Close className="icon-btn absolute right-4 top-4" aria-label="Close dialog">
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
  confirmLabel = 'Remove item',
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel?: string;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-950/40" />
        <AlertDialog.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm text-stone-500">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn" disabled={busy}>
              Go back
            </AlertDialog.Cancel>
            <button
              className="btn border-red-700 bg-red-700 text-white hover:bg-red-800"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? 'Saving…' : confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
export function Field({
  label: text,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="field-label">{text}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-stone-500">{hint}</span>}
    </label>
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
    <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-2 text-sm text-stone-500">{description}</p>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
