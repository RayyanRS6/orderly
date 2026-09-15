import { Component, type ErrorInfo, useContext, type ReactNode } from 'react';
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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide border',
        {
          'bg-emerald-50 text-emerald-800 border-emerald-200/80': tone === 'green',
          'bg-amber-50 text-amber-800 border-amber-200/80': tone === 'amber',
          'bg-stone-100 text-stone-700 border-stone-200/70': tone === 'neutral',
          'bg-red-50 text-red-700 border-red-200/80': tone === 'red',
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
      <span className="size-1.5 rounded-full bg-current shrink-0" />
      {label(value)}
    </Badge>
  );
}
export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-800 shadow-xs"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
      <p className="flex-1 font-medium">{message}</p>
      {onDismiss && (
        <button
          className="text-red-500 hover:text-red-800 transition-colors"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
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
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-stone-100 text-stone-400 border border-stone-200/60">
        <Check className="size-5" />
      </div>
      <h3 className="font-semibold text-stone-800">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-stone-500">{description}</p>
      {action && (
        <button className="btn mt-5 rounded-full" onClick={onAction}>
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-stone-950/50 backdrop-blur-xs transition-opacity" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-3xl border border-stone-200/90 bg-white p-6 sm:p-8 shadow-2xl',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="mb-6 pr-10">
            <Dialog.Title className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900">
              {title}
            </Dialog.Title>
            <Dialog.Description
              className={cn('mt-2 text-sm text-stone-500', !description && 'sr-only')}
            >
              {description || title}
            </Dialog.Description>
          </div>
          <Dialog.Close
            className="icon-btn absolute right-5 top-5 rounded-full"
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
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-950/50 backdrop-blur-xs transition-opacity" />
        <AlertDialog.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-3xl border border-stone-200/90 bg-white p-6 sm:p-7 shadow-2xl">
          <AlertDialog.Title className="text-xl font-bold tracking-tight text-stone-900">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm text-stone-500 leading-relaxed">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2.5">
            <AlertDialog.Cancel className="btn rounded-full" disabled={busy}>
              Go back
            </AlertDialog.Cancel>
            <button
              className="btn rounded-full border-red-700 bg-red-700 text-white hover:bg-red-800 shadow-xs"
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
    <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-1.5 text-sm text-stone-500 max-w-xl leading-relaxed">{description}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{children}</div>}
    </div>
  );
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in UI:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="grid min-h-dvh place-items-center bg-[#f8fafc] p-6 text-stone-800">
          <div className="w-full max-w-md rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-9 shadow-xl">
            <h1 className="text-xl font-bold tracking-tight text-stone-900">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-stone-500 leading-relaxed">
              {this.state.error?.message ||
                'An unexpected error occurred while rendering the workspace.'}
            </p>
            <div className="mt-6">
              <button
                className="btn btn-primary rounded-full w-full"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
