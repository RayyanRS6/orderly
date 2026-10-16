import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  BrainCircuit,
  Check,
  CircleAlert,
  Cog,
  Database,
  FlaskConical,
  Headset,
  Lock,
  Maximize2,
  MessageCircle,
  RefreshCw,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  ShoppingBag,
  Split,
  Store,
  Table2,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AgentFlow as Flow,
  FlowNode,
  FlowNodeId,
  FlowStatus,
  RecentReply,
} from '../shared/agent-flow';
import type { TurnExplanation } from '../shared/types';
import {
  explanationHeadline,
  explanationPath,
  NOTICE_LABELS,
  SKIP_LABELS,
} from '../shared/explain';
import { api } from '../lib/api';
import { useWorkspace, type Page } from '../lib/workspace';
import { cn, shortDate } from '../lib/utils';
import { Badge, ErrorNotice, PageHeading } from './ui';
import { ReplyExplanation } from './ReplyExplanation';

type Icon = ComponentType<{ className?: string }>;
const ICONS: Record<FlowNodeId, Icon> = {
  channel: MessageCircle,
  sandbox: FlaskConical,
  gates: ShieldCheck,
  agent: Bot,
  model: BrainCircuit,
  memory: Database,
  menu: BookOpen,
  knowledge: Store,
  instructions: ScrollText,
  engine: Cog,
  router: Split,
  reply: Send,
  order: ShoppingBag,
  sheets: Table2,
  staff: Headset,
};

