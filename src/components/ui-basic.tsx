import {
  type ButtonHTMLAttributes,
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { AlertCircle, Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import { cn } from '../lib/utils';

// The basic controls, with no dialog library and no workspace: the public menu page loads
// only these. ui.tsx re-exports them for the dashboard.
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
