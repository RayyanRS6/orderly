import {
  type ButtonHTMLAttributes,
  useContext,
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Workspace, type Toast } from '../lib/workspace';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Info,
  LoaderCircle,
  X,
} from 'lucide-react';
import { cn, label } from '../lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle aria-hidden="true" className={cn('size-4 shrink-0 animate-spin', className)} />
  );
}
/**
 * A button that shows its own progress: a spinner and a short label while its action
 * runs. It keeps its colour, and a second click (or Enter in a form) is ignored until
 * the action finishes. The rest of the page stays usable.
 */
export function ActionButton({
  loading,
  loadingLabel,
  children,
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; loadingLabel?: ReactNode }) {
  return (
    <button
      {...rest}
      className={cn('btn', className)}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? (
        <>
          <Spinner />
          {loadingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
        {
          'border-success-700/15 bg-success-700/10 text-success-700': tone === 'green',
          'border-brand-500/20 bg-brand-500/12 text-brand-800': tone === 'amber',
          'border-ink/[0.06] bg-ink/5 text-stone-500': tone === 'neutral',
          'border-red-600/15 bg-red-600/10 text-red-700': tone === 'red',
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
      className="shake-in flex items-start gap-2.5 rounded-2xl border border-red-600/15 bg-red-50/85 px-4 py-3 text-[13px] text-red-800 shadow-[0_12px_24px_-16px_rgb(220_38_38/0.45)]"
    >
      <AlertCircle className="pop-in mt-0.5 size-4 shrink-0 text-red-600 [--d:120ms]" />
      <p className="flex-1 font-medium">{message}</p>
      {onDismiss && (
        <button
          className="rounded-full text-red-500 transition-[color,scale] duration-200 hover:text-red-800 active:scale-90"
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
    <div className="mb-6 sm:mb-[26px] flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-2 text-[14px] text-stone-500 max-w-xl leading-relaxed">{description}</p>
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
  required = false,
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
  required?: boolean;
  className?: string;
  menuClassName?: string;
  align?: 'left' | 'right';
  variant?: 'input' | 'pill';
  theme?: 'light' | 'dark';
  'aria-label'?: string;
}) {
  const generatedId = useId();
  const selectId = id || generatedId;
  const listboxId = `${selectId}-listbox`;

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const updatePlacement = () => {
    if (typeof window === 'undefined' || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const estimatedHeight = Math.min(240, options.length * 40 + 16);
    if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
      setPlacement('top');
    } else {
      setPlacement('bottom');
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    updatePlacement();
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setHighlightedIndex(-1);
  };

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    handleClose();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && highlightedIndex >= 0 && optionRefs.current[highlightedIndex]) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, highlightedIndex]);

  const getNextEnabledIndex = (current: number, step: 1 | -1): number => {
    if (options.length === 0) return -1;
    let next = current + step;
    for (let i = 0; i < options.length; i++) {
      if (next >= options.length) next = 0;
      if (next < 0) next = options.length - 1;
      if (!options[next]?.disabled) return next;
      next += step;
    }
    return current;
  };

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleOpen();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      handleClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => getNextEnabledIndex(prev, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => getNextEnabledIndex(prev, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = options.findIndex((o) => !o.disabled);
      if (first >= 0) setHighlightedIndex(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i]?.disabled) {
          setHighlightedIndex(i);
          break;
        }
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (
        highlightedIndex >= 0 &&
        options[highlightedIndex] &&
        !options[highlightedIndex].disabled
      ) {
        handleSelect(options[highlightedIndex].value);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative', variant === 'input' ? 'w-full' : 'inline-block')}
    >
      {(name || required) && (
        <input
          aria-hidden="true"
          required={required}
          name={name}
          value={value}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          className="sr-only absolute"
        />
      )}
      <button
        ref={triggerRef}
        id={selectId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && highlightedIndex >= 0 && options[highlightedIndex]
            ? `${listboxId}-opt-${highlightedIndex}`
            : undefined
        }
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (open) {
            handleClose();
          } else {
            handleOpen();
          }
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex items-center justify-between gap-2 transition-[background-color,border-color,color,box-shadow,scale] duration-200 select-none cursor-pointer focus:outline-none active:scale-[0.98]',
          variant === 'pill'
            ? cn(
                'h-[40px] rounded-full border text-[13px] font-semibold pl-4 pr-3',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-cream hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand-500/50'
                  : 'border-white/90 bg-white/75 text-stone-700 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] hover:bg-white hover:text-ink focus-visible:ring-4 focus-visible:ring-brand-500/15',
              )
            : cn(
                'min-h-[40px] w-full rounded-xl border text-[13px] px-3.5 py-2 text-left',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-cream hover:bg-white/[0.08] focus-visible:border-brand-500/50 focus-visible:ring-4 focus-visible:ring-brand-500/20'
                  : 'border-ink/10 bg-white/80 text-ink shadow-[inset_0_1px_2px_rgb(14_6_4/0.03)] hover:border-ink/18 focus-visible:border-brand-500/60 focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-brand-500/15',
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
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className={cn(
            'menu-pop absolute z-50 max-h-60 overflow-y-auto rounded-2xl border p-1.5',
            placement === 'top' ? 'bottom-full mb-2 origin-bottom' : 'top-full mt-2 origin-top',
            align === 'right' ? 'right-0' : 'left-0',
            variant === 'pill' ? 'min-w-[12rem]' : 'w-full min-w-[10rem]',
            theme === 'dark'
              ? 'bg-ink-soft/95 border-white/10 text-cream shadow-[0_24px_48px_-20px_rgb(0_0_0/0.8)] custom-scrollbar-dark'
              : 'glass-pop text-stone-800 custom-scrollbar',
            menuClassName,
          )}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-stone-400">No options available</div>
          ) : (
            options.map((option, index) => {
              const isSelected = option.value === value;
              const isHighlighted = index === highlightedIndex;
              return (
                <button
                  key={option.value}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  id={`${listboxId}-opt-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelect(option.value);
                  }}
                  onMouseEnter={() => {
                    if (!option.disabled) setHighlightedIndex(index);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition-colors duration-100 text-left cursor-pointer',
                    isSelected
                      ? theme === 'dark'
                        ? 'bg-white/[0.08] text-white font-semibold'
                        : 'bg-brand-500/12 text-ink font-semibold'
                      : isHighlighted
                        ? theme === 'dark'
                          ? 'bg-white/[0.08] text-white'
                          : 'bg-ink/5 text-ink'
                        : theme === 'dark'
                          ? 'text-cream/65 hover:bg-white/[0.08] hover:text-white'
                          : 'text-stone-600 hover:bg-ink/5 hover:text-ink',
                    option.disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <Check className={cn('pop-in size-4 shrink-0', 'text-brand-600')} />
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

export { ErrorBoundary } from './ErrorBoundary';
