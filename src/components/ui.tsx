import {
  Component,
  type ErrorInfo,
  useContext,
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-[7px] py-0.5 text-[11px] font-semibold border border-transparent',
        {
          'bg-success-700/10 text-success-700': tone === 'green',
          'bg-brand-500/12 text-brand-700': tone === 'amber',
          'bg-ink/5 text-stone-500': tone === 'neutral',
          'bg-red-600/10 text-red-700': tone === 'red',
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
      className="flex items-start gap-2.5 rounded-xl border border-red-600/15 bg-red-50/80 px-4 py-3 text-[13px] text-red-800"
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
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-ink text-brand-500">
        <Check className="size-5" />
      </div>
      <h3 className="panel-title">{title}</h3>
      <p className="mt-2 max-w-sm text-[13px] text-stone-500">{description}</p>
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/45 backdrop-blur-xs transition-opacity" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] -translate-y-1/2 overflow-y-auto rounded-[18px] border border-white/80 bg-cream p-6 sm:p-8 shadow-[0_24px_64px_-12px_rgba(14,6,4,0.25)]',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="mb-6 pr-10">
            <Dialog.Title className="font-serif text-xl sm:text-2xl font-bold tracking-[-0.3px] text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Description
              className={cn('mt-2 text-[13.5px] text-stone-500', !description && 'sr-only')}
            >
              {description || title}
            </Dialog.Description>
          </div>
          <Dialog.Close className="icon-btn absolute right-5 top-5" aria-label="Close dialog">
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
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/45 backdrop-blur-xs transition-opacity" />
        <AlertDialog.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-[18px] border border-white/80 bg-cream p-6 sm:p-7 shadow-[0_24px_64px_-12px_rgba(14,6,4,0.25)]">
          <AlertDialog.Title className="font-serif text-xl font-bold tracking-[-0.3px] text-ink">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-[13.5px] text-stone-500 leading-relaxed">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2.5">
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
    <div className="mb-6 sm:mb-[26px] flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-1 text-[13.5px] text-stone-500 max-w-xl leading-relaxed">{description}</p>
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
          'flex items-center justify-between gap-2 transition-all select-none cursor-pointer focus:outline-none',
          variant === 'pill'
            ? cn(
                'h-[38px] rounded-[9px] border text-[13px] font-semibold pl-3.5 pr-2.5',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-cream hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand-500/50'
                  : 'border-white/80 bg-white/65 text-stone-700 hover:bg-white hover:text-ink focus-visible:ring-3 focus-visible:ring-brand-500/12',
              )
            : cn(
                'min-h-[38px] w-full rounded-[9px] border text-[13px] px-3.5 py-2 text-left',
                theme === 'dark'
                  ? 'border-white/10 bg-white/[0.05] text-cream hover:bg-white/[0.08] focus-visible:border-white/20 focus-visible:ring-3 focus-visible:ring-brand-500/20'
                  : 'border-ink/8 bg-white/70 text-ink hover:border-ink/14 focus-visible:border-ink/20 focus-visible:bg-white focus-visible:ring-3 focus-visible:ring-brand-500/12',
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
            'absolute z-50 max-h-60 overflow-y-auto rounded-xl border p-1.5 shadow-xl backdrop-blur-md transition-all animate-in fade-in zoom-in-95 duration-100',
            placement === 'top' ? 'bottom-full mb-1.5 origin-bottom' : 'top-full mt-1.5 origin-top',
            align === 'right' ? 'right-0' : 'left-0',
            variant === 'pill' ? 'min-w-[12rem]' : 'w-full min-w-[10rem]',
            theme === 'dark'
              ? 'bg-ink-soft/95 border-white/10 text-cream shadow-black/60 custom-scrollbar-dark'
              : 'bg-white/95 border-ink/8 text-stone-800 shadow-ink/10 custom-scrollbar',
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
                    'flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors text-left cursor-pointer',
                    isSelected
                      ? theme === 'dark'
                        ? 'bg-white/[0.08] text-white font-semibold'
                        : 'bg-brand-500/10 text-ink font-semibold'
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
                  {isSelected && <Check className={cn('size-4 shrink-0', 'text-brand-500')} />}
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
        <div className="grid min-h-dvh place-items-center bg-canvas p-6 text-stone-800">
          <div className="card w-full max-w-md p-7 sm:p-9">
            <h1 className="page-title">Something went wrong</h1>
            <p className="mt-2 text-sm text-stone-500 leading-relaxed">
              {this.state.error?.message ||
                'An unexpected error occurred while rendering the workspace.'}
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <button
                className="btn btn-primary w-full"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Reload page
              </button>
              <button
                type="button"
                className="btn btn-quiet w-full text-xs text-stone-500 hover:text-stone-700"
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
