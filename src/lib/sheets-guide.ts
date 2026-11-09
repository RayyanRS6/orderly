// The Google Sheets connect guide, as data: what the owner is told, one small screen at a time.
// src/components/SheetsGuide.tsx shows one screen and moves between them. The words were tried
// against two non-technical owners on paper; keep Google's own labels exact (they are in **bold**
// because the owner must find them on Google's page) and everything else plain:
// "helper" for service account, "folder" for project, "key file" for JSON key.
import type { SheetsProblem } from '../shared/sheets-problems';

/** What the words and links of a screen are filled in with. */
export interface GuideFacts {
  /** Google project of the helper, from its email; empty until the key file is read. */
  project: string;
  spreadsheetId: string;
  email: string;
  ordersTab: string;
  menuTab: string;
  /** The key held down to copy and paste: Ctrl, or Command on a Mac. */
  ctrl: string;
  /** The address of this page, to open it on another computer. */
  page: string;
}

export type ScreenId =
  | 'intro'
  | 'use-computer'
  | 'check-gmail'
  | 'two-step'
  | 'make-sheet'
  | 'name-tab'
  | 'copy-link'
  | 'open-cloud'
  | 'create-project'
  | 'create-helper'
  | 'open-keys'
  | 'make-key'
  | 'upload-key'
  | 'turn-on-sheets'
  | 'share-open'
  | 'share-send'
  | 'check'
  | 'connected'
  | 'delete-key'
  | 'change'
  | 'fix-api-off'
  | 'fix-not-shared'
  | 'fix-share-role'
  | 'fix-sheet-gone'
  | 'fix-sheet-taken'
  | 'fix-excel'
  | 'fix-link'
  | 'fix-key-file'
  | 'fix-key-wait'
  | 'fix-new-key'
  | 'fix-helper-off'
  | 'fix-helper-gone'
  | 'fix-wrong-account'
  | 'fix-work-account'
  | 'fix-key-blocked'
  | 'fix-tab-name'
  | 'fix-rename-old'
  | 'fix-add-orders-tab'
  | 'fix-tab-locked'
  | 'fix-storage-full'
  | 'fix-menu-tab'
  | 'fix-menu'
  | 'fix-google-busy'
  | 'fix-google-down'
  | 'fix-unknown'
  | 'get-help';

export interface StuckAnswer {
  q: string;
  a: string;
  /** A way out of this answer: another screen of the guide. */
  go?: { label: string; screen: ScreenId };
  /** Or a page to open. */
  open?: { label: string; url: string };
}

export interface GuideScreen {
  title: string;
  /** One or two short sentences: what this is, or on a fix, what happened. Never blames. */
  what?: string;
  /** One small action per line. */
  steps?: string[];
  /** The big button: opens the page the steps talk about, in a new tab. */
  open?: { label: string; url: string };
  /** Orderly's own box on this screen. */
  box?: 'link' | 'key' | 'email' | 'message';
  /** How the owner knows it worked. */
  see?: string;
  stuck?: StuckAnswer[];
  /** Choices shown as buttons, for a screen that only asks where to go. */
  choices?: { label: string; screen: ScreenId }[];
  /** A button under the main one, for the likely way a step goes wrong. */
  also?: { label: string; screen: ScreenId };
  /** Where the main button goes; without it, the next screen of the main path. */
  next?: ScreenId;
  /** The main button's words. */
  nextLabel?: string;
  /** The main button checks the connection instead of moving on. */
  check?: boolean;
  /** Seconds to wait, shown as a countdown, before the check runs by itself. */
  wait?: number;
  /** Back to the main path after this fix, not straight to the check. */
  rejoin?: boolean;
  /** The last screen of a way through: the main button closes the guide. */
  finish?: boolean;
}

const NOT_A_CARD = 'Close it. Do not type a card. This setup needs no card and no free trial.';

