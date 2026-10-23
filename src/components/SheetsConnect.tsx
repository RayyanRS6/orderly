import { useState, type ReactNode } from 'react';
import { Check, Copy, Download, ExternalLink, Upload } from 'lucide-react';
import {
  KEY_FILE_LIMIT,
  looksLikeKeyFile,
  serviceAccountKeyFrom,
  type ServiceAccountKey,
  sheetLinkProblem,
  sheetUrl,
  spreadsheetIdFrom,
} from '../lib/sheets-connect';
import { supportEmail } from './Public';
import { ErrorNotice, Field } from './ui';

// The Google Sheets connect form: what the owner does, step by step, with each box in the
// step that fills it. The owner pastes the Sheet's link and uploads the key file Google
// downloads; the email, private key and tab names can still be typed under More options.

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

/** Why the form can't be saved yet, pointing at the step to finish; undefined when it can. */
export function sheetsFormProblem(
  config: Record<string, string>,
  secret: string,
  keySaved: boolean,
): string | undefined {
  if (!config.spreadsheetId) return 'Paste your Google Sheet’s link in step 2.';
  if (!config.clientEmail || (!keySaved && !secret.trim())) return 'Upload the key file in step 4.';
  // A pasted file that is not a key file stays as typed under More options.
  if (looksLikeKeyFile(secret))
    return 'The private key box holds a file that isn’t a Google key file. Upload the key file in step 4 instead.';
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex size-8 shrink-0 -rotate-6 items-center justify-center rounded-xl bg-ink font-serif text-[17px] text-cream shadow-[0_8px_16px_-8px_rgb(14_6_4/0.6)]"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        {/* Messages point at "step 4": the number is read out here, not from the badge. */}
        <h3 className="font-semibold text-stone-800">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        <div className="mt-1 space-y-2.5 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
    >
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function SheetsConnect({
  config,
  onConfig,
  secret,
  onSecret,
  keySaved,
}: {
  config: Record<string, string>;
  onConfig: (config: Record<string, string>) => void;
  secret: string;
  onSecret: (secret: string) => void;
  /** A key is already saved for this business: uploading a new one is optional. */
  keySaved: boolean;
}) {
  const [link, setLink] = useState(config.spreadsheetId ? sheetUrl(config.spreadsheetId) : '');
  const [keyError, setKeyError] = useState('');
  const [copied, setCopied] = useState(false);
  const linkProblem = sheetLinkProblem(link);
  const email = config.clientEmail?.trim();
  const applyKey = (key: ServiceAccountKey) => {
    setKeyError('');
    onConfig({ ...config, clientEmail: key.clientEmail });
    onSecret(key.privateKey);
  };
  // From the file picker or a file dropped on the box.
  const readKeyFile = async (file: File) => {
    if (file.size > KEY_FILE_LIMIT) {
      setKeyError('This file is too big to be a key file. Choose the .json file from step 3.');
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
  const copy = () =>
    navigator.clipboard?.writeText(email || '').then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  return (
    <div className="space-y-6">
      <p className="rounded-2xl border border-ink/[0.06] bg-paper p-3.5 text-xs leading-relaxed text-stone-600">
        <b className="text-ink">Before you start:</b> use a computer, and a personal Google account
        (one ending in @gmail.com) if you can: work and school accounts may not let you share your
        Sheet in step 5. It takes about 15 minutes and costs nothing.
      </p>
      <ol className="space-y-6 text-sm text-stone-600">
        <Step n={1} title="Make your Google Sheet">
          <p>
            Open <Out href="https://sheets.new">a new Google Sheet</Out>. At the bottom left,
            double-click the first tab (it may be called <b>Sheet1</b>) and type <b>Orders</b>.
            Leave this tab empty: Orderly adds the column titles, then one row for every order.
          </p>
          <p className="text-xs text-stone-500">
            Already have an Excel file? Open it in Google Sheets and choose File → Save as Google
            Sheets. That makes a new copy: use the new copy from here on.
          </p>
          <p className="text-xs text-stone-500">
            Want to edit your menu in the Sheet too? Click <b>+</b> at the bottom left, then
            double-click the new tab and type <b>Menu</b>. With it open, choose File → Import →
            Upload, pick our{' '}
            <a
              href="/examples/menu.csv"
              download
              className="inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-4 hover:underline"
            >
              <Download className="size-3" aria-hidden />
              menu template
            </a>
            , choose <b>Replace current sheet</b> and import it. Put your own dishes in place of the
            samples. Once connected, choose <b>Connected Google Sheet</b> under Settings → Menu
            source.
          </p>
        </Step>
        <Step n={2} title="Paste the Sheet’s link">
          <p>
            With your Sheet open, copy the whole link from the address bar at the top of your
            browser and paste it here.
          </p>
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
                onConfig({ ...config, spreadsheetId: spreadsheetIdFrom(e.target.value) ?? '' });
              }}
            />
          </Field>
          {/* Polite, not an alert: typing a link by hand passes through "not a link" on the way. */}
          <div aria-live="polite">
            {linkProblem ? (
              <p className="text-xs font-medium text-red-700">{linkProblem}</p>
            ) : (
              config.spreadsheetId && (
                <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                  <Check className="size-3.5" aria-hidden />
                  Sheet found. <Out href={sheetUrl(config.spreadsheetId)}>Open it</Out>
                </p>
              )
            )}
          </div>
        </Step>
        <Step n={3} title="Get a key file from Google (once, about 10 minutes)">
          <p>
            Orderly writes into your Sheet through a Google helper account that you make, called a{' '}
            <i>service account</i>. It’s free, and it can only open the Sheets you share with it.
            Google may first ask you to turn on 2-Step Verification and to accept its terms. You
            don’t need a free trial or a card: skip those offers.
          </p>
          <ol className="list-[lower-alpha] space-y-2 pl-5 marker:font-semibold marker:text-stone-500">
            <li>
              <Out href="https://console.cloud.google.com/projectcreate">Create a project</Out>.
              Type the name <b>Orderly</b>, leave the rest as it is and click <b>Create</b>.
            </li>
            <li>
              <Out href="https://console.cloud.google.com/flows/enableapi?apiid=sheets.googleapis.com">
                Turn on the Google Sheets API
              </Out>
              . If Google asks, pick the <b>Orderly</b> project, then confirm to enable it.
            </li>
            <li>
              <Out href="https://console.cloud.google.com/projectselector/iam-admin/serviceaccounts/create">
                Make the helper account
              </Out>
              . Pick the <b>Orderly</b> project if asked, type the name <b>orderly</b> and click{' '}
              <b>Done</b>. Skip the optional parts.
            </li>
            <li>
              <Out href="https://console.cloud.google.com/iam-admin/serviceaccounts">
                Open your helper accounts
              </Out>{' '}
              and click the one you just made. Open the <b>Keys</b> tab, then <b>Add key</b> →{' '}
              <b>Create new key</b> → <b>JSON</b> → <b>Create</b>. A file ending in <b>.json</b>{' '}
              downloads to your computer. Keep it private like a password: don’t send it on WhatsApp
              or by email.
            </li>
          </ol>
          <p>
            If Google says “Service account key creation is disabled”, that’s a setting Google turns
            on for many new accounts, personal Gmail included. It isn’t your mistake: email Orderly
            support at{' '}
            <a
              className="font-semibold text-brand-700 underline-offset-4 hover:underline"
              href={`mailto:${supportEmail}`}
            >
              {supportEmail}
            </a>{' '}
            and we’ll help you finish. The same goes if you get stuck anywhere else.
          </p>
        </Step>
        <Step n={4} title="Upload the key file">
          <p>Choose the .json file Google downloaded. It’s usually in your Downloads folder.</p>
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
            <span className="block text-sm font-semibold text-ink">
              {keySaved && !secret ? 'Choose a new key file' : 'Choose the key file'}
            </span>
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
          {secret && email ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
              <Check className="size-3.5 shrink-0" aria-hidden />
              Key file read.
            </p>
          ) : (
            keySaved && (
              <p className="text-xs text-stone-500">
                A key is already saved. Upload a new key file only to replace it.
              </p>
            )
          )}
        </Step>
        <Step n={5} title="Share your Sheet with the helper account">
          {email ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-0 font-mono text-[12.5px] sm:flex-1"
                  readOnly
                  aria-label="Helper account email"
                  value={email}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" className="btn" onClick={copy}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>
                In your Sheet, click <b>Share</b> at the top right and paste this email. Check that
                it says <b>Editor</b>, untick <b>Notify people</b> and click <b>Send</b> (it may say{' '}
                <b>Share</b>).
              </p>
              <p className="text-xs text-stone-500">
                Leave General access on <b>Restricted</b>: your Orders tab will hold customers’
                names, phone numbers and addresses.
              </p>
            </>
          ) : (
            <p>
              The helper account’s email shows here after step 4. You’ll share your Sheet with it.
            </p>
          )}
        </Step>
        <Step n={6} title="Save and test">
          <p>
            Click <b>Save and test</b> below. If you made the key just now, wait a minute first.
            Orderly checks that it can open your Sheet and write to the <b>Orders</b> tab, and if
            something is missing it says what to fix.
          </p>
        </Step>
      </ol>
      <details className="rounded-2xl border border-ink/[0.06] bg-paper p-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink marker:text-brand-500">
          More options: other tab names, or type the key yourself
        </summary>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Menu tab name">
              <input
                className="input"
                value={config.catalogSheet || ''}
                onChange={(e) => onConfig({ ...config, catalogSheet: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Orders tab name">
              <input
                className="input"
                value={config.ordersSheet || ''}
                onChange={(e) => onConfig({ ...config, ordersSheet: e.target.value })}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label="Service account email">
            <input
              className="input"
              value={config.clientEmail || ''}
              onChange={(e) => onConfig({ ...config, clientEmail: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Service account private key (PEM)"
            hint={
              keySaved
                ? 'Leave empty to keep the saved credential. Saved secrets are never shown here.'
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
                else onSecret(e.target.value);
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
        </div>
      </details>
    </div>
  );
}
