import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...values: ClassValue[]) => twMerge(clsx(values));

export const label = (value?: string | null) => {
  if (!value) return '';
  return value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
};

export const shortDate = (date?: string | number | Date | null) => {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-PK', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
};

export const initials = (name?: string | null) => {
  if (!name) return 'O';
  // Only words with a letter or digit count, and their first one is taken whole, so
  // 'Bun & Co.' gives 'BC', 'Ali (demo)' gives 'AD' and an emoji never splits in half.
  const parts = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter(Boolean);
  if (parts.length === 0) return 'O';
  return parts.slice(0, 2).join('').toUpperCase() || 'O';
};
