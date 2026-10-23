// "Connect with Google" for the order Sheet, in the browser: Google's sign-in library is loaded
// only when the Sheets dialog shows the button, and its popup returns a one-time code that the
// server turns into lasting access (server/integrations/google-sheets-connect.ts).

/** The one permission asked for: files Orderly creates in the owner's Drive, nothing else. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleSheetsConfig {
  enabled: boolean;
  clientId: string;
}
interface CodeResponse {
  code?: string;
  state?: string;
  error?: string;
}
interface CodeClient {
  requestCode(): void;
}
interface GoogleOAuth2 {
  initCodeClient(config: {
    client_id: string;
    scope: string;
    ux_mode: 'popup';
    select_account: boolean;
    state: string;
    callback: (response: CodeResponse) => void;
    error_callback: (error: { type?: string }) => void;
  }): CodeClient;
}
const oauth2 = () =>
  (window as unknown as { google?: { accounts?: { oauth2?: GoogleOAuth2 } } }).google?.accounts
    ?.oauth2;

let gisPromise: Promise<void> | undefined;
/** Loads Google's sign-in library once; a failed load can be tried again. */
export function loadGis() {
  if (oauth2()) return Promise.resolve();
  return (gisPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = undefined;
      script.remove();
      reject(new Error('Google couldn’t load. Check your connection or browser settings.'));
    };
    document.head.append(script);
  }));
}

/** Why Google's popup ended without a code, in the owner's words. */
export function popupErrorText(type?: string) {
  if (type === 'popup_failed_to_open')
    return 'Your browser blocked Google’s window. Allow pop-ups for this site, then click Connect with Google again.';
  if (type === 'popup_closed')
    return 'Google’s window was closed before you clicked Allow. Nothing was changed.';
  return 'Google’s window didn’t finish. Nothing was changed. Try again.';
}
/** Why Google answered without a code (the owner clicked Cancel, for one). */
export function codeErrorText(error: string) {
  return error === 'access_denied'
    ? 'You didn’t allow Orderly. Nothing was changed.'
    : 'Google stopped the sign-in. Nothing was changed. Try again.';
}

const randomState = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/**
 * Opens Google's popup and reports the code, or why there is none. Call it straight from the
 * click: browsers block a popup opened after waiting for anything.
 */
export function requestGoogleCode(
  clientId: string,
  handlers: { onCode: (code: string) => void; onError: (message: string) => void },
) {
  const google = oauth2();
  if (!google) {
    handlers.onError('Google couldn’t load. Check your connection, then try again.');
    return;
  }
  // Only the answer to this click counts.
  const state = randomState();
  google
    .initCodeClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      ux_mode: 'popup',
      select_account: true,
      state,
      callback: (response) => {
        if (response.error) handlers.onError(codeErrorText(response.error));
        else if (response.state !== state || !response.code)
          handlers.onError('Google’s answer didn’t match this page. Try again.');
        else handlers.onCode(response.code);
      },
      error_callback: (error) => handlers.onError(popupErrorText(error?.type)),
    })
    .requestCode();
}

/**
 * The app whose built-in browser shows this page, where Google refuses to sign in
 * (disallowed_useragent); undefined in a normal browser such as Chrome or Safari.
 */
export function inAppBrowser(userAgent: string): string | undefined {
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/.test(userAgent))
    return /Messenger/i.test(userAgent) ? 'Messenger' : 'Facebook';
  if (/Instagram/i.test(userAgent)) return 'Instagram';
  if (/WhatsApp/i.test(userAgent)) return 'WhatsApp';
  if (/\bLine\//.test(userAgent)) return 'LINE';
  if (/Snapchat/i.test(userAgent)) return 'Snapchat';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(userAgent)) return 'TikTok';
  if (/LinkedInApp/i.test(userAgent)) return 'LinkedIn';
  // Android's WebView marks itself "; wv)"; an iPhone app's WebView leaves out "Safari/".
  if (/Android.*; wv\)/.test(userAgent)) return 'another app';
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent) && !/Safari\//.test(userAgent)) return 'another app';
  return undefined;
}
