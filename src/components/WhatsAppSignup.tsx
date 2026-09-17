import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Link2 } from 'lucide-react';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { ErrorNotice, Field } from './ui';

type SignupConfig = { enabled: boolean; appId: string; configId: string; version: string };
type FacebookSDK = {
  init: (config: Record<string, unknown>) => void;
  login: (
    callback: (response: { authResponse?: { code?: string } }) => void,
    config: Record<string, unknown>,
  ) => void;
};
const facebook = () => (window as unknown as { FB?: FacebookSDK }).FB;
let sdkPromise: Promise<void> | undefined;
function loadSDK() {
  if (facebook()) return Promise.resolve();
  return (sdkPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = undefined;
      script.remove();
      reject(new Error('Facebook could not load. Check your connection or browser settings.'));
    };
    document.head.append(script);
  }));
}

export function WhatsAppSignup() {
  const { data, mutate, busy } = useWorkspace();
  const [config, setConfig] = useState<SignupConfig>();
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [coexistence, setCoexistence] = useState(true);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pendingSignupTimer = useRef<number | undefined>(undefined);
  const session = useRef<{
    active: boolean;
    code?: string;
    phoneNumberId?: string;
    wabaId?: string;
    coexistence?: boolean;
    pin?: string;
  }>({ active: false });
  const submit = useRef<() => void>(() => {});
  const clearPendingSignupTimer = () => {
    if (pendingSignupTimer.current !== undefined) {
      window.clearTimeout(pendingSignupTimer.current);
      pendingSignupTimer.current = undefined;
    }
  };
  submit.current = () => {
    const current = session.current;
    if (!current.active || !current.code || !current.phoneNumberId || !current.wabaId) return;
    clearPendingSignupTimer();
    current.active = false;
    setWorking(true);
    void mutate<{ message: string }>('/whatsapp/signup', {
      code: current.code,
      phoneNumberId: current.phoneNumberId,
      wabaId: current.wabaId,
      coexistence: current.coexistence ?? false,
      ...(current.pin ? { pin: current.pin } : {}),
    })
      .then((result) => {
        setNotice(result.message);
        setPin('');
      })
      .catch((reason) => setError(reason.message))
      .finally(() => setWorking(false));
  };
  useEffect(() => {
    let active = true;
    if (data.role === 'staff') return;
    void api<SignupConfig>('/whatsapp/signup-config', data.company.id)
      .then(async (value) => {
        if (!active) return;
        setConfig(value);
        if (!value.enabled) return;
        await loadSDK();
        if (!active) return;
        facebook()!.init({
          appId: value.appId,
          version: value.version,
          cookie: false,
          xfbml: false,
          autoLogAppEvents: false,
        });
        setReady(true);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    const listener = (event: MessageEvent) => {
      if (
        !session.current.active ||
        !['https://www.facebook.com', 'https://web.facebook.com', 'https://facebook.com'].includes(
          event.origin,
        )
      )
        return;
      let message;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (message?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (
        message.event === 'FINISH' ||
        message.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
      ) {
        session.current.phoneNumberId = message.data?.phone_number_id;
        session.current.wabaId = message.data?.waba_id;
        session.current.coexistence = message.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
        submit.current();
      } else if (['ERROR', 'CANCEL'].includes(message.event)) {
        clearPendingSignupTimer();
        session.current.active = false;
        setWorking(false);
        setNotice('Setup was not completed. Your current connection was kept.');
      }
    };
    window.addEventListener('message', listener);
    return () => {
      active = false;
      clearPendingSignupTimer();
      session.current.active = false;
      window.removeEventListener('message', listener);
    };
  }, [data.company.id, data.role]);
  if (data.role === 'staff') return null;
  function launch() {
    if (!ready || !config) return;
    setError('');
    setNotice('');
    clearPendingSignupTimer();
    session.current = { active: true, pin: coexistence ? undefined : pin || undefined };
    setWorking(true);
    // Keep FB.login inside the original click event so browsers allow the popup.
    facebook()!.login(
      (response) => {
        if (response.authResponse?.code) {
          session.current.code = response.authResponse.code;
          submit.current();
          // Meta can return the OAuth code without a completed Embedded Signup event when
          // the business account is ineligible for onboarding. Do not leave the UI locked
          // forever while waiting for phone_number_id and waba_id that will never arrive.
          pendingSignupTimer.current = window.setTimeout(() => {
            const current = session.current;
            if (current.active && current.code && (!current.phoneNumberId || !current.wabaId)) {
              current.active = false;
              setWorking(false);
              setError(
                'Meta did not complete WhatsApp number selection. Use Edit settings in Meta, or resolve the business portfolio onboarding restriction before trying again.',
              );
            }
          }, 12_000);
        } else {
          clearPendingSignupTimer();
          session.current.active = false;
          setWorking(false);
          setNotice('Facebook login was cancelled.');
        }
      },
      {
        config_id: config.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          ...(coexistence
            ? { featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
            : {}),
        },
      },
    );
  }
  return (
    <section className="card mb-6 p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-[10px] bg-ink text-brand-500">
          <Link2 className="size-5" />
        </div>
        <h2 className="panel-title">Connect with Facebook</h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-stone-500">
        The restaurant signs in with Meta and grants access to its WhatsApp account. Use an Embedded
        Signup v4 configuration in your Meta app.
      </p>
      {config?.enabled ? (
        <div className="mt-5 space-y-4">
          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <input
              className="mt-1 accent-brand-500"
              type="checkbox"
              checked={coexistence}
              disabled={working}
              onChange={(e) => setCoexistence(e.target.checked)}
            />
            <span>
              <span className="font-semibold text-stone-800">
                Keep using the WhatsApp Business mobile app
              </span>
              <span className="mt-0.5 block text-xs text-stone-400">
                Requests Meta’s coexistence flow for eligible existing Business App numbers.
              </span>
            </span>
          </label>
          {!coexistence && (
            <div className="max-w-sm">
              <Field
                label="Six-digit registration PIN (optional)"
                hint="For a new Cloud API number. Store this PIN securely; the app will not keep a copy."
              >
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={pin}
                  autoComplete="new-password"
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
            </div>
          )}
          <button
            className="btn btn-primary"
            disabled={!ready || busy || working || (!coexistence && !!pin && pin.length !== 6)}
            onClick={launch}
          >
            {working ? 'Completing setup…' : 'Continue with Facebook'}
            <ArrowRight className="size-4" />
          </button>
          {working && (
            <button
              className="btn btn-quiet ml-2"
              onClick={() => {
                clearPendingSignupTimer();
                session.current.active = false;
                setWorking(false);
              }}
            >
              Close setup
            </button>
          )}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-white bg-white/60 p-4 text-xs leading-relaxed text-stone-500">
          Available after the live backend is configured with your Meta app and Embedded Signup
          configuration. You can also connect a test number with its access token below.
        </p>
      )}
      <div className="mt-4">
        <ErrorNotice message={error} />
        {notice && (
          <p role="status" className="text-[13px] text-success-700">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
