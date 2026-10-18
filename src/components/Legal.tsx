import { Fragment } from 'react';
import { MessageCircle } from 'lucide-react';
import { supportEmail } from './Public';

type LegalKind = 'privacy' | 'terms' | 'data-deletion';

// Bump this whenever the text of any of the three documents changes.
export const LEGAL_LAST_UPDATED = '18 October 2026';
// Facts only the owner can supply stay visibly marked until they are filled in, before the
// dashboard deploy (docs/DEPLOYMENT.md §7). The backup period is the number of days the nightly
// task in docs/BACKUP-AND-RESTORE.md §4 keeps encrypted copies; change both together.
const OPERATOR = '[OWNER TO CONFIRM: legal name and address of the business that runs Orderly]';
const BACKUP_DAYS = '[OWNER TO CONFIRM: number of]';

const documents: Record<LegalKind, { title: string; intro: string; sections: [string, string][] }> =
  {
    privacy: {
      title: 'Privacy Policy',
      intro: `Orderly is an ordering service that restaurants use to take orders on WhatsApp and on their menu page. Each restaurant is the controller of its customers’ information: it decides why and how that information is used. Orderly processes it on the restaurant’s behalf, only to run the service. Orderly is responsible for its own records about dashboard accounts, support and security. Orderly is run by ${OPERATOR}. Contact: ${supportEmail}.`,
      sections: [
        [
          'What we collect',
          'From customers: your name, your WhatsApp number or WhatsApp ID, your delivery address and area, what you order (items, options, notes, totals), and the messages you send and receive in the restaurant’s chat. On a restaurant’s menu page you type your name, WhatsApp number and address; the cart stays in that browser tab. From restaurant owners and staff: email address, login and security details (such as two-step verification), and the business details, menu and settings they enter. Technical data: security and error logs, and rate-limit keys made from your IP address or number with a one-way code, so your raw IP address is not stored for them; the sign-in service records the IP address and browser of each dashboard sign-in. Only the text of chat messages is kept: a shared location is saved as its name, address and coordinates, and a photo’s caption is saved as text, but photos, videos, documents and voice notes themselves are not stored; for those without text the chat is handed to staff.',
        ],
        [
          'Why we use it',
          'To take and show orders, send replies and order updates, let staff take over chats, copy orders to the restaurant’s Google Sheet if it connects one, sign people in and keep accounts secure, stop spam and abuse, fix problems, and send optional staff alerts. Orderly does not sell personal information, does not use it for advertising, and does not use customer chats to train AI models.',
        ],
        [
          'Automated replies',
          'Most replies in a restaurant’s chat are written by an automated assistant that uses AI. Orderly tells customers this at the start of a chat. You can ask for a person at any time, for example by typing “staff”, and restaurant staff can take over any chat. The assistant cannot set prices, and an order is placed only after you confirm the summary.',
        ],
        [
          'Who receives it',
          'Supabase hosts the database, logins and backend; the database is in Sydney, Australia. Cloudflare serves the website. Meta (WhatsApp) delivers messages for restaurants on the official WhatsApp Business Platform. Railway hosts Orderly’s WhatsApp gateway, only for restaurants that use the linked-phone connection: messages are decrypted and processed there, the encrypted WhatsApp session and contact IDs stay until the restaurant disconnects, incoming messages stay until Orderly has saved them (one Orderly cannot accept is kept for up to 24 hours, then deleted), and sent replies are kept encrypted for about 3 days so WhatsApp can resend one your phone could not open. The AI provider each restaurant chooses (OpenAI, Anthropic or Google) receives your current message, recent messages from the chat (which can include the name and address you typed, a photo’s caption, and the place name, address and coordinates of a location you shared), the menu and the restaurant’s bot settings, but not your WhatsApp number unless you type it. Google Sheets receives order details (name, number, address, items) if the restaurant connects a Sheet. Resend sends optional staff alert emails; it receives only the staff member’s email and a fixed notice with no customer details. Menu photos load from websites the restaurant chose, which can see your IP address. When an owner connects WhatsApp in the dashboard, Meta’s sign-up tool runs in their browser. Each provider handles data under its own terms.',
        ],
        [
          'International transfers',
          'Your information is stored and processed outside Pakistan, including in Australia (the database) and in the countries where the providers above operate, such as the United States. The service cannot work without sending it there.',
        ],
        [
          'How long we keep it',
          `Customer chats, orders and customer details are kept until the restaurant deletes them, or until the restaurant turns on automatic deletion in Security & privacy (records inactive for 30 to 3,650 days). If a menu-page order code is not used, the details typed with it are wiped within about an hour. Activity logs, and delivery receipts not linked to a chat, are deleted after about 90 days. The contents of finished background tasks (such as a message waiting to be processed or a reply waiting to be sent) are cleared after 14 days; a task that failed for good keeps its contents until staff retry it or the restaurant deletes that customer’s details. Blocked numbers are kept until staff unblock them. Security audit records, which hold no message text, are kept. Orderly’s database backups are kept for ${BACKUP_DAYS} days, encrypted and away from the operator’s computer; the computer itself keeps only the two newest copies, and a deleted backup can stay up to 30 more days in the cloud storage’s recycle bin. Copies in Google Sheets, WhatsApp, AI providers, the linked-phone gateway, downloaded exports and provider backups follow their own retention.`,
        ],
        [
          'Your rights and requests',
          `To see, correct or delete your information, contact the restaurant you ordered from: it controls your data and can export or delete your chats and orders. Orderly support helps restaurants with these requests. You can also email ${supportEmail} with the restaurant’s name and the WhatsApp number you used. We check that a request really comes from you, or from the restaurant, before acting, and tell you if something must be kept, for example for security or by law. Never send passwords or codes.`,
        ],
        [
          'Payments',
          'Orderly does not collect card numbers, bank account details or CNIC numbers, and does not handle payments. You pay the restaurant directly, as you arrange with it: usually cash on delivery or at pickup. A JazzCash, Easypaisa or bank transfer is possible only if the restaurant offers it: the order confirmation then says so, the restaurant gives you its payment details itself, and restaurant staff check the transfer themselves outside Orderly. Please do not send card, bank or CNIC details in the chat: anything typed there is kept with the chat until it is deleted.',
        ],
        [
          'Security and incidents',
          'Data travels over HTTPS. Stored AI keys and WhatsApp and Google credentials are encrypted. Access to a restaurant’s data is limited to its own owners and staff and to Orderly’s platform administrators, who use it only for support, security and operations. No system is perfectly secure. If Orderly confirms a security incident affecting personal information, it tells the affected restaurants without undue delay, shares what is known, and helps them inform their customers and, where required, the authorities.',
        ],
        [
          'Changes to this policy',
          'We update this policy when the service changes. The “Last updated” date above shows the last change. For important changes we tell connected restaurants by email before they take effect where we can.',
        ],
        [
          'Contact',
          `${OPERATOR}. Email ${supportEmail} for privacy questions and requests. Include the restaurant’s name and the WhatsApp number or account email involved. You can also contact the restaurant directly.`,
        ],
      ],
    },
    terms: {
      title: 'Terms of Service',
      intro: `These terms govern the Orderly pilot service, run by ${OPERATOR}. By using Orderly, a business agrees to use it lawfully and to supervise the automated customer chats it runs.`,
      sections: [
        [
          'Business responsibility',
          'The business is responsible for its menu and prices (including whether prices include sales tax, and any receipt or tax invoice its province requires), its allergy and dietary answers, payments it takes outside Orderly, its customer communications, staff access, legal notices, and following the rules of Meta, WhatsApp, its AI provider and other services it connects.',
        ],
        [
          'Customer data',
          'The business is the controller of its customers’ information. Orderly processes that information for the business, only to provide the service and as described in the Privacy Policy. Orderly’s platform administrators can access workspace data for support, security and operations.',
        ],
        [
          'WhatsApp connection',
          'The official WhatsApp Business Platform (Cloud API, with the coexistence option to keep using the WhatsApp Business app) is the supported route. The linked-phone connection is an unofficial method that Orderly runs on its own gateway server. It is against WhatsApp’s terms, and WhatsApp can ban the whole number, temporarily or permanently, including the business’s own WhatsApp app. New linked-phone pairings are possible only for businesses the platform administrator approves, after the owner accepts these risks. A business that chooses it accepts that risk.',
        ],
        [
          'AI providers',
          'Each business connects its own AI key and pays its provider. It must use a paid plan whose terms do not allow the provider to use customer data to train or improve models, and must not switch on any data-sharing or training option. Free Google Gemini keys (AI Studio without billing) must not be used with real customers.',
        ],
        [
          'Acceptable use',
          'Do not use Orderly for unlawful, deceptive, abusive or unwanted messaging, bulk broadcasts, or to process information you do not have permission to use. Do not ask customers for card numbers, bank account numbers or CNIC numbers in chat. Do not sell items that WhatsApp’s commerce rules prohibit, such as alcohol or tobacco.',
        ],
        [
          'Automated output',
          'Automated replies can be wrong. Orderly tells customers that replies are automated and lets them ask for a person. Businesses must review their settings, watch handoffs, and confirm important order and customer details before relying on them.',
        ],
        [
          'Security incidents',
          'If Orderly confirms a security incident affecting a business’s workspace data, it tells the business without undue delay, shares what is known (what happened, when, which kinds of data, and what was done), keeps it updated, and helps with any notice to customers or authorities.',
        ],
        [
          'Availability',
          'The pilot service is provided as available and may change or have interruptions. Meta, WhatsApp, AI providers and other services can limit, suspend or change their integrations on their own.',
        ],
        [
          'Ending access',
          'A business may stop using the service at any time. Orderly deletes a workspace on request; this is done by Orderly, not from the dashboard, after the business has exported anything it needs. Copies in Google Sheets, WhatsApp, AI providers and backups follow their own retention. Orderly may suspend access to protect customers, comply with law or prevent misuse.',
        ],
        [
          'Changes to these terms',
          'We tell connected businesses by email before important changes take effect where we can. The “Last updated” date above shows the last change.',
        ],
      ],
    },
    'data-deletion': {
      title: 'User Data Deletion',
      intro:
        'You can ask for your information to be deleted, a restaurant can ask for its whole workspace to be deleted, and a restaurant can disconnect Orderly from WhatsApp.',
      sections: [
        [
          'Customers',
          `Contact the restaurant you ordered from, or email ${supportEmail} with the restaurant’s name and the WhatsApp number you used. Restaurant owners can export or delete a customer’s chats and orders in Security & privacy after checking the request. Never send passwords, access tokens or verification codes.`,
        ],
        [
          'Restaurants',
          `An owner can ask Orderly to delete the whole workspace by emailing ${supportEmail} from the owner’s account email. Orderly does this by hand after confirming the request: it pauses the bot, disconnects WhatsApp, Google Sheets and AI keys, then deletes the workspace data.`,
        ],
        [
          'Disconnect WhatsApp',
          'On the official route, a business administrator can remove Orderly’s permissions in Meta Business settings and disconnect WhatsApp in Orderly. On the linked-phone connection, disconnect in Orderly and remove the Orderly session in WhatsApp → Linked devices on the phone. Disconnecting stops new messages but does not by itself delete information already stored.',
        ],
        [
          'What happens next',
          `After confirming a request, the chats and orders are deleted from the active database. Security audit records, which hold no message text, are kept. Copies in Google Sheets, WhatsApp, AI providers, downloaded exports and backups are not removed by this and follow their own retention; Orderly’s backups expire after ${BACKUP_DAYS} days (a deleted copy can stay up to 30 more days in a cloud recycle bin). We tell you when it is done, or what must be kept and why.`,
        ],
      ],
    },
  };

