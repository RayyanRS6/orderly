import { ArrowRight, Check, MessageCircle } from 'lucide-react';
export const supportEmail = 'waytogalaxy999@gmail.com';
export function PublicHeader() {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <a
        className="group flex items-center gap-2 font-serif text-[28px] font-normal leading-none tracking-[-0.01em] text-ink"
        href="/"
      >
        <MessageCircle className="size-7 text-brand-600 transition-transform duration-500 ease-[var(--ease-spring)] group-hover:-rotate-12 group-hover:scale-110" />
        Orderly<span className="text-brand-500">.</span>
      </a>
      <nav className="flex flex-wrap items-center gap-1 text-[13.5px] font-medium">
        <a
          className="rounded-full px-3 py-1.5 text-stone-600 transition-colors hover:bg-ink/5 hover:text-ink"
          href="/#how-it-works"
        >
          How it works
        </a>
        <a
          className="rounded-full px-3 py-1.5 text-stone-600 transition-colors hover:bg-ink/5 hover:text-ink"
          href="/pricing"
        >
          Pricing
        </a>
        <a
          className="rounded-full px-3 py-1.5 text-stone-600 transition-colors hover:bg-ink/5 hover:text-ink"
          href="/contact"
        >
          Contact
        </a>
        <a href="/login" className="btn btn-ink ml-1">
          Sign in
        </a>
      </nav>
    </header>
  );
}
export function PublicFooter() {
  return (
    <footer className="mx-auto mt-16 flex max-w-6xl flex-wrap justify-between gap-4 border-t border-ink/[0.08] px-5 py-8 text-sm text-stone-500">
      <span>© 2026 Orderly</span>
      <nav className="flex flex-wrap gap-4">
        <a className="transition-colors hover:text-ink" href="/privacy">
          Privacy
        </a>
        <a className="transition-colors hover:text-ink" href="/terms">
          Terms
        </a>
        <a className="transition-colors hover:text-ink" href="/data-deletion">
          Data deletion
        </a>
        <a className="transition-colors hover:text-ink" href="/contact">
          Contact
        </a>
      </nav>
    </footer>
  );
}
export function Landing() {
  return (
    <div className="min-h-dvh bg-canvas">
      <PublicHeader />
      <main>
        <section className="hero-backdrop mx-auto grid max-w-6xl gap-12 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="eyebrow enter-pop mb-6 rounded-full border border-ink/10 bg-white/55 py-1.5 pl-3 pr-3.5 text-stone-600 max-sm:text-[10px] max-sm:tracking-[0.08em]">
              WhatsApp ordering for your restaurant
            </p>
            <h1 className="enter-rise font-serif text-[46px] font-normal leading-[0.98] tracking-[-0.02em] text-ink [--d:80ms] sm:text-[64px] lg:text-[72px]">
              From a customer’s message to an order your team can fulfill.
            </h1>
            <p className="enter-rise mt-6 max-w-xl text-[17px] leading-8 text-stone-600 [--d:160ms]">
              Orderly collects menu choices, names and delivery details, then saves confirmed
              requests for your staff to review. You choose the bot’s behavior and stay in control
              of every order.
            </p>
            <div className="enter-rise mt-9 flex flex-wrap gap-3 [--d:240ms]">
              <a className="btn btn-primary min-h-12! px-6 text-[15px]" href="/contact">
                Discuss your setup
                <ArrowRight className="size-4" />
              </a>
              <a className="btn min-h-12! px-6 text-[15px]" href="/login">
                Open your workspace
              </a>
            </div>
            <p className="enter-rise mt-5 text-xs text-stone-500 [--d:300ms]">
              Managed onboarding · English, Urdu and Roman Urdu · Staff handoff
            </p>
          </div>
          <div className="enter-rise rounded-[32px] border border-white/90 bg-[linear-gradient(160deg,rgb(255_255_255/0.85),rgb(255_255_255/0.6))] p-5 shadow-[inset_0_1px_0_#fff,0_40px_80px_-40px_rgb(14_6_4/0.35),0_30px_80px_-40px_rgb(255_105_44/0.45)] [--d:200ms] sm:p-8">
            <p className="eyebrow mb-5">Illustrative order flow</p>
            <div className="bubble-brand bubble-in-right ml-10 px-4 py-3 text-sm leading-6 [--d:600ms]">
              One chicken pulao, one cold drink and zarda, please.
            </div>
            <div className="bubble-them bubble-in-left mr-10 mt-3 px-4 py-3 text-sm leading-6 [--d:1000ms]">
              I’ll collect the details and show your menu-priced total before you confirm.
            </div>
            <div className="enter-pop mt-6 rounded-[24px] bg-white p-5 shadow-[0_0_0_1px_rgb(14_6_4/0.05),0_20px_40px_-24px_rgb(14_6_4/0.35)] [--d:1150ms]">
              <h2 className="font-serif text-[22px] leading-tight text-ink">
                Ready for the restaurant
              </h2>
              <ul className="check-cascade mt-4 space-y-3 text-sm text-stone-600">
                {[
                  'Items, quantities and menu prices',
                  'Customer name and WhatsApp number',
                  'Delivery address and service area',
                  'Pending order and spreadsheet copy',
                  'Staff call, acceptance and dispatch',
                ].map((x) => (
                  <li key={x} className="flex items-start gap-2.5">
                    <Check className="pop-spin size-5 shrink-0 rounded-full bg-ink p-[3px] text-cream" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
        <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <h2 className="reveal font-serif text-[36px] font-normal leading-[1.02] tracking-[-0.015em] text-ink sm:text-[48px]">
            One workspace for each business.
          </h2>
          <div className="reveal-cascade mt-8 grid gap-5 md:grid-cols-3">
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
              <article key={title} className="card reveal p-6 sm:p-7">
                <h3 className="font-serif text-[26px] leading-tight text-ink">{title}</h3>
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
          <div className="reveal rounded-[32px] bg-ink glow-dark p-6 text-white shadow-[0_50px_90px_-50px_rgb(255_105_44/0.4),0_30px_60px_-30px_rgb(0_0_0/0.6)] sm:p-12">
            <h2 className="font-serif text-[36px] font-normal leading-[1.02] tracking-[-0.015em] sm:text-[48px]">
              A setup that fits your business.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-cream/70">
              Pricing depends on the number of locations, onboarding work and support required. Your
              business pays its WhatsApp and AI provider usage directly when using its own accounts.
              Orderly’s setup and management fees are quoted separately.
            </p>
            <a className="btn btn-primary mt-7 min-h-12! px-6 text-[15px]" href="/contact">
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
    <div className="min-h-dvh canvas-glow">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-5 py-12">
        <p className="eyebrow enter-pop rounded-full border border-ink/10 bg-white/55 py-1.5 pl-3 pr-3.5 text-stone-600">
          Orderly support
        </p>
        <h1 className="enter-rise mt-5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-0.015em] text-ink [--d:80ms] sm:text-[60px]">
          Let’s get your business connected.
        </h1>
        <p className="enter-rise mt-6 text-[17px] leading-8 text-stone-600 [--d:160ms]">
          For setup, pricing, support, privacy questions or deletion requests, contact Orderly at:
        </p>
        <a
          className="enter-rise mt-6 block break-all font-serif text-[30px] leading-tight text-brand-700 underline decoration-brand-500/40 decoration-2 underline-offset-[6px] transition-colors hover:text-brand-600 hover:decoration-brand-500 [--d:240ms]"
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
    <div className="min-h-dvh canvas-glow">
      <PublicHeader />
      <main className="mx-auto max-w-xl px-5 py-20">
        <p className="pop-in inline-block -rotate-6 font-serif text-[88px] leading-none text-brand-700">
          404
        </p>
        <h1 className="enter-rise mt-4 font-serif text-[40px] font-normal leading-tight text-ink [--d:120ms]">
          Page not found
        </h1>
        <p className="mt-4 text-stone-600">Check the address, or return to your workspace.</p>
        <div className="enter-rise mt-7 flex gap-3 [--d:220ms]">
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
    <div className="min-h-dvh canvas-glow">
      <PublicHeader />
      <main className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <p className="eyebrow enter-pop rounded-full border border-ink/10 bg-white/55 py-1.5 pl-3 pr-3.5 text-stone-600">
          Managed restaurant onboarding
        </p>
        <h1 className="enter-rise mt-5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-0.015em] text-ink [--d:80ms] sm:text-[60px]">
          Clear costs, agreed before you start.
        </h1>
        <p className="enter-rise mt-6 max-w-2xl text-[17px] leading-8 text-stone-600 [--d:160ms]">
          Your quote separates Orderly's setup and service fee from the WhatsApp and AI usage you
          pay to your providers. We agree the scope, support hours and usage expectations before
          connecting your business.
        </p>
        <div className="stagger mt-10 grid gap-5 md:grid-cols-3">
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
            <section key={title} className="card p-6 sm:p-7">
              <h2 className="panel-title">{title}</h2>
              <p className="mt-4 text-sm leading-7 text-stone-600">{text}</p>
            </section>
          ))}
        </div>
        <section className="mt-9 space-y-4 rounded-[28px] border-[1.5px] border-dashed border-ink/20 p-6 sm:p-8">
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
