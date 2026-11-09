import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Mail,
  MessageCircle,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { Integration } from '../shared/types';
import { isPassingSheetsProblem, projectOfHelper, withoutSeeFix } from '../shared/sheets-problems';
import { ApiError, api } from '../lib/api';
import {
  KEY_FILE_LIMIT,
  looksLikeKeyFile,
  serviceAccountKeyFrom,
  type ServiceAccountKey,
  sheetLinkProblem,
  sheetUrl,
  spreadsheetIdFrom,
} from '../lib/sheets-connect';
import {
  type GuideFacts,
  MAIN_PATH,
  SCREENS,
  type ScreenId,
  clearProgress,
  fillIn,
  fixFor,
  forgetsProgress,
  helpEmail,
  helpWhatsapp,
  loadProgress,
  nextScreen,
  previousScreen,
  resumable,
  saveProgress,
  startScreen,
} from '../lib/sheets-guide';
import { useWorkspace } from '../lib/workspace';
import { supportWhatsapp } from '../lib/support';
import { supportEmail } from './Public';
import { ActionButton, ErrorNotice, Field, Spinner } from './ui';

// The Google Sheets connect guide: one small screen at a time, each with a button to the exact
// Google page. Orderly then checks the connection itself, and whatever Google answers opens the
// screen that fixes it. The words are in src/lib/sheets-guide.ts.

export const SHEETS_CONNECTED = 'Google Sheets connected. New orders will be copied to your Sheet.';

/**
 * The settings as saved. Tab names lose stray spaces: the connection test ignores them, but
 * syncing reads the tab by the name exactly as typed.
 */
export const sheetsConfigForSave = (config: Record<string, string>) => ({
  ...config,
  clientEmail: config.clientEmail?.trim() ?? '',
  catalogSheet: config.catalogSheet?.trim() ?? '',
  ordersSheet: config.ordersSheet?.trim() ?? '',
});

/**
 * The key-file guide, folded away under "Connect with Google" when the server offers it, and
 * open by default when the business is connected with a key file already.
 */
export function KeyFileOption({
  collapsed,
  open,
  children,
}: {
  collapsed: boolean;
  open: boolean;
  children: ReactNode;
}) {
  // Only where it starts: the card refreshing after a check must not fold the guide shut on
  // "Your Sheet is connected". The dialog mounts this afresh each time it opens.
  const [initialOpen] = useState(open);
  if (!collapsed) return <>{children}</>;
  return (
    <details open={initialOpen} className="mt-5 rounded-2xl border border-ink/[0.06] bg-paper p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink marker:text-brand-500">
        Or use your own Google key file (harder, up to 45 minutes)
      </summary>
      <div className="mt-5">{children}</div>
    </details>
  );
}

