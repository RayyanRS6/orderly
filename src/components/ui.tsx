import {
  Component,
  type ErrorInfo,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { Workspace } from '../lib/workspace';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertCircle, ArrowRight, Check, ChevronDown, X } from 'lucide-react';
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

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function CustomSelect({
  id,
  name,
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  disabled = false,
  className,
  menuClassName,
  align = 'left',
  variant = 'input',
  theme = 'light',
  'aria-label': ariaLabel,
}: {
  id?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  align?: 'left' | 'right';
  variant?: 'input' | 'pill';
  theme?: 'light' | 'dark';
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectedOption = options.find((opt) => opt.value === value);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative', variant === 'input' ? 'w-full' : 'inline-block')}
    >
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'flex items-center justify-between gap-2 transition-all select-none cursor-pointer focus:outline-none',
          variant === 'pill'
            ? cn(
                'rounded-full border text-xs font-semibold py-1.5 pl-3.5 pr-2.5',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-stone-200 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-500/50'
                  : 'border-stone-200/90 bg-stone-50/90 text-stone-700 shadow-2xs hover:bg-stone-100 hover:border-stone-300 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
              )
            : cn(
                'min-h-10 w-full rounded-xl border text-sm px-3.5 py-2 text-left',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-stone-200 hover:bg-white/[0.08] focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20'
                  : 'border-stone-200/90 bg-white text-stone-800 hover:border-stone-300 focus-visible:border-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-500/15',
              ),
          disabled && 'opacity-60 cursor-not-allowed pointer-events-none',
          className,
        )}
      >
        <span className="truncate">
          {selectedOption ? (
            selectedOption.label
          ) : (
            <span className="text-stone-400 font-normal">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-180',
            theme === 'dark' ? 'text-stone-400' : 'text-stone-400',
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            'absolute top-full mt-1.5 z-50 max-h-60 overflow-y-auto rounded-2xl border p-1.5 shadow-xl backdrop-blur-md transition-all animate-in fade-in zoom-in-95 duration-100',
            align === 'right' ? 'right-0' : 'left-0',
            variant === 'pill' ? 'min-w-[12rem]' : 'w-full min-w-[10rem]',
            theme === 'dark'
              ? 'bg-[#1a1d21]/95 border-white/10 text-stone-200 shadow-black/60 custom-scrollbar-dark'
              : 'bg-white/95 border-stone-200/90 text-stone-800 shadow-stone-900/10 custom-scrollbar',
            menuClassName,
          )}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-stone-400">No options available</div>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onClick={() => handleSelect(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2 text-xs sm:text-sm font-medium transition-colors text-left cursor-pointer',
                    isSelected
                      ? theme === 'dark'
                        ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                        : 'bg-emerald-50 text-emerald-900 font-semibold'
                      : theme === 'dark'
                        ? 'text-stone-300 hover:bg-white/[0.08] hover:text-white'
                        : 'text-stone-700 hover:bg-stone-100/80 hover:text-stone-900',
                    option.disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <Check
                      className={cn(
                        'size-4 shrink-0',
                        theme === 'dark' ? 'text-emerald-400' : 'text-emerald-700',
                      )}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export const Select = CustomSelect;

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
            <div className="mt-6 flex flex-col gap-2">
              <button
                className="btn btn-primary rounded-full w-full"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Reload page
              </button>
              <button
                type="button"
                className="btn btn-quiet rounded-full w-full text-xs text-stone-500 hover:text-stone-700"
                onClick={() => {
                  try {
                    localStorage.removeItem('orderly.company');
                  } catch {}
                  window.location.href = '/';
                }}
              >
                Reset workspace and return home
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
