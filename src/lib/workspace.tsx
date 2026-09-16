import { createContext, useContext } from 'react';
import type { Bootstrap } from '../shared/types';
import type { SupabaseClient } from '@supabase/supabase-js';
export type Page =
  | 'overview'
  | 'orders'
  | 'menu'
  | 'inbox'
  | 'playground'
  | 'bot'
  | 'activity'
  | 'security'
  | 'integrations'
  | 'settings'
  | 'businesses';
export interface WorkspaceContext {
  data: Bootstrap;
  busy: boolean;
  error: string;
  clearError: () => void;
  page: Page;
  navigate: (page: Page, id?: string) => void;
  detailId?: string;
  auth?: SupabaseClient;
  switchCompany: (id: string) => void;
  refresh: () => Promise<void>;
  mutate: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>;
}
export const Workspace = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const context = useContext(Workspace);
  if (!context) throw new Error('Workspace unavailable');
  return context;
}
