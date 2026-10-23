import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Info } from 'lucide-react';
import type { Integration } from '../shared/types';
import { useWorkspace } from '../lib/workspace';
import { inAppBrowser, loadGis, requestGoogleCode } from '../lib/google-connect';
import { sheetUrl } from '../lib/sheets-connect';
import { cn } from '../lib/utils';
import { ActionButton, ErrorNotice } from './ui';

/** The server's answer to a finished "Connect with Google". */
export interface GoogleSheetsConnected {
  integration: Integration;
  created: boolean;
  title: string;
}

/** The notification after connecting: where the Sheet is. */
export const connectedText = (result: GoogleSheetsConnected) =>
  result.created
    ? `Google Sheets connected. Your new Sheet “${result.title}” is in your Google Drive.`
    : 'Google Sheets reconnected. Orderly keeps using your Sheet.';

/**
 * "Connect with Google" in the Sheets dialog: one click, the owner picks their Google account and
 * clicks Allow, and Orderly makes the order Sheet in their Drive. Once connected it shows which
 * account and the Sheet, and reconnects when Google's access has ended.
 */
export function GoogleSheetsConnect({
  clientId,
  integration,
  onConnected,
}: {
  clientId: string;
  /** This business's Sheets connection, if any (made with Google or with a key file). */
  integration?: Integration;
  onConnected: (result: GoogleSheetsConnected) => void;
}) {
  const { mutate, refresh } = useWorkspace();
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState('');
  const [tryHere, setTryHere] = useState(false);
  const [copied, setCopied] = useState(false);
  // Shown when copying didn't work, to copy by hand.
  const [showLink, setShowLink] = useState(false);
  // Google refuses to sign in inside apps' built-in browsers: say so before the owner tries.
  const [inApp] = useState(() =>
    typeof navigator === 'undefined' ? undefined : inAppBrowser(navigator.userAgent),
  );
  // Loaded ahead of the click, so Google's window opens straight from it (no popup block).
  const load = (live: () => boolean = () => true) => {
    setLoadFailed(false);
    loadGis().then(
      () => live() && setReady(true),
      (e: Error) => {
        if (!live()) return;
        setLoadFailed(true);
        setProblem(e.message);
      },
    );
  };
  useEffect(() => {
    let live = true;
    load(() => live);
    return () => {
      live = false;
    };
  }, []);
  const google = integration?.config.auth === 'oauth';
  const email = integration?.config.googleEmail;
  const connect = () => {
    setProblem('');
    setWorking(true);
    requestGoogleCode(clientId, {
      onCode: (code) =>
        void mutate<GoogleSheetsConnected>('/google/sheets/connect', { code }, undefined, {
          dialog: true,
        })
          .then(onConnected)
          // A Sheet made but failing its check is saved with the reason: the card shows it.
          .catch(() => refresh().catch(() => undefined))
          .finally(() => setWorking(false)),
      onError: (message) => {
        setWorking(false);
        setProblem(message);
      },
    });
  };
  const copyLink = () => {
    const copying = navigator.clipboard?.writeText(window.location.href);
    if (!copying) {
      setShowLink(true);
      return;
    }
    copying.then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setShowLink(true),
    );
  };
  const blocked = !!inApp && !tryHere;
  const button = loadFailed ? (
    <button
      type="button"
      className="btn"
      onClick={() => {
        setProblem('');
        load();
      }}
    >
      Load Google again
    </button>
  ) : (
    <ActionButton
      type="button"
      // Reconnecting is the main action only when Google's access has ended.
      className={cn((!google || integration?.error) && 'btn-primary', !google && 'w-full')}
      loading={working || !ready}
      loadingLabel={ready ? 'Waiting for Google…' : 'Loading Google…'}
      onClick={connect}
    >
      {google ? 'Reconnect Google' : 'Connect with Google'}
    </ActionButton>
  );
  return (
    <section
      aria-labelledby="google-connect-title"
      className="space-y-4 rounded-2xl border border-brand-500/20 bg-brand-50/60 p-5"
    >
      {google ? (
        <div className="space-y-1.5 text-[13px] leading-relaxed text-stone-600">
          <h3
            id="google-connect-title"
            className="flex items-center gap-2 text-sm font-semibold text-ink"
          >
            <Check className="size-4 shrink-0 text-green-700" aria-hidden />
            {email ? `Connected with Google as ${email}` : 'Connected with Google'}
          </h3>
          <p>
            Every new order is added to your Sheet.{' '}
            {integration?.config.spreadsheetId && (
              <a
                href={sheetUrl(integration.config.spreadsheetId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-4 hover:underline"
              >
                Open your Sheet
                <ExternalLink className="size-3" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </p>
          {integration?.error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              {integration.error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5 text-[13px] leading-relaxed text-stone-600">
          <h3 id="google-connect-title" className="text-sm font-semibold text-ink">
            Connect with Google (about a minute)
          </h3>
          <p>
            Orderly makes a new Sheet in your Google Drive and adds every order to it. Pick your
            Google account, then click <b>Allow</b>. Orderly can only open the files it makes.
          </p>
          <p className="text-xs text-stone-500">
            Google’s window may show Orderly’s web address instead of the name Orderly. That’s fine.
          </p>
          {integration?.configured && (
            <p className="text-xs text-stone-500">
              You’re connected with a key file now. Connecting with Google makes a new Sheet: new
              orders go there, and if your menu is in your Sheet it is copied there too, so edit it
              in the new Sheet from then on. Your current Sheet is kept but no longer updated.
            </p>
          )}
        </div>
      )}
      {blocked ? (
        <div className="space-y-3 rounded-xl bg-sun/20 p-3.5 text-xs leading-relaxed text-stone-700">
          <p className="flex items-start gap-2">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Google doesn’t allow signing in inside {inApp}’s built-in browser. Open this page in
            Chrome (Android) or Safari (iPhone): tap ⋮ or ••• and choose Open in browser, then click
            Connect with Google there.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={copyLink}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy this page’s link'}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setTryHere(true)}>
              Try here anyway
            </button>
          </div>
          {showLink && (
            <input
              className="input font-mono text-[12px]"
              readOnly
              aria-label="This page’s link"
              value={window.location.href}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      ) : (
        button
      )}
      <ErrorNotice message={problem} onDismiss={() => setProblem('')} />
    </section>
  );
}
