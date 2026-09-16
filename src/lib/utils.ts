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
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'O';
  return parts
    .slice(0, 2)
    .map((n) => n[0] || '')
    .join('')
    .toUpperCase() || 'O';
};