// Turns the support address in the copy into a mailto link; the words stay the same.
function withEmailLink(text: string) {
  const parts = text.split(supportEmail);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <a className="text-brand-800 underline underline-offset-2" href={`mailto:${supportEmail}`}>
          {supportEmail}
        </a>
      )}
    </Fragment>
  ));
}

export function LegalPage({ kind }: { kind: LegalKind }) {
  const document = documents[kind];
  return (
    <main className="min-h-dvh canvas-glow px-4 py-10 text-stone-800 sm:py-16">
      <article className="card enter-rise mx-auto max-w-3xl p-7 sm:p-12">
        <a
          className="group inline-flex items-center gap-3 font-serif text-[28px] font-normal leading-none tracking-[-0.01em] text-ink"
          href="/"
        >
          <span className="relative flex size-10 -rotate-6 items-center justify-center rounded-xl bg-[linear-gradient(to_bottom,var(--color-canvas)_50%,var(--color-brand-500)_50%)] text-ink shadow-[0_10px_20px_-10px_rgb(255_105_44/0.7)] transition-transform duration-500 ease-[var(--ease-spring)] group-hover:rotate-3 group-hover:scale-105">
            <MessageCircle className="size-5" strokeWidth={2.5} />
            <span className="live-dot absolute right-1.5 top-1.5 size-1.5 rounded-full bg-current text-brand-500 ring-2 ring-canvas" />
          </span>
          {/* One flex item, so the gap doesn't separate the word from its dot. */}
          <span>
            orderly<span className="text-brand-500">.</span>
          </span>
        </a>
        <h1 className="mt-10 font-serif text-[40px] font-normal leading-[1.02] tracking-[-0.012em] text-ink sm:text-[52px]">
          {document.title}
        </h1>
        <p className="mt-4 leading-7 text-stone-600">{withEmailLink(document.intro)}</p>
        <p className="eyebrow mt-4">Last updated {LEGAL_LAST_UPDATED}</p>
        <div className="stagger mt-10 space-y-8">
          {document.sections.map(([title, copy]) => (
            <section key={title}>
              <h2 className="panel-title">{title}</h2>
              <p className="mt-2 leading-7 text-stone-600">{withEmailLink(copy)}</p>
            </section>
          ))}
        </div>
        <nav className="mt-12 flex flex-wrap gap-2 border-t border-ink/[0.06] pt-6 text-sm">
          <a
            className="rounded-full border border-white/90 bg-white/75 px-4 py-2 text-xs font-semibold text-stone-700 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] transition-[background-color,color,translate,scale] duration-200 hover:-translate-y-px hover:bg-white hover:text-ink active:scale-95"
            href="/privacy"
          >
            Privacy Policy
          </a>
          <a
            className="rounded-full border border-white/90 bg-white/75 px-4 py-2 text-xs font-semibold text-stone-700 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] transition-[background-color,color,translate,scale] duration-200 hover:-translate-y-px hover:bg-white hover:text-ink active:scale-95"
            href="/terms"
          >
            Terms of Service
          </a>
          <a
            className="rounded-full border border-white/90 bg-white/75 px-4 py-2 text-xs font-semibold text-stone-700 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] transition-[background-color,color,translate,scale] duration-200 hover:-translate-y-px hover:bg-white hover:text-ink active:scale-95"
            href="/data-deletion"
          >
            Data Deletion
          </a>
        </nav>
      </article>
    </main>
  );
}
