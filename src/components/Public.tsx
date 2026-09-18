import { ArrowRight, Check, MessageCircle } from 'lucide-react';
export const supportEmail = 'waytogalaxy999@gmail.com';
export function PublicHeader() {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <a className="flex items-center gap-2 text-xl font-bold tracking-tight" href="/">
        <MessageCircle className="size-7 text-brand-700" />
        Orderly<span className="text-brand-600">.</span>
      </a>
      <nav className="flex flex-wrap items-center gap-4 text-sm">
        <a href="/#how-it-works">How it works</a>
        <a href="/pricing">Pricing</a>
        <a href="/contact">Contact</a>
        <a href="/login" className="btn">
          Sign in
        </a>
      </nav>
    </header>
  );
}
export function PublicFooter() {
  return (
    <footer className="mx-auto mt-16 flex max-w-6xl flex-wrap justify-between gap-4 border-t border-stone-200 px-5 py-8 text-sm text-stone-500">
      <span>© 2026 Orderly</span>
      <nav className="flex flex-wrap gap-4">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/data-deletion">Data deletion</a>
        <a href="/contact">Contact</a>
      </nav>
    </footer>
  );
}
export function Landing() {
  return (
    <div className="min-h-dvh bg-canvas">
      <PublicHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="mb-5 text-xs font-bold uppercase tracking-[0.16em] text-brand-800">
              WhatsApp ordering for your restaurant
            </p>
            <h1 className="font-serif text-4xl font-bold leading-[1.12] tracking-tight text-stone-900 sm:text-6xl">
              From a customer’s message to an order your team can fulfill.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-stone-600">
              Orderly collects menu choices, names and delivery details, then saves confirmed
              requests for your staff to review. You choose the bot’s behavior and stay in control
              of every order.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a className="btn btn-primary" href="/contact">
                Discuss your setup
                <ArrowRight className="size-4" />
              </a>
              <a className="btn" href="/login">
                Open your workspace
              </a>
            </div>
            <p className="mt-4 text-xs text-stone-500">
              Managed onboarding · English, Urdu and Roman Urdu · Staff handoff
            </p>
          </div>
          <div className="rounded-3xl border border-brand-200 bg-brand-50 p-5 sm:p-8">
            <p className="mb-5 text-xs font-semibold uppercase tracking-wider text-brand-900">
              Illustrative order flow
            </p>
            <div className="ml-6 rounded-2xl rounded-tr-sm bg-brand-800 p-4 text-sm leading-6 text-white">
              One chicken pulao, one cold drink and zarda, please.
            </div>
            <div className="mr-6 mt-4 rounded-2xl rounded-tl-sm border border-brand-100 bg-white p-4 text-sm leading-6">
              I’ll collect the details and show your menu-priced total before you confirm.
            </div>
            <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
              <h2 className="font-semibold">Ready for the restaurant</h2>
              <ul className="mt-4 space-y-3 text-sm text-stone-600">
                {[
                  'Items, quantities and menu prices',
                  'Customer name and WhatsApp number',
                  'Delivery address and service area',
                  'Pending order and spreadsheet copy',
                  'Staff call, acceptance and dispatch',
                ].map((x) => (
                  <li key={x} className="flex gap-2">
                    <Check className="size-4 shrink-0 text-brand-700" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
        <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <h2 className="font-serif text-2xl font-bold tracking-tight sm:text-3xl">
            One workspace for each business.
          </h2>
          <div className="mt-7 grid gap-5 md:grid-cols-3">
            {[
              [
                '1. Configure',
                'Your Orderly operator adds the menu, delivery areas, bot instructions and approved answers. Test orders stay in a sandbox.',
              ],
              [
                '2. Connect',
                'The business authorizes its WhatsApp Business account and number through Meta, adds its AI API key and connects an order Sheet.',
              ],
              [
                '3. Supervise',
                'Customers message the business on WhatsApp. Your team sees conversations, handles exceptions, calls to confirm orders and updates fulfillment.',
              ],
            ].map(([title, copy]) => (
              <article key={title} className="card p-6">
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-7 text-stone-600">{copy}</p>
              </article>
            ))}
          </div>
          <p className="mt-5 text-sm leading-7 text-stone-500">
            A personal Facebook login authorizes business assets; it does not turn on a bot for a
            personal WhatsApp account. A WhatsApp Business account, eligible number, account
            permissions and Meta setup are required. Coexistence with the WhatsApp Business mobile
            app depends on Meta eligibility.
          </p>
        </section>
        <section className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <div className="rounded-3xl bg-ink p-6 text-white sm:p-10">
            <h2 className="font-serif text-2xl font-bold">A setup that fits your business.</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-300">
              Pricing depends on the number of locations, onboarding work and support required. Your
              business pays its WhatsApp and AI provider usage directly when using its own accounts.
              Orderly’s setup and management fees are quoted separately.
            </p>
            <a className="btn mt-6 bg-white text-stone-900" href="/contact">
              Request a quote
            </a>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
export function Contact() {
  return (
    <div className="min-h-dvh">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-5 py-12">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-800">
          Orderly support
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight">
          Let’s get your business connected.
        </h1>
        <p className="mt-6 text-base leading-8 text-stone-600">
          For setup, pricing, support, privacy questions or deletion requests, contact Orderly at:
        </p>
        <a
          className="mt-6 block break-all text-xl font-semibold text-brand-800 underline"
          href={`mailto:${supportEmail}`}
        >
          {supportEmail}
        </a>
        <p className="mt-6 text-sm leading-7 text-stone-500">
          Include your business name and a description of the issue. For customer privacy requests,
          name the restaurant you contacted and the relevant phone number. Please do not send
          passwords, API keys or verification codes. We verify requests before releasing or deleting
          customer information.
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
export function NotFound() {
  return (
    <div className="min-h-dvh">
      <PublicHeader />
      <main className="mx-auto max-w-xl px-5 py-20">
        <p className="text-sm text-stone-500">404</p>
        <h1 className="mt-3 text-3xl font-bold">Page not found</h1>
        <p className="mt-4 text-stone-600">Check the address, or return to your workspace.</p>
        <div className="mt-6 flex gap-3">
          <a className="btn" href="/">
            Home
          </a>
          <a className="btn btn-primary" href="/app">
            Open workspace
          </a>
        </div>
      </main>
    </div>
  );
}

export function Pricing() {
  return (
    <div className="min-h-dvh bg-canvas">
      <PublicHeader />
      <main className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-800">
          Managed restaurant onboarding
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold">
          Clear costs, agreed before you start.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-stone-600">
          Your quote separates Orderly's setup and service fee from the WhatsApp and AI usage you
          pay to your providers. We agree the scope, support hours and usage expectations before
          connecting your business.
        </p>
        <div className="mt-9 grid gap-5 md:grid-cols-3">
          {[
            [
              'One-time setup',
              'Workspace, menu, delivery rules, bot configuration, supported account connections and an owned-number acceptance test. Your quote defines the included setup and training.',
            ],
            [
              'Monthly Orderly service',
              'Access to the dashboard, order workflow and agreed support. Higher order volumes, extra branches or custom features may need a different quote.',
            ],
            [
              'Provider usage',
              'Your own AI API key and WhatsApp business account are billed separately by those providers. Usage, model, message category and destination affect their charges.',
            ],
          ].map(([title, text]) => (
            <section key={title} className="card p-6">
              <h2 className="panel-title">{title}</h2>
              <p className="mt-4 text-sm leading-7 text-stone-600">{text}</p>
            </section>
          ))}
        </div>
        <section className="mt-9 space-y-4 rounded-2xl border border-ink/10 p-6">
          <h2 className="panel-title">What to include in your request</h2>
          <p className="text-sm leading-7 text-stone-600">
            Tell us your restaurant name, number of branches, approximate monthly WhatsApp
            conversations, menu size and whether you already have a WhatsApp Business account. Do
            not send API keys or passwords by email.
          </p>
          <a className="btn btn-primary" href="/contact">
            Request a written quote <ArrowRight className="size-4" />
          </a>
        </section>
        <p className="mt-7 text-sm leading-7 text-stone-500">
          Meta eligibility and approval are separate from Orderly's fees. A connection is activated
          after setup checks and a real test. Staff still confirm orders by phone and manage
          preparation and dispatch. Payments, rider tracking and arbitrary workflow building are not
          included in the current ordering service.
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