export const SCREENS: Record<ScreenId, GuideScreen> = {
  intro: {
    title: 'Before you start',
    what: 'You make a small robot account at Google. We call it your helper. It can open only the Sheet you share with it, and it copies each order there. You only do this once. We go one small step at a time.',
    steps: [
      'Choose a quiet time. It can take up to 45 minutes. You can stop and carry on later: Orderly remembers your step on this computer. No time for that? We can do it with you.',
      'Use a computer if you can.',
      'Keep your phone beside you. Google may send it a code.',
      'Near the end, Google sometimes blocks one step on new accounts. If that happens, it is not your mistake, and we finish it with you.',
    ],
    nextLabel: 'Start',
    stuck: [
      {
        q: 'Do I need to pay?',
        a: 'You need no card and no free trial. If Google offers one, do not click it.',
      },
      {
        q: 'Will this touch my emails or photos?',
        a: 'No. The helper can open only the one Sheet you share with it.',
      },
      {
        q: 'Can someone do this with me?',
        a: 'Yes. Ask Orderly, and we can do it together on a short screen share.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
    ],
  },
  'use-computer': {
    title: 'Open this on a computer',
    what: 'Google’s pages for this part are made for computers and are very hard on a phone. You only do this once.',
    steps: [
      'Click the button below to send this page to yourself on WhatsApp.',
      'Open WhatsApp on your computer and click the link you sent.',
      'Sign in to Orderly there and carry on.',
    ],
    open: { label: 'Send this page to my WhatsApp', url: 'https://wa.me/?text={page}' },
    nextLabel: 'Carry on here anyway',
    next: 'check-gmail',
    stuck: [
      {
        q: 'I only have a phone',
        a: 'Borrow a computer for an hour if you can. If not, ask Orderly and we will help you finish.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
    ],
  },
  'check-gmail': {
    title: 'Check it is your Gmail',
    what: 'Each big button opens Google in a new page. At the very top of your screen is a row of small boxes, one for each page. To come back here, click the box that starts with Orderly. You may close old Google pages with their small X, but never close Orderly.',
    steps: [
      'Click **Open my Google account**.',
      'At the top right of that page, click the circle with a picture or letter.',
      'A small window shows an email. Check it is your own Gmail, the one on your phone.',
      'Someone else’s Gmail, like a family member’s? Click **Add another account** and sign in with yours. From now on, this circle must show your Gmail on every Google page.',
    ],
    open: { label: 'Open my Google account', url: 'https://myaccount.google.com/' },
    see: 'The small window shows your own Gmail address.',
    stuck: [
      {
        q: 'There is no circle',
        a: 'Click **Sign in** or **Go to Google Account**, and sign in with your Gmail. Then you will see the circle.',
      },
      {
        q: 'I do not remember my password',
        a: 'Click **Forgot password?** on Google’s page. Google checks using your phone. It is safe and free.',
      },
      {
        q: 'The email ends in a company or school name',
        a: 'Click **Add another account** and sign in with your personal Gmail. Company and school accounts often block these steps.',
      },
      {
        q: 'Several emails are listed',
        a: 'Click yours. On every Google page, this circle must show this same Gmail.',
      },
      {
        q: 'I do not have a Gmail',
        a: 'Click **Add another account**, then **Create account**. It is free.',
      },
    ],
  },
  'two-step': {
    title: 'Turn on 2-Step Verification',
    what: 'Google asks this of everyone who makes a helper. It is free. The code comes only to your own phone, when you sign in on a new computer. Gmail on your phone keeps working as normal.',
    steps: [
      'Click **Open Google’s page**.',
      'Type your Gmail password if Google asks.',
      'Click **Turn on**.',
      'Type your phone number if Google asks, then the code Google sends to your phone.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://myaccount.google.com/signinoptions/two-step-verification',
    },
    see: 'Google says 2-Step Verification is on.',
    stuck: [
      { q: 'It already says it is on', a: 'Good. There is nothing to do. Click the next step.' },
      {
        q: 'The code did not come',
        a: 'Wait one minute. Check your phone number is right. Then ask Google to send it again.',
      },
      {
        q: 'Google offers another way, like a phone prompt',
        a: 'Any way is fine. Choose the easiest one on your phone.',
      },
      {
        q: 'There is no Turn on button',
        a: 'Look for similar words, like **Get started** or **Add a phone number**, and click that. Your email does not end in @gmail.com? Use your personal Gmail.',
        go: { label: 'Use my personal Gmail', screen: 'fix-work-account' },
      },
    ],
  },
  'make-sheet': {
    title: 'Make your new Sheet',
    steps: [
      'Click **Open a new Sheet**, and wait for the empty Sheet to open.',
      'Look at the circle at the top right. It must show your own Gmail.',
      'At the top left, click the words **Untitled spreadsheet**.',
      'Type **Orderly orders** and press Enter.',
    ],
    open: { label: 'Open a new Sheet', url: 'https://sheets.new' },
    see: 'An empty Sheet named Orderly orders.',
    stuck: [
      { q: 'Google asks me to sign in or choose an account', a: 'Click your Gmail.' },
      {
        q: 'A message about tips or Gemini covers the Sheet',
        a: 'Click the X or **Close** on it. You do not need it.',
      },
      {
        q: 'I already have a Sheet or an Excel file',
        a: 'Please make a new one. Orderly needs an empty Sheet of its own. Your old file stays safe.',
      },
    ],
  },
  'name-tab': {
    title: 'Change the small name to Orders',
    steps: [
      'Go back to your Sheet: click its page at the very top of your screen. It has a green picture.',
      'At the very bottom left of the Sheet, find a small name. It may say **Sheet1**.',
      'Double-click that name.',
      'Type **Orders** and press Enter.',
      'Leave all the boxes in the Sheet empty. Orderly adds the titles.',
    ],
    see: 'The small name at the very bottom says Orders.',
    stuck: [
      {
        q: 'The name is not Sheet1',
        a: 'That is fine. Double-click whatever name is there and type Orders.',
      },
      {
        q: 'The word went into a box in the Sheet',
        a: 'Hold down the {ctrl} key, keep holding it and press Z once. Then double-click the small name at the very bottom.',
      },
      {
        q: 'I closed the Sheet',
        a: 'Open Google Sheets and click Orderly orders.',
        open: { label: 'Open Google Sheets', url: 'https://docs.google.com/spreadsheets/' },
      },
    ],
  },
  'copy-link': {
    title: 'Copy your Sheet’s link here',
    steps: [
      'Go back to your Sheet: click its page with the green picture at the very top. Click once on the long web address at the very top.',
      'Hold down the {ctrl} key. Keep holding it and press C once. Nothing seems to happen. That is normal.',
      'Come back to this page.',
      'Click the box below. Hold down the {ctrl} key and press V once.',
    ],
    box: 'link',
    see: 'A green tick and the words Link looks right.',
    stuck: [
      {
        q: 'The keys do not work',
        a: 'Click the web address with the right button of your mouse, then click **Copy**. In the box below, click the right button again, then **Paste**.',
      },
      {
        q: 'I closed the Sheet',
        a: 'Open Google Sheets and click Orderly orders.',
        open: { label: 'Open Google Sheets', url: 'https://docs.google.com/spreadsheets/' },
      },
    ],
  },
  'open-cloud': {
    title: 'Open Google Cloud',
    what: 'This page looks technical. That is normal. Only do what this step says.',
    steps: [
      'Click **Open Google Cloud**.',
      'If Google asks for your country, choose **Pakistan**.',
      'If you see Terms of Service, tick the box and click **Agree and continue**.',
      'Google may show an offer with the words **Free Trial**, **Start free** or **$300**. It is only an advert, and you pay nothing if you ignore it. Do not click it.',
    ],
    open: { label: 'Open Google Cloud', url: 'https://console.cloud.google.com/' },
    see: 'A busy page with Google Cloud at the top left.',
    stuck: [
      {
        q: 'Google asks me to turn on 2-Step Verification',
        a: 'Do that first, then click the big button again.',
        go: { label: 'Show me how', screen: 'two-step' },
      },
      { q: 'Google says Verify it’s you', a: 'Use your phone or password as Google asks.' },
      {
        q: 'Google asks for a card or bank details',
        a: 'Stop. Do not type them. Close that page and click the big button again. If Google asks again, ask Orderly.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
      {
        q: 'A tour, tips or Gemini message covers the page',
        a: 'Click the X or **Close** on it. You do not need it.',
      },
      {
        q: 'The top of the page says My First Project',
        a: 'That is normal. You make your own folder in the next step.',
      },
    ],
  },
  'create-project': {
    title: 'Make your Orderly folder',
    what: 'Google keeps your things in a folder it calls a project. You now make one called Orderly.',
    steps: [
      'Click **Open Google’s page**.',
      'Click inside the **Project name** box. Google already put a name there.',
      'Hold down the {ctrl} key and press A once. Then type **Orderly**.',
      'Click **Create**. Leave the other boxes as they are.',
    ],
    open: { label: 'Open Google’s page', url: 'https://console.cloud.google.com/projectcreate' },
    see: 'Google shows a small message or a new page. The top may say My First Project or Select a project. Either is fine: the next step picks Orderly.',
    stuck: [
      { q: 'There is a Project ID box', a: 'Leave it. Google fills it in by itself.' },
      {
        q: 'Location or Parent resource shows something',
        a: 'Leave it as it is. Either way is fine.',
      },
      { q: 'It asks about a billing account', a: 'Leave it. This setup needs no card.' },
      {
        q: 'It says I do not have permission',
        a: 'You are probably in a company account.',
        go: { label: 'Use my personal Gmail', screen: 'fix-work-account' },
      },
      {
        q: 'It says I reached a limit',
        a: 'Google limits how many folders you can have. Any folder you already have will work. Click the next step, and pick that folder when Google asks.',
      },
      { q: 'I already made an Orderly folder', a: 'You do not need another. Click the next step.' },
    ],
  },
  'create-helper': {
    title: 'Make your helper',
    what: 'Your helper is a small robot account at Google. Google calls it a service account. It can open only the Sheet you share with it.',
    steps: [
      'Click **Open Google’s page**. If Google shows a list of folders, click **Orderly**.',
      'Click the **Service account name** box and type **orderly** in small letters. A second box fills by itself. Leave it, and leave any other box empty.',
      'Click **Done** at the bottom of Google’s page.',
      'Only see **Create and continue**? Click it, click **Continue**, then click **Done**.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/projectselector/iam-admin/serviceaccounts/create',
    },
    see: 'A list shows a long email like orderly@orderly-123456.iam.gserviceaccount.com.',
    stuck: [
      {
        q: 'Google asks me to choose a role or give access',
        a: 'Skip it. Choose nothing and click **Continue**.',
      },
      {
        q: 'Orderly is not in the list',
        a: 'Google can take a few minutes. Wait two minutes, then press the key marked F5 at the top of your keyboard.',
      },
      {
        q: 'The top of the page says My First Project',
        a: 'Click that name at the top, then click **Orderly**.',
      },
      {
        q: 'Google asks me to enable Identity and Access Management (IAM) API',
        a: 'Click **Enable**. Wait until it finishes, then click the big button again.',
      },
      {
        q: 'Google says I need more access or permission',
        a: 'Google may have opened another of your accounts.',
        go: { label: 'Show me what to do', screen: 'fix-wrong-account' },
      },
      { q: 'Google says this name already exists', a: 'You already made it. Click the next step.' },
    ],
  },
  'open-keys': {
    title: 'Open your helper’s Keys page',
    steps: [
      'Click **Open Google’s page**.',
      'Check the name at the top says **Orderly**. If not, click it, then click **Orderly**.',
      'Click the long email that starts with **orderly@**.',
      'Click the word **Keys** near the top.',
      'Leave this Google page open. The next step uses it.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    },
    see: 'A Google page with an **Add key** button.',
    stuck: [
      {
        q: 'I see other emails too',
        a: 'Ignore them. Those are Google’s own. Click the one that starts with orderly@.',
      },
      {
        q: 'No email starts with orderly@',
        a: 'Make the helper again.',
        go: { label: 'Make my helper', screen: 'create-helper' },
      },
      {
        q: 'I cannot see Keys',
        a: 'Make the window wider. **Keys** sits beside **Details** and **Permissions** after you click the email.',
      },
    ],
  },
  'make-key': {
    title: 'Download your key file',
    what: 'This file works like a password for your helper. In the next step you give it to Orderly: that is the only place it goes. Google will also show a warning about key files. It shows this to everyone, and the file is only a risk if someone else gets it. Carry on.',
    steps: [
      'Go back to the Google page that shows **Add key**. Click the pages along the top one by one until you see it.',
      'Click **Add key**, then **Create new key**.',
      'Leave **JSON** chosen and click **Create**. A file downloads to your computer.',
      'Click **Close**.',
    ],
    see: 'A new file in your downloads. Its long name usually starts with orderly.',
    also: { label: 'Google says key creation is disabled', screen: 'fix-key-blocked' },
    stuck: [
      {
        q: 'I closed the Keys page, or I see no Add key',
        a: 'Open it again. Click the long email that starts with orderly@, then the word **Keys**.',
        go: { label: 'Open the Keys page', screen: 'open-keys' },
      },
      { q: 'My computer asks where to save the file', a: 'Choose **Downloads**, then **Save**.' },
      { q: 'My computer asks whether to keep the file', a: 'Click **Keep**.' },
      {
        q: 'Google warns that key files can be risky',
        a: 'Google shows that to everyone. The file is only a risk if someone else gets it. Keep it private and carry on.',
      },
      {
        q: 'Google says I have too many keys',
        a: 'Google allows 10 keys for one helper. Beside the oldest key, click the bin picture, then **Delete**. Then make a new one.',
      },
    ],
  },
  'upload-key': {
    title: 'Put your key file here',
    what: 'This is the one safe place for it. Orderly keeps it locked and uses it only to add orders to your Sheet. Your Gmail password is not in it.',
    steps: [
      'Click **Choose the key file** below.',
      'In the window that opens, click **Downloads** on the left.',
      'Click the newest file. Its long name usually starts with orderly.',
      'Click **Open**.',
    ],
    box: 'key',
    see: 'A green tick and the words Key file read.',
    stuck: [
      {
        q: 'I do not see .json at the end of the name',
        a: 'That is fine. Your computer may hide it. Pick the newest file.',
      },
      {
        q: 'I cannot find the file',
        a: 'Make it again. It only takes a minute.',
        go: { label: 'Make a new key file', screen: 'open-keys' },
      },
      {
        q: 'Someone asks me to send this file',
        a: 'Do not send it on WhatsApp or by email, even to Orderly. Upload it only here.',
      },
    ],
  },
  'turn-on-sheets': {
    title: 'Let your helper use Sheets',
    what: 'Your Sheet already works for you. This switch is what lets your helper in too. Google names it Google Sheets API. You do not need to understand that name.',
    steps: [
      'Click **Open Google’s page**.',
      'Check the page says **Google Sheets API**.',
      'Click **Enable**, and wait until the button goes away.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com?project={project}',
    },
    see: 'The Enable button is gone. You may see **Manage** or **Disable API** instead.',
    stuck: [
      {
        q: 'I see Manage and no Enable button',
        a: 'It is already on. Click the next step.',
      },
      { q: 'I see Disable API', a: 'It is on. Do not click that. Click the next step.' },
      {
        q: 'The name at the top is not Orderly',
        a: 'Leave it this time. This button opens the folder your key file came from, so it is right.',
      },
      { q: 'Google says Create credentials', a: 'Ignore it. You already have your key file.' },
      { q: 'Google asks for a card or a free trial', a: NOT_A_CARD },
      {
        q: 'Google says I need more access, or it cannot find the folder',
        a: 'Google may have opened another of your accounts.',
        go: { label: 'Show me what to do', screen: 'fix-wrong-account' },
      },
    ],
  },
  'share-open': {
    title: 'Share your Sheet with your helper',
    what: 'The long email below is your helper. It is not a person, and nobody reads it. Only this helper gets your Sheet.',
    steps: [
      'Click **Copy** beside the long email below.',
      'Click **Open your Sheet**.',
      'At the top right of the Sheet, click **Share**.',
      'Click the box at the top of the window that opens.',
      'Hold down the {ctrl} key and press V once. Then press Enter.',
    ],
    box: 'email',
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    see: 'The long email shows in the Share window.',
    stuck: [
      {
        q: 'The Sheet says You need access',
        a: 'Google opened another of your accounts.',
        go: { label: 'Show me what to do', screen: 'fix-wrong-account' },
      },
      {
        q: 'A message warns that I am sharing outside my organization',
        a: 'Confirm it. Google shows this for every helper on company accounts.',
      },
      {
        q: 'Google says I cannot share outside my organization',
        a: 'Your company blocks this.',
        go: { label: 'Use my personal Gmail', screen: 'fix-work-account' },
      },
    ],
  },
  'share-send': {
    title: 'Choose Editor, then send',
    steps: [
      'Go back to your Sheet. You may have two pages with a green picture: click each until you see the Share window. Not there? Click **Share** and paste the long email again.',
      'Look at the word beside the email. It must say **Editor**. If not, click it and click **Editor**.',
      'Untick **Notify people**.',
      'Click **Send**. It may say **Share**.',
    ],
    see: 'The Share window closes.',
    nextLabel: 'I did it, check my connection',
    check: true,
    stuck: [
      { q: 'There is no Notify people box', a: 'That is fine. Click **Send** or **Share**.' },
      {
        q: 'I see General access',
        a: 'Leave it on **Restricted**. Your Sheet will hold customers’ names, phones and addresses.',
      },
      { q: 'I see Add expiration', a: 'Do not set it. Orderly would lose access on that date.' },
      {
        q: 'Later I got an email saying Address not found',
        a: 'Ignore it. Your helper has no mailbox. Your Sheet is still shared.',
      },
    ],
  },
  check: {
    title: 'Check your connection',
    what: 'Orderly opens your Sheet and adds its column titles, to prove everything works. It usually takes a few seconds.',
    check: true,
    nextLabel: 'Check my connection',
  },
  connected: {
    title: 'Your Sheet is connected',
    what: 'Each new WhatsApp order now adds a row to your Sheet. You do not need to do anything else here.',
    steps: [
      'Click **Open your Sheet** to see it.',
      'At the very bottom of the Sheet, click the name **Orders**. Orderly added titles to the top row.',
      'Please do not change those titles or the name Orders.',
    ],
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    finish: true,
    nextLabel: 'Finish',
    also: { label: 'Change my Sheet or key file', screen: 'change' },
    stuck: [
      {
        q: 'The top row is empty',
        a: 'Press the key marked F5 at the top of your keyboard. Still empty? Click the name Orders at the very bottom.',
      },
      { q: 'Can I rename the Sheet?', a: 'Yes. Only the name Orders and its top row must stay.' },
      {
        q: 'My test chats are not in the Sheet',
        a: 'That is normal. Only real WhatsApp orders are copied.',
      },
      {
        q: 'I want to edit my menu in the Sheet too',
        a: 'Add a small name **{menuTab}** at the bottom of your Sheet. Then, with it open, click **File**, **Import**, **Upload**, pick our menu template, choose **Replace current sheet** and import it. Put your dishes in place of the samples. Then choose **Connected Google Sheet** under Settings, Menu source.',
        open: { label: 'Download menu template', url: '/examples/menu.csv' },
      },
    ],
  },
  'delete-key': {
    title: 'Delete your copy of the key file',
    what: 'Anyone with this file can open your Sheet. You will not need it again, because Orderly keeps its own locked copy. Your connection keeps working.',
    steps: [
      'Open the Downloads folder on your computer.',
      'Find the file whose long name starts with orderly.',
      'Delete it.',
    ],
    finish: true,
    nextLabel: 'Finish',
    stuck: [
      {
        q: 'I want to do this later',
        a: 'That is fine. Your connection works either way. Click Finish, and please do it soon.',
      },
      {
        q: 'This is a shared computer',
        a: 'Also open the Recycle Bin on the desktop and delete it there.',
      },
    ],
  },
  change: {
    title: 'Change your Sheet or key file',
    what: 'Your orders stay safe in Orderly while you change this.',
    choices: [
      { label: 'Use a different Sheet', screen: 'fix-link' },
      { label: 'Upload a new key file', screen: 'fix-key-file' },
    ],
  },

  // Fixes: what happened, then only what to do about it.
  'fix-api-off': {
    title: 'Turn on one Google switch',
    what: 'Your Sheet is fine. Google says the switch for your helper is off. If you already turned it on, Google may just be slow to notice, and nothing is wrong. Please look once more.',
    steps: [
      'Click **Open Google’s page**. It opens your Orderly folder, which Google shows as {project}.',
      'Check the page says **Google Sheets API**.',
      'See **Enable**? Click it, and wait until it goes away.',
      'See **Manage** or **Disable API** instead? It is already on. Do not click **Disable API**.',
      'Come back to this page, wait two minutes, then click **Check again**.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com?project={project}',
    },
    check: true,
    stuck: [
      {
        q: 'I see Manage and no Enable button',
        a: 'It is already on. Google can take a few minutes. Wait five minutes, then click **Check again**.',
      },
      {
        q: 'The name at the top is not Orderly',
        a: 'Leave it. This button opens the folder your key file came from, so it is right.',
      },
      {
        q: 'Google says I need more access, or it cannot find the folder',
        a: 'Click the circle at the top right, click the Gmail that made the key file, then click the big button again.',
      },
      { q: 'Google asks for a card or a free trial', a: NOT_A_CARD },
    ],
  },
  'fix-not-shared': {
    title: 'Your helper cannot open your Sheet yet',
    what: 'Google says your helper cannot open this Sheet yet. Your helper is the long email below. Let us check the sharing together. It is a small fix.',
    steps: [
      'Click **Copy** beside the long email below, then **Open your Sheet**, then **Share** at the top right.',
      'Is the long email in the list and says **Editor**? Click **Done**, then read Still stuck below.',
      'In the list with another word? Click the word, choose **Editor**, then click **Save**.',
      'Not in the list? Click the box at the top, hold down the {ctrl} key and press V once, then press Enter. Choose **Editor**, untick **Notify people**, and click **Send** or **Share**.',
      'Come back to this page and click **Check again**.',
    ],
    box: 'email',
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
    stuck: [
      {
        q: 'It is shared and already says Editor',
        a: 'First look at the circle at the top right of your Sheet. Is it your own Gmail? If not, click it and choose your Gmail. If it is, Orderly may have the link of another Sheet, so paste the link again.',
        go: { label: 'Paste the link again', screen: 'fix-link' },
      },
      {
        q: 'The Sheet says You need access',
        a: 'Google opened another of your accounts.',
        go: { label: 'Show me what to do', screen: 'fix-wrong-account' },
      },
      {
        q: 'Google will not let me share',
        a: 'Company and school accounts can block this.',
        go: { label: 'Show me what to do', screen: 'fix-work-account' },
      },
    ],
  },
  'fix-share-role': {
    title: 'Change the word to Editor',
    what: 'Your helper can open the Sheet, but it cannot add orders yet. The word beside it must say Editor.',
    steps: [
      'Click **Open your Sheet**, then **Share** at the top right.',
      'Find the long email below in the list.',
      'Click the word beside it, then click **Editor**.',
      'Click **Save** if Google shows it.',
    ],
    box: 'email',
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
    stuck: [
      {
        q: 'It already says Editor',
        a: 'Your Google storage may be full, which stops all changes to Sheets.',
        go: { label: 'See what to do', screen: 'fix-storage-full' },
      },
    ],
  },
  'fix-sheet-gone': {
    title: 'Google cannot find your Sheet',
    what: 'It may have been deleted or moved to Trash, or the link may be wrong. Every order is still saved in Orderly.',
    steps: [
      'Click **Look in Trash**, and look for your Sheet.',
      'Found it? Click it with the right button of your mouse, then click **Restore**.',
    ],
    open: { label: 'Look in Trash', url: 'https://drive.google.com/drive/trash' },
    check: true,
    stuck: [
      {
        q: 'It is not in Trash',
        a: 'Make a new Sheet. It takes a few minutes, and your old orders stay in Orderly.',
        go: { label: 'Make a new Sheet', screen: 'make-sheet' },
      },
      {
        q: 'I did not delete it',
        a: 'The link may be wrong. Copy it again.',
        go: { label: 'Paste the link again', screen: 'fix-link' },
      },
    ],
  },
  'fix-sheet-taken': {
    title: 'This Sheet is already linked',
    what: 'This Sheet is already linked to another business in Orderly. Each business needs its own Sheet, so orders do not mix. Make a new one here.',
    nextLabel: 'Make a new Sheet',
    next: 'make-sheet',
    rejoin: true,
    stuck: [
      {
        q: 'I only have one business, or this surprises me',
        a: 'Ask Orderly and we will check it for you.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
      {
        q: 'Both businesses are mine',
        a: 'They still need one Sheet each. You can use the same key file for both.',
      },
    ],
  },
  'fix-excel': {
    title: 'This is an Excel file',
    what: 'Your file looks like a Sheet, but it is really an Excel file. Orderly can only write to real Google Sheets. Your Excel file will not change.',
    steps: [
      'Click **Open your file**.',
      'At the top left, click **File**, then **Save as Google Sheets**.',
      'Wait for the new copy to open.',
      'Stay on the new copy, and come back here.',
    ],
    open: {
      label: 'Open your file',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    next: 'fix-link',
  },
  'fix-link': {
    title: 'Copy your Sheet’s link again',
    what: 'Orderly needs the link of the Sheet itself.',
    steps: [
      'Click **Open Google Sheets**, then click your Sheet.',
      'Click once on the long web address at the very top.',
      'Hold down the {ctrl} key and press C once.',
      'Come back to this page, click the box below, hold down the {ctrl} key and press V once.',
    ],
    open: { label: 'Open Google Sheets', url: 'https://docs.google.com/spreadsheets/' },
    box: 'link',
    check: true,
    stuck: [
      {
        q: 'My Sheet is not in the list',
        a: 'Make a new one.',
        go: { label: 'Make a new Sheet', screen: 'make-sheet' },
      },
    ],
  },
  'fix-key-file': {
    title: 'Choose the key file again',
    what: 'Orderly needs the key file Google downloaded for your helper.',
    steps: [
      'Click **Choose the key file** below.',
      'Click **Downloads** on the left, then the newest file. Its long name usually starts with orderly.',
      'Click **Open**.',
    ],
    box: 'key',
    check: true,
    stuck: [
      {
        q: 'I cannot find the file, or I lost it',
        a: 'Make a new one. It only takes a minute.',
        go: { label: 'Make a new key file', screen: 'fix-new-key' },
      },
    ],
  },
  'fix-key-wait': {
    title: 'Google needs one more minute',
    what: 'Google takes about a minute to accept a new key file. Nothing is wrong. Orderly checks again by itself.',
    wait: 60,
    check: true,
  },
  'fix-new-key': {
    title: 'Make a new key file',
    what: 'Google no longer accepts the saved key file. It may have been deleted. A new one fixes this, and you do not need to share your Sheet again. Your orders are safe in Orderly meanwhile.',
    steps: [
      'Click **Open Google’s page**.',
      'Click the long email {email}.',
      'Click the word **Keys** near the top.',
      'Leave this Google page open. The next step uses it.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/iam-admin/serviceaccounts?project={project}',
    },
    next: 'make-key',
    stuck: [
      {
        q: 'The email is not in the list',
        a: 'Your helper may have been deleted.',
        go: { label: 'Show me what to do', screen: 'fix-helper-gone' },
      },
      {
        q: 'Google emailed me that my key was found online',
        a: 'Google blocks keys it finds in public. Make this new one, and never post it anywhere.',
      },
    ],
  },
  'fix-helper-off': {
    title: 'Your helper is switched off',
    what: 'Google shows this key or its helper as switched off. Your orders are safe in Orderly meanwhile.',
    steps: [
      'Click **Open Google’s page**, and find {email} in the list.',
      'Does it say **Disabled**? Click the three dots at the end of its line.',
      'Click **Enable**.',
      'Come back to this page, wait one minute, then click **Check again**.',
    ],
    open: {
      label: 'Open Google’s page',
      url: 'https://console.cloud.google.com/iam-admin/serviceaccounts?project={project}',
    },
    check: true,
    stuck: [
      {
        q: 'It does not say Disabled, or it still fails',
        a: 'Make a new key file.',
        go: { label: 'Make a new key file', screen: 'fix-new-key' },
      },
    ],
  },
  'fix-helper-gone': {
    title: 'Your helper no longer exists',
    what: 'Google cannot find the helper this key belongs to. It may have been deleted. A new helper has a new email, so you share your Sheet with it again. Your Sheet stays as it is.',
    nextLabel: 'Make a new helper',
    next: 'create-helper',
    rejoin: true,
    stuck: [
      {
        q: 'Google says the Orderly folder is gone',
        a: 'Make a new folder first.',
        go: { label: 'Make a new folder', screen: 'create-project' },
      },
    ],
  },
  'fix-wrong-account': {
    title: 'Google opened your other account',
    what: 'This computer is signed in to more than one Google account, and Google opened the wrong one. Nothing is broken.',
    steps: [
      'At the top right of the Google page, click the circle.',
      'Click your own Gmail in the list.',
      'Not listed? Click **Add another account** and sign in.',
      'Come back to this page and click the back button below, then the big button again.',
    ],
    nextLabel: 'Go back',
  },
  'fix-work-account': {
    title: 'Use your personal Gmail',
    what: 'Company and school accounts can block these steps. Google treats your helper as outside the company, even though you made it. A personal Gmail has no company rules.',
    steps: [
      'Click **Open my Google account**.',
      'At the top right, click the circle, then **Add another account**.',
      'Sign in with your personal Gmail. No Gmail? Click **Create account**. It is free.',
    ],
    open: { label: 'Open my Google account', url: 'https://myaccount.google.com/' },
    nextLabel: 'I did it, start again',
    next: 'two-step',
    rejoin: true,
    stuck: [
      {
        q: 'I am already in my personal Gmail',
        a: 'Then something else stopped you. Ask Orderly.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
      {
        q: 'My orders must stay in the company account',
        a: 'Ask your company’s IT person to allow sharing with your helper’s long email: {email}.',
      },
    ],
  },
  'fix-key-blocked': {
    title: 'Google blocked the key file',
    what: 'Google turns this block on for many new accounts, even personal Gmail. It is not your mistake, and your account is fine. If Google’s message says organization, ignore that word: you are in the right account. One Google setting must be changed, and we do it together: on a short video call you show us your screen and we tell you where to click. You do all the clicking. It costs nothing, and we will never ask for your Gmail password or the code Google sends to your phone.',
    steps: [
      'With your phone, take a photo of Google’s message.',
      'Then close Google’s message.',
      'Click **Ask Orderly for help** below.',
    ],
    nextLabel: 'Ask Orderly for help',
    next: 'get-help',
  },
  'fix-tab-name': {
    title: 'Fix the name Orders',
    what: 'Orderly writes to a small name at the bottom of your Sheet called {ordersTab}, and it cannot find it.',
    steps: [
      'Click **Open your Sheet**, and look at the small names at the very bottom.',
      'None for orders? Click the **+** picture at the bottom left first.',
      'Double-click the small name.',
      'Type **{ordersTab}** with no space before or after, and press Enter.',
    ],
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
  },
  'fix-rename-old': {
    title: 'Move your old data aside',
    what: 'The part of your Sheet called {ordersTab} already has other things in it. Orderly never writes over your work, so this needs an empty one.',
    steps: [
      'Click **Open your Sheet**.',
      'At the very bottom, double-click the small name **{ordersTab}**.',
      'Type **Old** and press Enter. Your data stays there.',
    ],
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    next: 'fix-add-orders-tab',
    stuck: [{ q: 'Google says the name Old already exists', a: 'Type **Old 2** instead.' }],
  },
  'fix-add-orders-tab': {
    title: 'Add a new empty Orders',
    steps: [
      'Go back to your Sheet.',
      'At the very bottom left, click the **+** picture.',
      'Double-click the new small name.',
      'Type **{ordersTab}** and press Enter.',
    ],
    see: 'You have Old with your data and a new empty {ordersTab}.',
    check: true,
  },
  'fix-tab-locked': {
    title: 'Unlock Orders in your Sheet',
    what: 'This part of your Sheet is locked, so your helper cannot add rows.',
    steps: [
      'Click **Open your Sheet**.',
      'At the top, click **Data**, then **Protect sheets and ranges**.',
      'On the right, click the line for {ordersTab}.',
      'Click the bin picture, then **Remove**.',
    ],
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
    stuck: [{ q: 'Someone else owns the Sheet', a: 'Ask them to remove the lock.' }],
  },
  'fix-storage-full': {
    title: 'Your Google storage may be full',
    what: 'When Google storage is full, Google stops all changes to your Sheets. Your orders are safe in Orderly meanwhile.',
    steps: [
      'Click **See your Google storage**, and check whether it says full.',
      'Delete large files, old emails or photos you do not need.',
    ],
    open: { label: 'See your Google storage', url: 'https://drive.google.com/settings/storage' },
    check: true,
    stuck: [
      {
        q: 'Google offers to sell me more storage',
        a: 'You do not have to buy it. Deleting things you do not need also works.',
      },
      {
        q: 'It is not full',
        a: 'Then we need to look at this ourselves.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
    ],
  },
  'fix-menu-tab': {
    title: 'Your Sheet has no Menu',
    what: 'Orderly reads your menu from a small name in your Sheet called {menuTab}, and it cannot find it.',
    steps: [
      'Click **Open your Sheet**, and look at the small names at the very bottom.',
      'See your menu under another name? Double-click it, type **{menuTab}** and press Enter.',
    ],
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
    stuck: [
      {
        q: 'There is no menu in my Sheet',
        a: 'Click the **+** picture at the bottom, name the new small name **{menuTab}**, then type name, category, price, available in the top row and one dish below. Under available, type yes.',
      },
      {
        q: 'I do not want my menu in the Sheet',
        a: 'In Settings, under Menu source, choose **Manage here · forms or CSV**, and save. Your Sheet still gets your orders.',
      },
    ],
  },
  'fix-menu': {
    title: 'Fix one thing in your menu',
    what: 'The whole menu waits until this is fixed. Orderly tells you exactly where:',
    steps: [
      'Click **Open your Sheet**.',
      'At the very bottom, click the small name **{menuTab}**.',
      'Fix what Orderly says here. The row numbers are on the far left.',
    ],
    box: 'message',
    open: {
      label: 'Open your Sheet',
      url: 'https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit',
    },
    check: true,
    stuck: [
      {
        q: 'I want to add sizes or extras back',
        a: 'That box is hard to type by hand. Ask Orderly, and send us the row. We write it for you.',
        go: { label: 'Ask Orderly for help', screen: 'get-help' },
      },
    ],
  },
  'fix-google-busy': {
    title: 'Google is busy right now',
    what: 'Too many requests reached Google at once. You did nothing wrong, and nothing is broken. Orderly checks again by itself.',
    wait: 60,
    check: true,
  },
  'fix-google-down': {
    title: 'Google did not answer',
    what: 'Google had a problem or took too long. Your setup is probably fine, and your orders are safe in Orderly. Please do not change anything in Google. Orderly checks again by itself.',
    wait: 30,
    check: true,
    stuck: [
      {
        q: 'Other websites do not open either',
        a: 'Fix your internet first, then click **Check again**. Your steps are saved.',
      },
    ],
  },
  'fix-unknown': {
    title: 'Something else went wrong',
    what: 'This one needs us to look at it. Your orders are safe in Orderly. Please do not change anything in Google.',
    box: 'message',
    check: true,
    also: { label: 'Ask Orderly for help', screen: 'get-help' },
  },
  'get-help': {
    title: 'Ask Orderly for help',
    what: 'A person at Orderly will reply, tell you what to do, and agree a time with you if we need to do it together. It costs nothing. Once you have written to us you can close these pages: your steps are saved.',
    steps: [
      'With your phone, take a photo of the Google page. Cannot manage a photo? That is fine: just say which step you reached.',
      'Easiest: on your phone, write to Orderly at the address below and add the photo.',
      'Or click **Email Orderly** below on this computer. If a window asks you to set up email, or nothing happens, close it and write from your Gmail instead.',
      'Never send your key file, even to Orderly. A photo of the page is enough.',
    ],
    nextLabel: 'Go back',
  },
};

/** The way through, in order. Only these screens count as "Step 3 of 14". */
export const MAIN_PATH: ScreenId[] = [
  'check-gmail',
  'two-step',
  'make-sheet',
  'name-tab',
  'copy-link',
  'open-cloud',
  'create-project',
  'create-helper',
  'open-keys',
  'make-key',
  'upload-key',
  'turn-on-sheets',
  'share-open',
  'share-send',
];

/** The screen that fixes a problem the server named. */
export const FIX_FOR: Record<SheetsProblem, ScreenId> = {
  SHEETS_API_OFF: 'fix-api-off',
  SHEET_NOT_SHARED: 'fix-not-shared',
  SHEET_VIEW_ONLY: 'fix-share-role',
  SHEET_NOT_FOUND: 'fix-sheet-gone',
  SHEET_IS_EXCEL: 'fix-excel',
  SHEET_TAKEN: 'fix-sheet-taken',
  LINK_MISSING: 'fix-link',
  ORDERS_TAB_MISSING: 'fix-tab-name',
  ORDERS_TAB_HAS_DATA: 'fix-rename-old',
  TAB_LOCKED: 'fix-tab-locked',
  MENU_TAB_MISSING: 'fix-menu-tab',
  MENU_INVALID: 'fix-menu',
  KEY_MISSING: 'fix-key-file',
  KEY_BROKEN: 'fix-key-file',
  KEY_NOT_READY: 'fix-key-wait',
  KEY_REJECTED: 'fix-new-key',
  HELPER_OFF: 'fix-helper-off',
  HELPER_GONE: 'fix-helper-gone',
  GOOGLE_BUSY: 'fix-google-busy',
  GOOGLE_DOWN: 'fix-google-down',
  GOOGLE_REFUSED: 'fix-unknown',
  // A Sheet connected with Google reconnects with its own button, above the guide.
  GOOGLE_REAUTH: 'fix-unknown',
};
/** Any failure opens a screen: one the server didn't name goes to the one that asks for help. */
export const fixFor = (code?: string): ScreenId =>
  code && code in FIX_FOR ? FIX_FOR[code as SheetsProblem] : 'fix-unknown';

/** Fills a screen's words or link with what is known; a link without its fact loses that part. */
export function fillIn(text: string, facts: GuideFacts) {
  return text
    .replace('?project={project}', facts.project ? `?project=${facts.project}` : '')
    .replace('{page}', encodeURIComponent(facts.page))
    .replace(/\{project\}/g, facts.project || 'Orderly')
    .replace(/\{spreadsheetId\}/g, facts.spreadsheetId)
    .replace(/\{email\}/g, facts.email || 'your helper’s long email')
    .replace(/\{ordersTab\}/g, facts.ordersTab)
    .replace(/\{menuTab\}/g, facts.menuTab)
    .replace(/\{ctrl\}/g, facts.ctrl);
}

/**
 * The next screen after the owner's "I did it". On the way through, the Google Cloud steps are
 * skipped once a key is saved (a new Sheet needs only sharing), and a fix goes back to the check
 * rather than on through the rest of the path.
 */
export function nextScreen(
  from: ScreenId,
  { keySaved, fixing }: { keySaved: boolean; fixing: boolean },
): ScreenId {
  const screen = SCREENS[from];
  if (screen.next) return screen.next;
  if (from === 'intro') return 'check-gmail';
  if (fixing && from === 'upload-key') return 'check';
  if (from === 'copy-link' && keySaved) return 'share-open';
  const at = MAIN_PATH.indexOf(from);
  return at >= 0 && at < MAIN_PATH.length - 1 ? MAIN_PATH[at + 1]! : 'check';
}

/** Where the guide opens: a named problem first, then the saved step, or the start. */
export function startScreen(options: {
  problem?: string;
  errorCode?: string;
  status?: string;
  keyConnection: boolean;
  saved?: string;
}): ScreenId {
  const { problem, errorCode, status, keyConnection, saved } = options;
  if (problem) return fixFor(problem);
  if (keyConnection && errorCode) return fixFor(errorCode);
  if (keyConnection && status === 'connected') return 'connected';
  if (saved && resumable(saved)) return saved;
  return keyConnection ? 'check' : 'intro';
}

/**
 * The screens worth coming back to: the steps and the check. A help or fix screen isn't kept, so
 * the guide reopens at the last real step rather than on a screen with no way on.
 */
export const resumable = (screen: string): screen is ScreenId =>
  screen === 'check' || (MAIN_PATH as readonly string[]).includes(screen);

// The step the owner reached, kept in this browser so they can stop and carry on later. The link
// too, which isn't secret; never the key file, which goes straight to the server encrypted.
const progressKey = (companyId: string) => `orderly:sheets-guide:${companyId}`;
export interface GuideProgress {
  screen: string;
  link?: string;
  /** A key file was uploaded on the way, so "Delete your copy" still comes after a restart. */
  keyUploaded?: boolean;
}
export function loadProgress(companyId: string): GuideProgress | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(progressKey(companyId)) ?? 'null');
    return stored && typeof stored.screen === 'string' ? stored : undefined;
  } catch {
    return undefined;
  }
}
export function saveProgress(companyId: string, progress: GuideProgress) {
  try {
    localStorage.setItem(progressKey(companyId), JSON.stringify(progress));
  } catch {
    // Private windows and full storage: the guide still works, it just won't remember.
  }
}
export function clearProgress(companyId: string) {
  try {
    localStorage.removeItem(progressKey(companyId));
  } catch {
    // As above.
  }
}

/** The email the Get help button starts: which step and problem, and never the key file. */
export function helpEmail(options: {
  to: string;
  business: string;
  screenTitle: string;
  problem?: string;
  /** What Orderly last said, which carries the log reference of an unexpected failure. */
  message?: string;
}) {
  const body = [
    'Hello Orderly, I need help connecting my Google Sheet.',
    '',
    `Business: ${options.business}`,
    `Step: ${options.screenTitle}`,
    ...(options.problem && options.problem !== 'UNKNOWN'
      ? [`Problem code: ${options.problem}`]
      : []),
    ...(options.message ? [`Orderly said: ${options.message}`] : []),
    '',
    'I have added a photo of the Google page.',
  ].join('\n');
  return `mailto:${options.to}?subject=${encodeURIComponent('Help connecting my Google Sheet')}&body=${encodeURIComponent(body)}`;
}
