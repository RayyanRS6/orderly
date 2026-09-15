import { MessageCircle } from 'lucide-react';

type LegalKind = 'privacy' | 'terms' | 'data-deletion';

const documents: Record<LegalKind, { title: string; intro: string; sections: [string, string][] }> =
  {
    privacy: {
      title: 'Privacy Policy',
      intro:
        'Orderly helps businesses receive customer messages, answer questions, and manage orders. This policy explains how information is handled when a business uses Orderly.',
      sections: [
        [
          'Information we process',
          'We may process account and business details, WhatsApp identifiers and message content, menu and order information, integration settings, and technical logs needed to operate and secure the service.',
        ],
        [
          'How information is used',
          'Information is used to authenticate users, connect approved business services, deliver and automate messages, create and manage orders, troubleshoot failures, prevent abuse, and improve reliability.',
        ],
        [
          'Service providers',
          'Orderly uses service providers selected by the platform operator or connected business, including Meta and WhatsApp, hosting and database providers, AI providers, and Google Sheets. Each provider processes information under its own terms and privacy policy. Orderly does not sell personal information.',
        ],
        [
          'Retention and security',
          'Information is retained only while needed to provide the service, meet legitimate operational needs, or satisfy legal obligations. Access is restricted by business membership, and integration credentials are encrypted at rest.',
        ],
        [
          'Your choices',
          'A connected business can pause automation, disconnect integrations, or request deletion of its workspace data. Customers may contact the business they messaged to exercise applicable privacy rights.',
        ],
        [
          'Contact',
          'For privacy questions or deletion requests, contact the business that gave you access to Orderly or use the existing support channel through which your Orderly workspace was provided.',
        ],
      ],
    },
    terms: {
      title: 'Terms of Service',
      intro:
        'These terms govern access to the Orderly pilot service. By using Orderly, a business agrees to use it lawfully and to supervise automated customer interactions.',
      sections: [
        [
          'Business responsibility',
          'The connected business is responsible for its menu, prices, customer communications, staff access, legal notices, and compliance with Meta, WhatsApp, AI-provider, and other third-party rules.',
        ],
        [
          'Acceptable use',
          'Do not use Orderly for unlawful, deceptive, abusive, or unauthorized messaging, or to process information you do not have permission to use.',
        ],
        [
          'Automated output',
          'Automated replies can be incorrect. Businesses must review configuration, monitor handoffs, and verify important order and customer information before relying on it.',
        ],
        [
          'Availability',
          'The pilot service is provided as available and may change or experience interruptions. Third-party services can independently limit, suspend, or change their integrations.',
        ],
        [
          'Ending access',
          'A business may stop using the service and request deletion of its workspace. Access may be suspended to protect customers, comply with law, or prevent misuse.',
        ],
      ],
    },
    'data-deletion': {
      title: 'User Data Deletion',
      intro:
        'You can request deletion of information associated with an Orderly workspace or disconnect Orderly from Meta and WhatsApp.',
      sections: [
        [
          'Request deletion',
          'Contact the business that provided your Orderly workspace through your existing support channel. Identify the workspace and the account or phone number whose data should be deleted. Do not send passwords, access tokens, or verification codes.',
        ],
        [
          'Disconnect Meta access',
          'A business administrator can remove Orderly permissions in Meta Business settings and disconnect its WhatsApp integration in Orderly. Revoking access stops new collection but does not by itself delete information already stored.',
        ],
        [
          'What happens next',
          'After a valid request is confirmed, Orderly will delete or anonymize applicable workspace, conversation, and integration data unless retention is required for security, fraud prevention, dispute resolution, or law.',
        ],
      ],
    },
  };

export function LegalPage({ kind }: { kind: LegalKind }) {
  const document = documents[kind];
  return (
    <div className="min-h-dvh bg-[#f8fafc] px-4 py-10 text-stone-800 sm:py-16">
      <article className="mx-auto max-w-3xl rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-12 shadow-sm">
        <a
          className="inline-flex items-center gap-2.5 text-2xl font-bold tracking-tight text-stone-900"
          href="/"
        >
          <span className="relative flex size-8.5 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-700/20">
            <MessageCircle className="size-5" strokeWidth={2.5} />
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-white ring-2 ring-emerald-600" />
          </span>
          orderly<span className="self-end pb-0.5 text-emerald-500 font-extrabold">.</span>
        </a>
        <h1 className="mt-10 text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
          {document.title}
        </h1>
        <p className="mt-4 leading-7 text-stone-600">{document.intro}</p>
        <p className="mt-3 text-xs font-semibold text-stone-400 uppercase tracking-wider">
          Effective 15 September 2026
        </p>
        <div className="mt-10 space-y-8">
          {document.sections.map(([title, copy]) => (
            <section key={title}>
              <h2 className="text-lg font-bold text-stone-900">{title}</h2>
              <p className="mt-2 leading-7 text-stone-600">{copy}</p>
            </section>
          ))}
        </div>
        <nav className="mt-12 flex flex-wrap gap-2 border-t border-stone-100 pt-6 text-sm">
          <a
            className="rounded-full border border-stone-200 bg-stone-50 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 transition-all"
            href="/privacy"
          >
            Privacy Policy
          </a>
          <a
            className="rounded-full border border-stone-200 bg-stone-50 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 transition-all"
            href="/terms"
          >
            Terms of Service
          </a>
          <a
            className="rounded-full border border-stone-200 bg-stone-50 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 transition-all"
            href="/data-deletion"
          >
            Data Deletion
          </a>
        </nav>
      </article>
    </div>
  );
}