// Canvas geometry in canvas units; the canvas is scaled to fit the available width.
const W = 1344;
const H = 560;
type Shape = 'trigger' | 'card' | 'agent' | 'sub' | 'switch';
const BOX: Record<FlowNodeId, { x: number; y: number; w: number; h: number; shape: Shape }> = {
  channel: { x: 28, y: 112, w: 180, h: 88, shape: 'trigger' },
  sandbox: { x: 28, y: 256, w: 180, h: 88, shape: 'trigger' },
  gates: { x: 244, y: 184, w: 156, h: 88, shape: 'card' },
  agent: { x: 436, y: 168, w: 340, h: 120, shape: 'agent' },
  engine: { x: 812, y: 184, w: 160, h: 88, shape: 'card' },
  router: { x: 1004, y: 176, w: 96, h: 104, shape: 'switch' },
  reply: { x: 1164, y: 28, w: 168, h: 88, shape: 'card' },
  staff: { x: 1164, y: 150, w: 168, h: 88, shape: 'card' },
  order: { x: 1164, y: 300, w: 168, h: 88, shape: 'card' },
  sheets: { x: 1164, y: 432, w: 168, h: 88, shape: 'card' },
  model: { x: 0, y: 0, w: 72, h: 72, shape: 'sub' },
  memory: { x: 0, y: 0, w: 72, h: 72, shape: 'sub' },
  menu: { x: 0, y: 0, w: 72, h: 72, shape: 'sub' },
  knowledge: { x: 0, y: 0, w: 72, h: 72, shape: 'sub' },
  instructions: { x: 0, y: 0, w: 72, h: 72, shape: 'sub' },
};
const SUBS: { id: FlowNodeId; port: string; required?: boolean }[] = [
  { id: 'model', port: 'Model', required: true },
  { id: 'memory', port: 'Memory' },
  { id: 'menu', port: 'Menu' },
  { id: 'knowledge', port: 'Info' },
  { id: 'instructions', port: 'Rules' },
];
const agentBox = BOX.agent;
const SUB_Y = 392;
const SUB_SPACING = 132;
// Ports sit along the agent's bottom edge; the circles fan out wider so labels never collide.
const portX = (index: number) => agentBox.x + (agentBox.w / SUBS.length) * (index + 0.5);
SUBS.forEach((sub, index) => {
  const cx = agentBox.x + agentBox.w / 2 + (index - (SUBS.length - 1) / 2) * SUB_SPACING;
  BOX[sub.id] = { x: cx - 36, y: SUB_Y, w: 72, h: 72, shape: 'sub' };
});
const ROUTER_PORTS: { to: FlowNodeId; label: string; dy: number }[] = [
  { to: 'reply', label: 'reply', dy: -28 },
  { to: 'staff', label: 'staff', dy: 0 },
  { to: 'order', label: 'order', dy: 28 },
];
const midY = (id: FlowNodeId) => BOX[id].y + BOX[id].h / 2;
const right = (id: FlowNodeId) => BOX[id].x + BOX[id].w;
const MAIN_EDGES: { from: FlowNodeId; to: FlowNodeId; d: string }[] = [
  ...(['channel', 'sandbox'] as const).map((from) => ({
    from,
    to: 'gates' as const,
    d: curve(right(from), midY(from), BOX.gates.x, midY('gates')),
  })),
  {
    from: 'gates',
    to: 'agent',
    d: curve(right('gates'), midY('gates'), BOX.agent.x, midY('agent')),
  },
  {
    from: 'agent',
    to: 'engine',
    d: curve(right('agent'), midY('agent'), BOX.engine.x, midY('engine')),
  },
  {
    from: 'engine',
    to: 'router',
    d: curve(right('engine'), midY('engine'), BOX.router.x, midY('router')),
  },
  ...ROUTER_PORTS.map((port) => ({
    from: 'router' as const,
    to: port.to,
    d: curve(right('router'), midY('router') + port.dy, BOX[port.to].x, midY(port.to)),
  })),
  {
    from: 'order',
    to: 'sheets',
    d: `M ${BOX.order.x + BOX.order.w / 2} ${BOX.order.y + BOX.order.h} L ${BOX.sheets.x + BOX.sheets.w / 2} ${BOX.sheets.y}`,
  },
];
function curve(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(28, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

const STATUS_STYLE: Record<FlowStatus, { ring: string; dot: string; text: string; label: string }> =
  {
    ready: {
      ring: 'border-success-700/45',
      dot: 'bg-success-700',
      text: 'text-success-700',
      label: 'Ready',
    },
    attention: {
      ring: 'border-brand-500',
      dot: 'bg-brand-500',
      text: 'text-brand-700',
      label: 'Needs attention',
    },
    off: {
      ring: 'border-dashed border-stone-300',
      dot: 'bg-stone-300',
      text: 'text-stone-500',
      label: 'Not connected',
    },
    fixed: {
      ring: 'border-dashed border-ink/20',
      dot: 'bg-ink/35',
      text: 'text-stone-500',
      label: 'Built into Orderly',
    },
  };
const MOBILE_ORDER: FlowNodeId[] = [
  'channel',
  'sandbox',
  'gates',
  'agent',
  'model',
  'memory',
  'menu',
  'knowledge',
  'instructions',
  'engine',
  'router',
  'reply',
  'staff',
  'order',
  'sheets',
];

export function AgentFlow() {
  const { data, navigate } = useWorkspace();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<FlowNodeId>('agent');
  const [replay, setReplay] = useState<RecentReply | null>(null);
  const [zoom, setZoom] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  // Reload whenever saved settings, connections or the menu change elsewhere in the app.
  const configKey = JSON.stringify([
    data.company,
    data.integrations,
    data.readiness,
    data.aiConnection,
    data.products?.length,
  ]);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await api<Flow>('/agent-flow', data.company.id);
      if (id !== request.current) return;
      setFlow(result);
      setError('');
      setReplay((current) =>
        current
          ? (result.recent.find((item) => item.message.id === current.message.id) ?? current)
          : null,
      );
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [data.company.id]);
  useEffect(() => {
    void load();
  }, [load, configKey]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !autoFit || typeof ResizeObserver === 'undefined') return;
    const fit = () => setZoom(Math.min(1, Math.max(0.6, (element.clientWidth - 2) / W)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [autoFit, flow !== null]);

  const nodes = new Map(flow?.nodes.map((node) => [node.id, node]));
  const path = replay?.message.explanation ? explanationPath(replay.message.explanation) : null;
  const onPath = (id: FlowNodeId) => !path || path.nodes.includes(id);
  const edgeOnPath = (from: FlowNodeId, to: FlowNodeId) =>
    !!path && path.nodes.includes(from) && path.nodes.includes(to);
  const current = nodes.get(selected);
  const required = flow?.setup.filter((step) => !step.optional && !step.recommended) ?? [];
  const done = required.filter((step) => step.done).length;
  const next = required.find((step) => !step.done);
  const go = (page?: string) => page && navigate(page as Page);
  const changeZoom = (value: number) => {
    setAutoFit(false);
    setZoom(Math.min(1.4, Math.max(0.5, Math.round(value * 100) / 100)));
  };

  return (
    <>
      <PageHeading
        title="Agent flow"
        description="Everything connected to this business’s bot, what data each part uses, and why it replied the way it did. It updates whenever you change a setting."
      >
        <button className="btn" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </button>
        <button className="btn btn-primary" onClick={() => navigate('playground')}>
          Test your bot
          <ArrowRight className="size-4" />
        </button>
      </PageHeading>
      <ErrorNotice message={error} onDismiss={() => setError('')} />

      {flow && (
        <section className="card mb-6 p-5 sm:p-6" aria-labelledby="setup-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="setup-title" className="panel-title">
                {next ? 'Get this business live' : 'Everything is connected'}
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                {done} of {required.length} required steps done
                {next ? `. Next: ${next.title}.` : '. The bot is ready for customers.'}
              </p>
            </div>
            {next && (
              <button className="btn btn-primary" onClick={() => go(next.page)}>
                {next.action}
                <ArrowRight className="size-4" />
              </button>
            )}
          </div>
          <div
            className="mt-4 h-2 overflow-hidden rounded-full bg-ink/[0.06] shadow-[inset_0_1px_2px_rgb(14_6_4/0.08)]"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={required.length}
            aria-valuenow={done}
          >
            <div
              className="h-full rounded-full bg-linear-to-r from-brand-400 to-brand-500 shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] transition-[width] duration-700 ease-[var(--ease-soft)]"
              style={{ width: `${required.length ? (done / required.length) * 100 : 0}%` }}
            />
          </div>
          <details className="group mt-4" open={!!next}>
            <summary className="-ml-2 w-fit cursor-pointer rounded-full px-2 py-1 text-xs font-semibold text-stone-500 transition-colors select-none hover:bg-ink/5 hover:text-ink">
              Show all steps
            </summary>
            <ol className="stagger mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {flow.setup.map((step, index) => (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => go(step.page)}
                    className={cn(
                      'lift flex h-full w-full items-start gap-3 rounded-2xl border p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 ease-[var(--ease-soft)]',
                      step.id === next?.id
                        ? 'border-brand-500/60 bg-brand-50 shadow-[0_14px_28px_-18px_rgb(255_105_44/0.9)]'
                        : 'border-white bg-white/60 hover:bg-white',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                        step.done
                          ? 'bg-success-700 text-white shadow-[0_6px_12px_-6px_rgb(23_124_74/0.9)]'
                          : step.id === next?.id
                            ? 'bg-ink text-cream shadow-[0_6px_12px_-6px_rgb(14_6_4/0.7)]'
                            : 'bg-ink/[0.06] text-stone-600',
                      )}
                    >
                      {step.done ? <Check className="pop-spin size-3.5" /> : index + 1}
                      <span className="sr-only">{step.done ? ' (done)' : ' (not done)'}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-stone-800">
                        {step.title}
                        {(step.optional || step.recommended) && (
                          <span className="font-normal text-stone-400">
                            {step.optional ? ' · optional' : ' · recommended'}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
                        {step.detail}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}

      <section className="card mb-6 overflow-hidden" aria-labelledby="canvas-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/[0.06] px-5 py-4 sm:px-6">
          <div>
            <h2 id="canvas-title" className="panel-title">
              How a customer message flows
            </h2>
            <p className="mt-1 text-xs text-stone-500">
              Select any part to see what it receives, what it passes on and what you can change.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-stone-500">
            {(['ready', 'attention', 'off', 'fixed'] as FlowStatus[]).map((status) => (
              <span
                key={status}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/70 py-1 pr-2.5 pl-2 shadow-[0_0_0_1px_rgb(14_6_4/0.05)]"
              >
                <span className={cn('size-2 rounded-full', STATUS_STYLE[status].dot)} />
                {STATUS_STYLE[status].label}
              </span>
            ))}
            {flow && (
              <span className="hidden items-center gap-0.5 rounded-full border border-ink/[0.08] bg-white/85 p-1 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] md:inline-flex">
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-full text-stone-600 transition-[background-color,color,scale] duration-200 hover:bg-ink/5 hover:text-ink active:scale-90"
                  aria-label="Zoom out"
                  onClick={() => changeZoom(zoom - 0.1)}
                >
                  <ZoomOut className="size-4" />
                </button>
                <button
                  type="button"
                  className={cn(
                    'flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold tabular-nums text-stone-600 transition-colors duration-200 hover:bg-ink/5 hover:text-ink',
                    autoFit && 'bg-ink text-cream hover:bg-ink-soft hover:text-cream',
                  )}
                  aria-label="Fit to width"
                  onClick={() => setAutoFit(true)}
                >
                  <Maximize2 className="size-3.5" />
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-full text-stone-600 transition-[background-color,color,scale] duration-200 hover:bg-ink/5 hover:text-ink active:scale-90"
                  aria-label="Zoom in"
                  onClick={() => changeZoom(zoom + 0.1)}
                >
                  <ZoomIn className="size-4" />
                </button>
              </span>
            )}
          </div>
        </div>
        {replay?.message.explanation && (
          <div className="flex items-center justify-between gap-3 border-b border-brand-500/20 bg-brand-500/[0.07] px-5 py-3 text-[13px] sm:px-6">
            <p className="min-w-0 text-stone-700">
              <span className="font-semibold text-ink">Showing one reply’s path · </span>
              {explanationHeadline(replay.message.explanation)}
            </p>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/90 px-3 py-1.5 text-xs font-semibold text-stone-700 shadow-[0_0_0_1px_rgb(14_6_4/0.06),0_6px_14px_-10px_rgb(14_6_4/0.4)] transition-colors hover:bg-ink hover:text-cream"
              onClick={() => setReplay(null)}
            >
              <X className="size-3.5" />
              Show live setup
            </button>
          </div>
        )}
        {!flow ? (
          <div className="grid h-72 place-items-center p-6 text-sm text-stone-500" role="status">
            {error ? 'The flow could not be loaded.' : 'Loading your bot’s connections…'}
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <div
                ref={viewport}
                className="custom-scrollbar overflow-auto bg-[radial-gradient(circle,rgba(14,6,4,0.13)_1px,transparent_1.2px)] bg-[length:22px_22px]"
              >
                <div style={{ width: W * zoom, height: H * zoom }}>
                  <div
                    className="relative"
                    style={{
                      width: W,
                      height: H,
                      transform: `scale(${zoom})`,
                      transformOrigin: '0 0',
                    }}
                  >
                    <Edges onPath={edgeOnPath} replaying={!!path} />
                    {[...nodes.values()].map((node) => (
                      <CanvasNode
                        key={node.id}
                        node={node}
                        selected={selected === node.id}
                        dimmed={!onPath(node.id)}
                        stopped={path?.stoppedAt === node.id}
                        onSelect={() => setSelected(node.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <ol className="stagger space-y-2 p-4 md:hidden" aria-label="Bot flow steps">
              {MOBILE_ORDER.map((id) => {
                const node = nodes.get(id);
                if (!node) return null;
                const Icon = ICONS[id];
                const sub = BOX[id].shape === 'sub';
                return (
                  <li key={id} className={cn(sub && 'pl-6')}>
                    <button
                      type="button"
                      aria-pressed={selected === id}
                      onClick={() => setSelected(id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-2xl border-2 bg-white/80 p-3 text-left shadow-[0_10px_22px_-18px_rgb(14_6_4/0.45)] transition-[opacity,background-color,box-shadow,scale] duration-300 active:scale-[0.98]',
                        STATUS_STYLE[node.status].ring,
                        selected === id &&
                          'bg-white ring-2 ring-ink/80 ring-offset-2 ring-offset-white',
                        !onPath(id) && 'opacity-40',
                      )}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink text-brand-500 shadow-[0_8px_16px_-10px_rgb(14_6_4/0.7)]">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-ink">
                          {node.title}
                        </span>
                        <span className="block truncate text-xs text-stone-500">
                          {node.subtitle}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'inline-flex max-w-[40%] shrink-0 items-center gap-1.5 text-right text-[11px] font-semibold',
                          STATUS_STYLE[node.status].text,
                        )}
                      >
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            STATUS_STYLE[node.status].dot,
                            BOX[id].shape === 'trigger' &&
                              node.status === 'ready' &&
                              'live-dot text-success-700',
                          )}
                        />
                        <span className="truncate">{node.statusLabel}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      {flow && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          {current ? (
            <Inspector
              node={current}
              explanation={replay?.message.explanation}
              productName={(id) =>
                data.products.find((product) => product.id === id)?.name ?? 'a removed item'
              }
              onOpen={() => go(current.page)}
            />
          ) : (
            <div />
          )}
          <div className="space-y-6">
            <RecentReplies
              items={flow.recent}
              selected={replay?.message.id}
              onSelect={(item) => {
                setReplay(item);
                setSelected('agent');
              }}
              onTest={() => navigate('playground')}
            />
            {replay?.message.explanation && (
              <section className="step-in card p-5 sm:p-6" aria-labelledby="why-title">
                <h2 id="why-title" className="panel-title">
                  Why this reply
                </h2>
                <p className="bubble-them bubble-in-left mt-3 px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-stone-700">
                  {replay.message.text}
                </p>
                <ReplyExplanation explanation={replay.message.explanation} className="mt-4" />
              </section>
            )}
            {flow.platform && <PlatformChecks checks={flow.platform} />}
          </div>
        </div>
      )}
    </>
  );
}

function Edges({
  onPath,
  replaying,
}: {
  onPath: (from: FlowNodeId, to: FlowNodeId) => boolean;
  replaying: boolean;
}) {
  const stroke = (active: boolean) =>
    replaying ? (active ? '#ff692c' : 'rgba(14,6,4,0.12)') : 'rgba(14,6,4,0.38)';
  return (
    <svg className="pointer-events-none absolute inset-0" width={W} height={H} aria-hidden="true">
      <defs>
        {['idle', 'active'].map((kind) => (
          <marker
            key={kind}
            id={`flow-arrow-${kind}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d="M 0 0 L 10 5 L 0 10 z"
              fill={kind === 'active' ? '#ff692c' : 'rgba(14,6,4,0.45)'}
            />
          </marker>
        ))}
      </defs>
      {MAIN_EDGES.map((edge) => {
        const active = onPath(edge.from, edge.to);
        return (
          <path
            key={`${edge.from}-${edge.to}`}
            d={edge.d}
            fill="none"
            stroke={stroke(active)}
            strokeWidth={active ? 3 : 2}
            markerEnd={`url(#flow-arrow-${active ? 'active' : 'idle'})`}
          />
        );
      })}
      {ROUTER_PORTS.map((port) => (
        <text
          key={port.label}
          x={right('router') + 6}
          y={midY('router') + port.dy + 4}
          fontSize="11"
          fill="#756d68"
          stroke="#efebe8"
          strokeWidth="3"
          paintOrder="stroke"
        >
          {port.label}
        </text>
      ))}
      {SUBS.map((sub, index) => {
        const box = BOX[sub.id];
        const cx = box.x + box.w / 2;
        const px = portX(index);
        const top = BOX.agent.y + BOX.agent.h;
        const active = onPath('agent', sub.id);
        return (
          <g key={sub.id}>
            <path
              d={`M ${cx} ${box.y} C ${cx} ${box.y - 50}, ${px} ${top + 60}, ${px} ${top + 6}`}
              stroke={replaying ? (active ? '#ff692c' : 'rgba(14,6,4,0.12)') : 'rgba(14,6,4,0.32)'}
              strokeWidth={active ? 2.5 : 1.6}
              strokeDasharray="6 5"
              fill="none"
            />
            <rect
              x={px - 6}
              y={top - 6}
              width="12"
              height="12"
              transform={`rotate(45 ${px} ${top})`}
              fill={active ? '#ff692c' : 'rgba(14,6,4,0.45)'}
            />
            <text x={px} y={top + 24} fontSize="11" textAnchor="middle" fill="#574d48">
              {sub.port}
              {sub.required ? ' *' : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function CanvasNode({
  node,
  selected,
  dimmed,
  stopped,
  onSelect,
}: {
  node: FlowNode;
  selected: boolean;
  dimmed: boolean;
  stopped: boolean;
  onSelect: () => void;
}) {
  const box = BOX[node.id];
  const Icon = ICONS[node.id];
  const style = STATUS_STYLE[node.status];
  const common = cn(
    'absolute transition-opacity focus-visible:outline-2 focus-visible:outline-offset-4',
    dimmed && 'opacity-30',
  );
  const position = { left: box.x, top: box.y, width: box.w, height: box.h };
  const badge =
    node.status === 'attention' ? (
      <span className="pop-in absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-brand-500 text-ink shadow-[0_6px_12px_-4px_rgb(255_105_44/0.9)] ring-2 ring-white">
        <CircleAlert className="size-3.5" />
      </span>
    ) : node.status === 'fixed' ? (
      <span className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-ink text-cream shadow-[0_6px_12px_-6px_rgb(14_6_4/0.8)] ring-2 ring-white">
        <Lock className="size-3" />
      </span>
    ) : null;
  const ring = cn(
    'border-2 bg-white shadow-[0_6px_18px_-12px_rgba(14,6,4,0.35)]',
    style.ring,
    selected && 'ring-[3px] ring-ink/75 ring-offset-2 ring-offset-canvas',
    stopped && 'ring-[3px] ring-red-600 ring-offset-2 ring-offset-canvas',
  );
  const label = `${node.title}: ${node.statusLabel}`;

  if (box.shape === 'sub')
    return (
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        className={cn(common, 'group flex flex-col items-center text-center')}
        style={{ ...position, height: box.h + 64 }}
      >
        <span
          className={cn(
            'relative flex size-[72px] items-center justify-center rounded-full transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-105',
            ring,
          )}
        >
          <Icon className="size-7 text-stone-700" />
          {badge}
        </span>
        <span className="mt-2 w-[128px] text-[13px] font-semibold leading-tight text-ink">
          {node.title}
        </span>
        <span className="w-[128px] truncate text-[11px] text-stone-500">{node.subtitle}</span>
      </button>
    );

  if (box.shape === 'switch')
    return (
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        className={cn(common, 'group flex flex-col items-center')}
        style={{ ...position, height: box.h + 40 }}
      >
        <span
          className={cn(
            'relative flex size-[104px] items-center justify-center rounded-3xl transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-105',
            ring,
          )}
        >
          <Icon className="size-9 text-success-700" />
          {badge}
        </span>
        <span className="mt-2 text-[13px] font-semibold text-ink">{node.title}</span>
      </button>
    );

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        common,
        'flex items-center gap-2.5 px-3 text-left transition-[opacity,translate] duration-300 ease-[var(--ease-soft)] hover:-translate-y-0.5',
        ring,
        box.shape === 'trigger' ? 'rounded-l-[44px] rounded-r-2xl pl-4' : 'rounded-2xl',
        box.shape === 'agent' && 'rounded-[26px] shadow-[0_22px_44px_-26px_rgb(14_6_4/0.55)]',
      )}
      style={position}
    >
      {box.shape === 'trigger' && (
        <Zap className="absolute top-1/2 -left-5 size-4 -translate-y-1/2 fill-brand-500 text-brand-500" />
      )}
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-xl bg-ink text-brand-500 shadow-[0_8px_16px_-10px_rgb(14_6_4/0.7)]',
          box.shape === 'agent' ? 'size-12 -rotate-6 rounded-2xl' : 'size-9',
        )}
      >
        <Icon className={box.shape === 'agent' ? 'size-6' : 'size-[18px]'} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'line-clamp-2 font-semibold leading-tight text-ink',
            box.shape === 'agent'
              ? 'font-serif text-[24px] leading-[1.05] font-normal tracking-[-0.01em]'
              : 'text-[13.5px]',
          )}
        >
          {node.title}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-stone-500">{node.subtitle}</span>
        <span
          className={cn(
            'mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold',
            style.text,
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              style.dot,
              box.shape === 'trigger' && node.status === 'ready' && 'live-dot text-success-700',
            )}
          />
          {node.statusLabel}
        </span>
      </span>
      {badge}
    </button>
  );
}

function List({ title, items, icon: Icon }: { title: string; items: string[]; icon?: Icon }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="eyebrow">{title}</h3>
      <ul className="stagger mt-2 space-y-1.5 text-[13px] leading-relaxed text-stone-600">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            {Icon ? (
              <Icon className="mt-[3px] size-3.5 shrink-0 text-stone-400" />
            ) : (
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-brand-400" />
            )}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function replayNotes(
  node: FlowNodeId,
  explanation: TurnExplanation,
  productName: (id: string) => string,
): string[] {
  const { ai, decision } = explanation;
  switch (node) {
    case 'channel':
    case 'sandbox':
      return [
        explanation.channel === 'whatsapp' ? 'Arrived on WhatsApp.' : 'Sent from Test your bot.',
      ];
    case 'gates':
      return explanation.notice === 'burst'
        ? [NOTICE_LABELS.burst]
        : ai.skipped
          ? [SKIP_LABELS[ai.skipped]]
          : ['Passed: the bot was allowed to answer.'];
    case 'agent':
    case 'model':
      // A failed call or a reached AI limit (monthly, hourly or per customer) stopped here.
      if (
        explanation.notice === 'ai_error' ||
        explanation.notice === 'ai_budget' ||
        explanation.notice === 'hourly_limit' ||
        explanation.notice === 'customer_limit'
      )
        return [NOTICE_LABELS[explanation.notice]];
      if (!ai.called) return ['The AI model was not used for this reply.'];
      return [
        `Proposed: ${ai.proposed?.map((action) => action.type.replaceAll('_', ' ')).join(', ') || 'nothing'}.`,
        ...(ai.usage
          ? [
              `${ai.usage.inputTokens.toLocaleString('en-US')} input and ${ai.usage.outputTokens.toLocaleString('en-US')} output tokens, about $${ai.usage.costUsd.toFixed(4)}, ${(ai.usage.durationMs / 1000).toFixed(1)}s.`,
            ]
          : []),
      ];
    case 'instructions':
      if (decision.matchedRule)
        return [
          `Your rule “${decision.matchedRule.when}” matched (${decision.matchedRule.action}).`,
        ];
      if (decision.parts.includes('greeting')) return ['Your greeting was sent.'];
      if (decision.parts.includes('handoff_message')) return ['Your handoff message was sent.'];
      return ai.called && !explanation.notice
        ? ['No behavior rule matched; your goal and instructions guided the AI.']
        : [];
    case 'menu': {
      if (explanation.notice === 'menu_sync') return [NOTICE_LABELS.menu_sync];
      const items = [
        ...new Set(
          (ai.proposed ?? []).flatMap((action) =>
            action.productId ? [productName(action.productId)] : [],
          ),
        ),
      ];
      return items.length ? [`Items involved: ${items.join(', ')}.`] : [];
    }
    case 'engine':
      if (explanation.notice) return [];
      if (decision.corrections.length)
        return [`Made ${decision.corrections.length} correction(s); see “Why this reply”.`];
      return ai.called
        ? ['Accepted the AI’s proposal without corrections.']
        : ['Handled directly by the order engine (no AI proposal).'];
    case 'router':
      return [
        explanation.outcome === 'order'
          ? 'Saved an order and replied.'
          : explanation.outcome === 'staff'
            ? 'Replied and handed the chat to staff.'
            : 'Replied to the customer.',
      ];
    case 'order':
      return explanation.orderReference
        ? [`Order ${explanation.orderReference} saved as pending.`]
        : [];
    default:
      return [];
  }
}

function Inspector({
  node,
  explanation,
  productName,
  onOpen,
}: {
  node: FlowNode;
  explanation?: TurnExplanation;
  productName: (id: string) => string;
  onOpen: () => void;
}) {
  const Icon = ICONS[node.id];
  const style = STATUS_STYLE[node.status];
  const notes = explanation ? replayNotes(node.id, explanation, productName) : [];
  return (
    <section className="card p-5 sm:p-6" aria-labelledby="inspector-title" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 -rotate-6 items-center justify-center rounded-xl bg-ink text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.75)]">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 id="inspector-title" className="panel-title truncate">
              {node.title}
            </h2>
            <p className="truncate text-xs text-stone-500">{node.subtitle}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={
              node.status === 'ready' ? 'green' : node.status === 'attention' ? 'amber' : 'neutral'
            }
          >
            <span
              className={cn('mr-1 inline-block size-1.5 rounded-full align-middle', style.dot)}
            />
            {node.statusLabel}
          </Badge>
          {node.page && (
            <button className="btn btn-ink" onClick={onOpen}>
              Open {node.pageLabel}
              <ArrowRight className="size-4" />
            </button>
          )}
        </div>
      </div>
      {node.todo && (
        <p className="mt-4 flex gap-2.5 rounded-2xl border border-brand-500/25 bg-brand-500/[0.07] p-3.5 text-[13px] text-brand-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-brand-600" />
          {node.todo}
        </p>
      )}
      {!node.editable && (
        <p className="mt-4 flex gap-2.5 rounded-2xl border border-ink/[0.08] bg-ink/[0.03] p-3.5 text-[13px] text-stone-600">
          <Lock className="mt-0.5 size-4 shrink-0 text-stone-400" />
          Built into Orderly. You can’t change this part, but it explains how replies are produced.
        </p>
      )}
      {notes.length > 0 && (
        <div className="mt-4 rounded-2xl border border-brand-500/20 bg-white/80 p-3.5 shadow-[0_12px_24px_-18px_rgb(255_105_44/0.7)]">
          <List title="In this reply" items={notes} />
        </div>
      )}
      <p className="mt-4 text-[13.5px] leading-relaxed text-stone-700">{node.what}</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <List title="Takes in" items={node.receives} />
        <List title="Passes on" items={node.sends} />
      </div>
      {node.facts.length > 0 && (
        <div className="mt-5">
          <h3 className="eyebrow">Current settings</h3>
          <dl className="mt-2 divide-y divide-ink/[0.05] rounded-2xl border border-white bg-white/60 shadow-[0_10px_24px_-20px_rgb(14_6_4/0.4)]">
            {node.facts.map((fact) => (
              <div
                key={fact.label}
                className="flex flex-col gap-0.5 px-3 py-2 text-[13px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <dt className="shrink-0 text-stone-500">{fact.label}</dt>
                <dd
                  className={cn(
                    'min-w-0 break-words font-medium sm:text-right',
                    fact.tone === 'ok'
                      ? 'text-success-700'
                      : fact.tone === 'warn'
                        ? 'text-brand-700'
                        : fact.tone === 'muted'
                          ? 'text-stone-500'
                          : 'text-stone-800',
                  )}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <List title="How it shapes replies" items={node.affects} />
        <List title="Fixed by Orderly" items={node.fixed} icon={Lock} />
      </div>
    </section>
  );
}

function RecentReplies({
  items,
  selected,
  onSelect,
  onTest,
}: {
  items: RecentReply[];
  selected?: string;
  onSelect: (item: RecentReply) => void;
  onTest: () => void;
}) {
  return (
    <section className="card p-5 sm:p-6" aria-labelledby="recent-title">
      <h2 id="recent-title" className="panel-title">
        Why did it reply that way?
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-stone-500">
        Pick a recent bot reply to light up the path it took and see the reason.
      </p>
      {items.length ? (
        <ul className="stagger mt-4 space-y-2">
          {items.map((item) => (
            <li key={item.message.id}>
              <button
                type="button"
                aria-pressed={selected === item.message.id}
                onClick={() => onSelect(item)}
                className={cn(
                  'group lift w-full rounded-2xl border p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 ease-[var(--ease-soft)]',
                  selected === item.message.id
                    ? 'border-ink bg-ink shadow-[0_8px_18px_-8px_rgb(14_6_4/0.7)]'
                    : 'border-white bg-white/60 hover:bg-white',
                )}
              >
                <span className="flex items-center justify-between gap-2 text-[11px] text-stone-500 group-aria-pressed:text-cream/60">
                  <span className="truncate font-semibold text-stone-700 group-aria-pressed:text-cream">
                    {item.customerName || 'Customer'}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px]">
                    {item.channel === 'demo' ? 'Test chat' : 'WhatsApp'} ·{' '}
                    {shortDate(item.message.createdAt)}
                  </span>
                </span>
                <span className="mt-1 line-clamp-2 text-[12.5px] text-stone-700 group-aria-pressed:text-cream/90">
                  {item.message.text}
                </span>
                {item.message.explanation && (
                  <span className="mt-1.5 line-clamp-2 text-[11.5px] text-stone-500 group-aria-pressed:text-brand-300">
                    {explanationHeadline(item.message.explanation)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-ink/15 bg-paper/70 p-4 text-[13px] text-stone-500">
          No explained replies yet. New bot replies record why they were sent.
          <button className="btn mt-3 w-full" onClick={onTest}>
            Send a test message
            <ArrowRight className="size-4" />
          </button>
        </div>
      )}
    </section>
  );
}

function PlatformChecks({ checks }: { checks: NonNullable<Flow['platform']> }) {
  return (
    <section className="card p-5 sm:p-6" aria-labelledby="platform-title">
      <div className="flex items-center gap-2">
        <Server className="size-4 text-stone-400" />
        <h2 id="platform-title" className="panel-title">
          Server connections
        </h2>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-stone-500">
        Set by the platform administrator on the server. Only whether each one is set is shown.
      </p>
      <ul className="stagger mt-4 space-y-2.5">
        {checks.map((check) => (
          <li key={check.id} className="flex gap-2.5 text-[13px]">
            <span
              className={cn(
                'pop-in mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                check.ok
                  ? 'bg-success-700 text-white shadow-[0_6px_12px_-6px_rgb(23_124_74/0.9)]'
                  : 'bg-ink/[0.06] text-stone-400',
              )}
            >
              {check.ok ? <Check className="size-3" /> : <X className="size-3" />}
              <span className="sr-only">{check.ok ? 'Set:' : 'Not set:'}</span>
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-stone-800">{check.label}</span>
              <span className="block break-words text-xs text-stone-500">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
