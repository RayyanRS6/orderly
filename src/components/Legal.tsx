import { MessageCircle } from 'lucide-react';

type LegalKind = 'privacy' | 'terms' | 'data-deletion';

const documents: Record<LegalKind, { title: string; intro: string; sections: [string, string][] }> =
  {
    privacy: {
      title: 'Privacy Policy',
      intro:
        'Orderly operates this service for connected businesses. The business you message controls its menu, customer relationships and use of your order information; Orderly processes that information to provide the service. Orderly manages its own account, support and security records. Our public contact is waytogalaxy999@gmail.com.',
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
          'Cloudflare hosts the website. Supabase provides authentication, the database and backend functions. Meta delivers WhatsApp messages. The business’s chosen AI provider (OpenAI, Google Gemini or Anthropic) receives message content and relevant business context to interpret requests. Google receives order data when Sheets is connected. Providers may process data outside Pakistan under their own terms. The business must review its provider’s tier and data-use settings before enabling AI. Orderly does not sell personal information or use customer chats to train its own models.',
        ],
        [
          'Retention and security',
          'There is no automatic customer-data expiry enabled by default. Businesses should choose a retention period appropriate to their needs and use the deletion controls or contact Orderly for cleanup. Authorized owners can export and delete a customer’s conversations and orders from the active database after pausing processing. Anonymous usage accounting and administrative audit events are retained for billing and security. Copies in Google Sheets, WhatsApp, AI providers, downloaded exports and backups have separate retention and must be handled separately. Deleted data may remain in provider backups until their expiry. Access is restricted by business membership, API credentials are encrypted at rest, and traffic uses HTTPS.',
        ],
        [
          'Your choices',
          'A connected business can pause automation, disconnect integrations, or request deletion of its workspace data. Customers may contact the business they messaged to exercise applicable privacy rights.',
        ],
        [
          'Contact',
          'Contact Orderly at waytogalaxy999@gmail.com for privacy questions, access, correction or deletion requests. Include the business name and relevant account or phone number. You may also contact the restaurant directly. We verify identity and authorization before acting, and explain any applicable retention restriction. Do not send passwords or access tokens.',
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
          'Email Orderly at waytogalaxy999@gmail.com or contact the business you messaged. Identify the workspace and the account or phone number whose data should be deleted. Owners can also use Security & privacy in the workspace to export or delete customer records after verifying the request. Do not send passwords, access tokens, or verification codes.',
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
    <div className="min-h-dvh bg-canvas px-4 py-10 text-stone-800 sm:py-16">
      <article className="card mx-auto max-w-3xl p-7 sm:p-12">
        <a
          className="inline-flex items-center gap-3 font-serif text-[21px] font-bold tracking-[-0.3px] text-ink"
          href="/"
        >
          <span className="relative flex size-10 items-center justify-center rounded-[11px] bg-[linear-gradient(to_bottom,var(--color-canvas)_50%,var(--color-brand-500)_50%)] text-ink">
            <MessageCircle className="size-5" strokeWidth={2.5} />
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand-500 ring-2 ring-canvas" />
          </span>
          orderly<span className="self-end pb-0.5 text-brand-500 font-extrabold">.</span>
        </a>
        <h1 className="mt-10 font-serif text-3xl font-bold tracking-[-0.4px] text-ink sm:text-4xl">
          {document.title}
        </h1>
        <p className="mt-4 leading-7 text-stone-600">{document.intro}</p>
        <p className="mt-3 text-xs font-semibold text-stone-400 uppercase tracking-wider">
          Effective 16 September 2026
        </p>
        <div className="mt-10 space-y-8">
          {document.sections.map(([title, copy]) => (
            <section key={title}>
              <h2 className="panel-title">{title}</h2>
              <p className="mt-2 leading-7 text-stone-600">{copy}</p>
            </section>
          ))}
        </div>
        <nav className="mt-12 flex flex-wrap gap-2 border-t border-ink/[0.06] pt-6 text-sm">
          <a
            className="rounded-[9px] border border-ink/8 bg-white/70 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-white hover:text-ink transition-all"
            href="/privacy"
          >
            Privacy Policy
          </a>
          <a
            className="rounded-[9px] border border-ink/8 bg-white/70 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-white hover:text-ink transition-all"
            href="/terms"
          >
            Terms of Service
          </a>
          <a
            className="rounded-[9px] border border-ink/8 bg-white/70 px-4 py-1.5 text-xs font-semibold text-stone-700 hover:bg-white hover:text-ink transition-all"
            href="/data-deletion"
          >
            Data Deletion
          </a>
        </nav>
      </article>
    </div>
  );
}
