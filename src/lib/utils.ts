import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...values: ClassValue[]) => twMerge(clsx(values));
export const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export const shortDate = (date: string) =>
  new Date(date).toLocaleString('en-PK', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
