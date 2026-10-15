import type { Conversation, Message } from './types';

// The live description of everything connected to a business's bot. The server builds it
// from the saved configuration, connections and platform environment on every request, so
// changing the model, menu or a connection is reflected the next time the page loads.

export type FlowNodeId =
  | 'channel'
  | 'sandbox'
  | 'gates'
  | 'agent'
  | 'model'
  | 'memory'
  | 'menu'
  | 'knowledge'
  | 'instructions'
  | 'engine'
  | 'router'
  | 'reply'
  | 'order'
  | 'sheets'
  | 'staff';

/** ready: connected and working. attention: needs setup. off: not connected (optional or unused). fixed: built into Orderly. */
export type FlowStatus = 'ready' | 'attention' | 'off' | 'fixed';

export type FlowPage =
  | 'overview'
  | 'orders'
  | 'inbox'
  | 'menu'
  | 'playground'
  | 'bot'
  | 'activity'
  | 'integrations'
  | 'settings'
  | 'security'
  | 'businesses';

export interface FlowFact {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'muted';
}

export interface FlowNode {
  id: FlowNodeId;
  title: string;
  subtitle: string;
  status: FlowStatus;
  /** Short status text, e.g. "Connected" or "Run the test". */
  statusLabel: string;
  /** Whether the business can change this part (false = built into Orderly). */
  editable: boolean;
  page?: FlowPage;
  pageLabel?: string;
  what: string;
  receives: string[];
  sends: string[];
  facts: FlowFact[];
  /** How this part shapes the bot's replies. */
  affects: string[];
  /** Backend rules the business cannot change. */
  fixed: string[];
  /** The next thing to do when status is attention. */
  todo?: string;
}

export interface SetupStep {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  /** Not needed in this mode (for example WhatsApp in the local demo). */
  optional?: boolean;
  /** Worth doing, but not one of the checks that gate automatic replies. */
  recommended?: boolean;
  page: FlowPage;
  action: string;
}

export interface PlatformCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface RecentReply {
  conversationId: string;
  channel: Conversation['channel'];
  customerName: string;
  message: Pick<Message, 'id' | 'text' | 'createdAt' | 'explanation'>;
}

export interface AgentFlow {
  generatedAt: string;
  mode: 'demo' | 'live';
  nodes: FlowNode[];
  setup: SetupStep[];
  /** Server environment checks; omitted for staff. */
  platform?: PlatformCheck[];
  recent: RecentReply[];
}