/** Words with **Google's labels** in bold. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((part, index) =>
        index % 2 ? (
          <b key={index} className="font-semibold text-ink">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

function OpenButton({
  href,
  primary,
  children,
}: {
  href: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`btn ${primary ? 'btn-ink' : ''} w-full justify-center sm:w-auto`}
    >
      {children}
      <ExternalLink className="size-4" aria-hidden />
      <span className="sr-only"> (opens in a new page)</span>
    </a>
  );
}

function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="input min-w-0 flex-1 font-mono text-[12.5px]"
        readOnly
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="btn" onClick={copy}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

const CHECKING = 'Orderly is checking your connection…';
const STILL_THE_SAME =
  'Orderly checked again, and it is still the same. Google can take a few minutes after a change.';

const onPhone = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(pointer: coarse)').matches &&
  window.innerWidth < 768;

export function SheetsGuide({
  integration,
  problem,
  problemMessage,
  start,
  onClose,
}: {
  /** This business's Sheets connection, if any. */
  integration?: Integration;
  /** A code from the server that opened the guide: it starts at that fix. */
  problem?: string;
  problemMessage?: string;
  /** Opens at this screen instead, such as the help screen from elsewhere. */
  start?: ScreenId;
  onClose: () => void;
}) {
  const { data, refresh } = useWorkspace();
  const companyId = data.company.id;
  // A Sheet connected with Google has its own section above; this guide is for a key file.
  const keyConnection = !!integration?.configured && integration.config.auth !== 'oauth';
  // A code is only shown with its message: a code left behind without one is old.
  const recorded = integration?.error ? integration.errorCode : undefined;
  const [saved] = useState(() => loadProgress(companyId));
  const [screenId, setScreenId] = useState<ScreenId>(
    () =>
      start ??
      startScreen({
        problem,
        errorCode: recorded,
        status: integration?.status,
        keyConnection,
        saved: saved?.screen,
      }),
  );
  const [history, setHistory] = useState<ScreenId[]>([]);
  // A connected Sheet, key file or Google, is the one to fix (a renamed tab needs its link too).
  // Only before anything is connected does the link from an unfinished guide come back.
  const ownSheet = keyConnection || problem ? integration?.config.spreadsheetId || '' : '';
  const savedLink = !integration?.configured ? (saved?.link ?? '') : '';
  const [config, setConfig] = useState<Record<string, string>>(() => ({
    spreadsheetId: ownSheet || (savedLink ? (spreadsheetIdFrom(savedLink) ?? '') : ''),
    clientEmail: keyConnection ? integration?.config.clientEmail || '' : '',
    catalogSheet: integration?.config.catalogSheet || 'Menu',
    ordersSheet: integration?.config.ordersSheet || 'Orders',
  }));
  const [link, setLink] = useState(() => (ownSheet ? sheetUrl(ownSheet) : savedLink));
  // A key just read and not saved yet. Once saved it is dropped from the page.
  const [secret, setSecret] = useState('');
  const [keySaved, setKeySaved] = useState(keyConnection);
  const [keyError, setKeyError] = useState('');
  // A key file was read in this guide, or before a restart: "Delete your copy" comes at the end.
  const [keyRead, setKeyRead] = useState(!!saved?.keyUploaded);
  // A key file read on this screen, which a fix for a broken key needs before Check again.
  const [freshKey, setFreshKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState(problemMessage ?? integration?.error ?? '');
  const [code, setCode] = useState(problem ?? recorded);
  // How many checks in a row came back to the same screen.
  const [tries, setTries] = useState(0);
  // On a fix rather than the first time through: the key step then goes back to the check.
  // Set when the guide opens at a fix or a check opens one; a "Still stuck" detour doesn't.
  const [fixing, setFixing] = useState(screenId.startsWith('fix-'));
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstScreen = useRef(true);
  // The screen now, for a check that ends after the owner has moved on.
  const current = useRef(screenId);
  current.current = screenId;
  const screen = SCREENS[screenId];
  const facts: GuideFacts = {
    project: projectOfHelper(config.clientEmail) ?? '',
    spreadsheetId: config.spreadsheetId ?? '',
    email: config.clientEmail?.trim() ?? '',
    ordersTab: config.ordersSheet?.trim() || 'Orders',
    menuTab: config.catalogSheet?.trim() || 'Menu',
    ctrl:
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
        ? 'Command'
        : 'Ctrl',
    page: typeof window !== 'undefined' ? window.location.href : '',
  };
  const fill = (text: string) => fillIn(text, facts);
  const pathStep = MAIN_PATH.indexOf(screenId);

  // The owner is on another page half the time: where they were survives closing this. Only a
  // step or the check is kept (see resumable), and the start isn't progress at all.
  useEffect(() => {
    if (forgetsProgress(screenId, { link, keyRead })) clearProgress(companyId);
    else if (resumable(screenId))
      saveProgress(companyId, { screen: screenId, link, ...(keyRead && { keyUploaded: true }) });
  }, [companyId, screenId, link, keyRead]);
  // Each new screen starts at its progress bar and title, read out from the title.
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    root.current?.scrollIntoView?.({ block: 'start' });
  }, [screenId]);

  // Waiting on Google: a visible countdown, then the check runs by itself, a few times at most.
  // The countdown is set with each screen change, so it never reads a stale zero.
  const [seconds, setSeconds] = useState(screen.wait ?? 0);
  const autoChecks = useRef(0);
  const show = (next: ScreenId) => {
    setScreenId(next);
    setTries(0);
    setFreshKey(false);
    setSeconds(SCREENS[next].wait ?? 0);
    autoChecks.current = 0;
  };
  const goTo = (next: ScreenId) => {
    if (next === screenId) return;
    setHistory((past) => [...past, screenId]);
    show(next);
  };
  // Back retraces this visit; on a step the guide reopened at, it goes to the step before.
  const backTo = history[history.length - 1] ?? previousScreen(screenId);
  const back = () => {
    if (!backTo) return;
    if (history.length) setHistory((past) => past.slice(0, -1));
    show(backTo);
  };
  const save = async (settings = config, key = secret) => {
    await api(`/integrations/sheets`, companyId, {
      config: sheetsConfigForSave(settings),
      ...(key.trim() ? { secret: key.trim() } : {}),
    });
    if (key.trim()) setKeySaved(true);
    setSecret('');
    setDirty(false);
  };
  /** Checks the connection; what Google answers decides the next screen. */
  const check = async (quiet = false) => {
    const startedOn = screenId;
    setChecking(true);
    try {
      if (dirty || secret) await save();
      await api('/integrations/sheets/test', companyId, {});
      setMessage('');
      setCode(undefined);
      // The owner went to another screen meanwhile: the card shows the result, and they stay.
      if (current.current === startedOn) goTo('connected');
    } catch (e) {
      const failure = e instanceof ApiError ? e.code : undefined;
      if (current.current !== startedOn) return;
      // Checked just after the switch: the Sheet isn't shared until the next steps, so a refusal
      // to open it is expected, and Google being slow can wait. Anything else is fixed now.
      if (
        quiet &&
        (failure === 'SHEET_NOT_SHARED' ||
          failure === 'SHEET_VIEW_ONLY' ||
          isPassingSheetsProblem(failure))
      ) {
        goTo(nextScreen(screenId, { keySaved: true, fixing }));
        return;
      }
      setMessage((e as Error).message);
      setCode(failure);
      const fix = fixFor(failure);
      if (fix === screenId) {
        setTries((n) => n + 1);
        setSeconds(screen.wait ?? 0);
      } else {
        setFixing(true);
        goTo(fix);
      }
    } finally {
      setChecking(false);
      void refresh().catch(() => undefined);
    }
  };
  const applyKey = (key: ServiceAccountKey) => {
    const settings = { ...config, clientEmail: key.clientEmail };
    setKeyError('');
    setConfig(settings);
    setSecret(key.privateKey);
    setKeyRead(true);
    setFreshKey(true);
    // Saved at once, so the owner can stop here and not upload it again. A refusal keeps the key
    // on the page, and the check tries again.
    void save(settings, key.privateKey).catch((e: Error) => {
      if (e instanceof ApiError && e.code === 'SHEET_TAKEN') {
        setMessage(e.message);
        setCode(e.code);
        goTo('fix-sheet-taken');
      }
    });
  };
  // From the file picker or a file dropped on the box.
  const readKeyFile = async (file: File) => {
    if (file.size > KEY_FILE_LIMIT) {
      setKeyError(
        'This file is too big to be the key file. Choose the newest file Google downloaded.',
      );
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setKeyError('That file couldn’t be read. Choose it again.');
      return;
    }
    const key = serviceAccountKeyFrom(text);
    if ('error' in key) setKeyError(key.error);
    else applyKey(key);
  };
  const setSetting = (name: string, value: string) => {
    setConfig({ ...config, [name]: value });
    setDirty(true);
  };

  useEffect(() => {
    if (!screen.wait || checking || autoChecks.current >= 4) return;
    if (seconds <= 0) {
      autoChecks.current += 1;
      void check();
      return;
    }
    const timer = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // check is rebuilt each render; the countdown only depends on these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, checking, screen.wait]);

  const linkProblem = sheetLinkProblem(link);
  const linkFound = !linkProblem && !!config.spreadsheetId;
  // A fix for a broken key needs a new file chosen here: the saved key is the broken one.
  const brokenKey = screenId === 'fix-key-file' && !!code;
  const blocked =
    (screen.box === 'link' && !linkFound) ||
    (screen.box === 'key' && !secret.trim() && !freshKey && (!keySaved || brokenKey));
  const justUploaded = keyRead && screenId === 'connected';
  const main = () => {
    if (screenId === 'get-help' || screenId === 'fix-wrong-account') {
      // Opened straight on this screen there is nothing to go back to: the start, or the check.
      if (!history.length) return goTo(keySaved ? 'check' : 'intro');
      return back();
    }
    if (screen.finish && !justUploaded) {
      clearProgress(companyId);
      return onClose();
    }
    if (justUploaded) return goTo('delete-key');
    if (screen.check) return void check();
    // The switch was just turned on: check it now, before asking for the share.
    if (screenId === 'turn-on-sheets') return void check(true);
    if (screen.rejoin) setFixing(false);
    if (screenId === 'intro' && onPhone()) return goTo('use-computer');
    // A new link after "already linked": the key read at the key step is still here, unsaved, so
    // that step comes next rather than making a second key.
    if (screenId === 'copy-link' && !keySaved && secret.trim()) return goTo('upload-key');
    goTo(nextScreen(screenId, { keySaved, fixing: fixing && !screen.rejoin }));
  };
  // The step the owner was on when they asked for help, and what Orderly last said.
  const help = {
    business: data.company.name,
    screenTitle: fill(SCREENS[history[history.length - 1] ?? screenId].title),
    problem: code,
    // Without "Click Test on the card": that is for the owner, not for Orderly.
    message: code ? withoutSeeFix(message) : undefined,
  };
  const mainLabel = justUploaded
    ? 'One last thing'
    : (screen.nextLabel ?? (screen.check ? 'Check again' : 'I did it, next step'));

  return (
    <div ref={root} className="scroll-mt-4 text-sm text-stone-600">
      {pathStep >= 0 && (
        <div className="mb-5">
          <p className="mb-2 text-xs font-semibold text-stone-500">
            Step {pathStep + 1} of {MAIN_PATH.length}
          </p>
          <div
            role="progressbar"
            aria-label="Your progress"
            aria-valuemin={0}
            aria-valuemax={MAIN_PATH.length}
            aria-valuenow={pathStep + 1}
            className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]"
          >
            <div
              className="h-full origin-left rounded-full bg-brand-500 transition-transform duration-300"
              style={{ transform: `scaleX(${(pathStep + 1) / MAIN_PATH.length})` }}
            />
          </div>
        </div>
      )}
      <div key={screenId} className="step-in space-y-4">
        <h3 ref={heading} tabIndex={-1} className="panel-title outline-none">
          {fill(screen.title)}
        </h3>
        {screen.what && (
          <p className="leading-relaxed">
            <Rich text={fill(screen.what)} />
          </p>
        )}
        {screen.box === 'message' && message && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">
            {message}
          </p>
        )}
        {screen.steps && (
          <ol className="list-decimal space-y-2 pl-5 leading-relaxed marker:font-semibold marker:text-stone-500">
            {screen.steps.map((step) => (
              <li key={step}>
                <Rich text={fill(step)} />
              </li>
            ))}
          </ol>
        )}
        {screen.box === 'email' && <CopyBox value={facts.email} label="Your helper’s long email" />}
        {screen.open && (
          <div className="space-y-2">
            <OpenButton href={fill(screen.open.url)} primary>
              {screen.open.label}
            </OpenButton>
            <p className="text-xs text-stone-500">
              It opens in a new page. When you have done that, come back to this page.
            </p>
          </div>
        )}
        {screen.box === 'link' && (
          <div className="space-y-2">
            <Field label="Google Sheet link">
              <input
                className="input"
                value={link}
                inputMode="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                aria-invalid={!!linkProblem}
                autoComplete="off"
                onChange={(e) => {
                  setLink(e.target.value);
                  setSetting('spreadsheetId', spreadsheetIdFrom(e.target.value) ?? '');
                }}
              />
            </Field>
            {/* Polite, not an alert: typing a link by hand passes through "not a link" on the way. */}
            <div aria-live="polite">
              {linkProblem ? (
                <p className="text-xs font-medium text-red-700">{linkProblem}</p>
              ) : (
                linkFound && (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                    <Check className="size-3.5" aria-hidden />
                    Link looks right.
                  </p>
                )
              )}
            </div>
          </div>
        )}
        {screen.box === 'key' && (
          <div className="space-y-2">
            {/* A file dropped anywhere on the box is read too, not opened by the browser in place
                of the dashboard. The ring shows keyboard focus on the bare file input. */}
            <label
              className="group block cursor-pointer rounded-2xl border-2 border-dashed border-ink/15 bg-paper p-5 text-center transition-colors hover:border-brand-500/45 hover:bg-brand-50/70 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-brand-700"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) void readKeyFile(file);
              }}
            >
              <Upload
                aria-hidden
                className="mx-auto mb-2 size-5 text-brand-600 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-translate-y-1"
              />
              <span className="block text-sm font-semibold text-ink">Choose the key file</span>
              <input
                className="mt-3 max-w-full text-xs text-stone-500 file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-ink file:px-4 file:py-2 file:font-semibold file:text-cream"
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Cleared, so choosing the same file again (after an error) reads it again.
                  e.target.value = '';
                  if (file) void readKeyFile(file);
                }}
              />
            </label>
            <ErrorNotice message={keyError} onDismiss={() => setKeyError('')} />
            <div aria-live="polite">
              {freshKey || (!keySaved && !!secret.trim()) ? (
                <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                  <Check className="size-3.5 shrink-0" aria-hidden />
                  Key file read.
                </p>
              ) : (
                keySaved &&
                !brokenKey && (
                  <p className="text-xs text-stone-500">
                    A key is already saved. Choose a new file only to replace it.
                  </p>
                )
              )}
            </div>
          </div>
        )}
        {screenId === 'get-help' && (
          <div className="space-y-2">
            {supportWhatsapp && (
              <div className="pb-2">
                <OpenButton href={helpWhatsapp({ ...help, to: supportWhatsapp })} primary>
                  <MessageCircle className="size-4" aria-hidden />
                  Message Orderly on WhatsApp
                </OpenButton>
              </div>
            )}
            <a
              className={`btn ${supportWhatsapp ? '' : 'btn-ink'} w-full justify-center sm:w-auto`}
              href={helpEmail({ ...help, to: supportEmail })}
            >
              <Mail className="size-4" aria-hidden />
              Email Orderly
            </a>
            <p className="text-xs text-stone-500">Or write to this address yourself:</p>
            <CopyBox value={supportEmail} label="Orderly’s help address" />
          </div>
        )}
        {screen.see && (
          <p className="flex items-start gap-2 rounded-xl bg-paper px-3 py-2 text-[13px] leading-relaxed">
            <Check className="mt-0.5 size-3.5 shrink-0 text-green-700" aria-hidden />
            <span>
              <b className="font-semibold text-ink">You should now see: </b>
              <Rich text={fill(screen.see)} />
            </span>
          </p>
        )}
        {screen.wait && !checking && seconds > 0 && autoChecks.current < 4 ? (
          <p className="text-[13px] font-medium text-ink" aria-live="off">
            Checking again in {seconds} seconds…
          </p>
        ) : null}
        {/* One region, there from the screen's start, so a screen reader reads each change. The
            words below repeat it for the eye. */}
        <p className="sr-only" role="status">
          {checking ? CHECKING : tries > 0 ? STILL_THE_SAME : ''}
        </p>
        {checking && (
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink" aria-hidden>
            <Spinner />
            {CHECKING}
          </p>
        )}
        {tries > 0 && !checking && (
          <div className="rounded-xl bg-sun/20 px-3 py-2 text-[13px] leading-relaxed text-stone-700">
            <span aria-hidden>{STILL_THE_SAME}</span>{' '}
            {tries > 1 && (
              <button
                type="button"
                className="font-semibold text-brand-700 underline underline-offset-2"
                onClick={() => goTo('get-help')}
              >
                Ask Orderly for help
              </button>
            )}
          </div>
        )}
        {screen.choices && (
          <div className="flex flex-col gap-2">
            {screen.choices.map((choice) => (
              <button
                key={choice.screen}
                type="button"
                className="btn justify-between"
                onClick={() => goTo(choice.screen)}
              >
                {choice.label}
                <ArrowRight className="size-4" aria-hidden />
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/[0.06] pt-4">
          {backTo && screenId !== 'get-help' && screenId !== 'fix-wrong-account' ? (
            <button type="button" className="btn btn-quiet" onClick={back} disabled={checking}>
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </button>
          ) : (
            <span />
          )}
          {!screen.choices && (
            <ActionButton
              type="button"
              className="btn-primary"
              disabled={blocked}
              loading={checking}
              loadingLabel="Checking…"
              onClick={main}
            >
              {screen.check && <RefreshCw className="size-4" aria-hidden />}
              {mainLabel}
              {!screen.check && <ArrowRight className="size-4" aria-hidden />}
            </ActionButton>
          )}
        </div>
        {screen.also && (
          <button
            type="button"
            className="text-[13px] font-semibold text-brand-700 underline underline-offset-2"
            onClick={() => goTo(screen.also!.screen)}
          >
            {screen.also.label}
          </button>
        )}
        {screenId !== 'get-help' && (
          <details className="rounded-2xl border border-ink/[0.06] bg-paper p-4 text-[13px] leading-relaxed">
            <summary className="cursor-pointer font-semibold text-ink marker:text-brand-500">
              {screenId === 'intro' ? 'Any questions?' : 'Still stuck?'}
            </summary>
            <div className="mt-3 space-y-3">
              {(screen.stuck ?? []).map((answer) => (
                <div key={answer.q}>
                  <p className="font-semibold text-stone-800">{answer.q}</p>
                  <p className="mt-0.5">
                    <Rich text={fill(answer.a)} />
                  </p>
                  {answer.go && (
                    <button
                      type="button"
                      className="mt-1 font-semibold text-brand-700 underline underline-offset-2"
                      onClick={() => goTo(answer.go!.screen)}
                    >
                      {answer.go.label}
                    </button>
                  )}
                  {answer.open && (
                    <a
                      href={answer.open.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 font-semibold text-brand-700 underline underline-offset-2"
                    >
                      {answer.open.label}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </div>
              ))}
              <div>
                <p className="font-semibold text-stone-800">Something else?</p>
                <button
                  type="button"
                  className="mt-0.5 font-semibold text-brand-700 underline underline-offset-2"
                  onClick={() => goTo('get-help')}
                >
                  Ask Orderly for help
                </button>
              </div>
            </div>
          </details>
        )}
        {(screenId === 'upload-key' || screenId === 'change') && (
          <details className="rounded-2xl border border-ink/[0.06] bg-paper p-4">
            <summary className="cursor-pointer text-[13px] font-semibold text-ink marker:text-brand-500">
              More options, for people comfortable with Google Cloud
            </summary>
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Menu tab name">
                  <input
                    className="input"
                    value={config.catalogSheet || ''}
                    onChange={(e) => setSetting('catalogSheet', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Orders tab name">
                  <input
                    className="input"
                    value={config.ordersSheet || ''}
                    onChange={(e) => setSetting('ordersSheet', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="Service account email">
                <input
                  className="input"
                  value={config.clientEmail || ''}
                  onChange={(e) => setSetting('clientEmail', e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Service account private key (PEM)"
                hint={
                  keySaved
                    ? 'Leave empty to keep the saved key. Saved keys are never shown here.'
                    : 'Stored encrypted on this server. You can also paste the whole key file here.'
                }
              >
                <textarea
                  className="input min-h-28 font-mono text-xs"
                  value={secret}
                  onChange={(e) => {
                    // A whole key file pasted here fills the email and keeps only its key.
                    const key = looksLikeKeyFile(e.target.value)
                      ? serviceAccountKeyFrom(e.target.value)
                      : undefined;
                    if (key && !('error' in key)) applyKey(key);
                    else {
                      setSecret(e.target.value);
                      setDirty(true);
                    }
                  }}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  autoComplete="off"
                  // A private key: no cloud spell-checker or Grammarly reads it.
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  data-gramm="false"
                  data-gramm_editor="false"
                  data-enable-grammarly="false"
                />
              </Field>
              {screenId === 'change' && (
                <ActionButton
                  type="button"
                  className="btn-primary"
                  loading={checking}
                  loadingLabel="Checking…"
                  onClick={() => void check()}
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Save and check
                </ActionButton>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
