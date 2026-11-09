// Why a Google Sheets connection failed, as a stable code. The server sends it with its message,
// and the dashboard's connect guide (src/lib/sheets-guide.ts) opens the exact fix for it.
export const SHEETS_PROBLEMS = [
  // Google's switch for Sheets is off in the Google project that made the key.
  'SHEETS_API_OFF',
  // Google says the helper account can't open the Sheet, or can only look at it.
  'SHEET_NOT_SHARED',
  'SHEET_VIEW_ONLY',
  // The Sheet itself: gone, really an Excel file, or already used by another business.
  'SHEET_NOT_FOUND',
  'SHEET_IS_EXCEL',
  'SHEET_TAKEN',
  'LINK_MISSING',
  // The tabs inside the Sheet.
  'ORDERS_TAB_MISSING',
  'ORDERS_TAB_HAS_DATA',
  'TAB_LOCKED',
  'MENU_TAB_MISSING',
  'MENU_INVALID',
  // The key file and the helper account it belongs to.
  'KEY_MISSING',
  'KEY_BROKEN',
  'KEY_NOT_READY',
  'KEY_REJECTED',
  'HELPER_OFF',
  'HELPER_GONE',
  // Google itself: busy, not answering, or refusing for a reason Orderly doesn't recognise.
  'GOOGLE_BUSY',
  'GOOGLE_DOWN',
  'GOOGLE_REFUSED',
  // A Sheet connected with Google whose access has ended.
  'GOOGLE_REAUTH',
] as const;
export type SheetsProblem = (typeof SHEETS_PROBLEMS)[number];

/** Google was slow or busy, or a new key isn't ready: nothing to fix, so nothing is recorded. */
const PASSING: readonly string[] = ['KEY_NOT_READY', 'GOOGLE_BUSY', 'GOOGLE_DOWN'];
export const isPassingSheetsProblem = (code?: string) => !!code && PASSING.includes(code);
/** A problem only the owner can fix: shown on the Sheets card with a Fix this button. */
export const isLastingSheetsProblem = (code?: string): code is SheetsProblem =>
  !!code && !PASSING.includes(code) && (SHEETS_PROBLEMS as readonly string[]).includes(code);

/**
 * How a message ends when the guide has its fix: Test on the Sheets card opens the guide there.
 * These words also reach toasts and the menu refresh, where no Fix this button is beside them.
 */
export const SEE_FIX = 'Click Test on the Google Sheets card to see how to fix it.';
/** The card's words when its Fix this button is right below them: that button, not Test. */
export const besideFixThis = (message: string) =>
  message.replace(SEE_FIX, 'Click Fix this to see how to fix it.');
/** The message alone, where the fix is already open or the words go to Orderly. */
export const withoutSeeFix = (message: string) => message.replace(SEE_FIX, '').trim();

/** The Google project a helper account belongs to: name@PROJECT.iam.gserviceaccount.com. */
export const projectOfHelper = (email?: string) =>
  /@([\w-]+)\.iam\.gserviceaccount\.com$/.exec(email?.trim() ?? '')?.[1];
