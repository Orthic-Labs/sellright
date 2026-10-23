import { useEffect, useId, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { authThemeVars, fontFaceCss, useBranding } from '../../lib/branding';
import './auth.css';

/**
 * The frame of every sign-in journey screen (issue #333): one background, a centred card, the STORE's logo (or its
 * name as a wordmark) inside the card, and the store's palette and fonts. Renders invisibly until branding resolves so
 * a store's admin never flashes a foreign brand.
 */
export function AuthShell({ title, subtitle, children, footer, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { branding, ready } = useBranding();
  const vars = authThemeVars(branding.theme) as CSSProperties;
  const faces = fontFaceCss(branding);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => {
    if (branding.storeName) document.title = `Sign in · ${branding.storeName}`;
  }, [branding.storeName]);
  return (
    <div className="auth-page" style={{ ...vars, visibility: ready ? 'visible' : 'hidden' }} data-auth-ready={ready ? '1' : '0'}>
      {faces && <style>{faces}</style>}
      <main className={`auth-card${wide ? ' is-wide' : ''}`} aria-labelledby="auth-title">
        <div className="auth-brand">
          {branding.logoUrl && !logoFailed && <img src={branding.logoUrl} alt="" onError={() => setLogoFailed(true)} />}
          {branding.storeName && <span className="auth-wordmark">{branding.storeName}</span>}
        </div>
        <h1 id="auth-title" className="auth-title">{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        <div className="auth-body">{children}</div>
        {footer && <div className="auth-footer">{footer}</div>}
      </main>
    </div>
  );
}

/** Labelled input with optional show/hide toggle, hint, and an error rendered UNDER the field (aria-describedby). */
export function AuthField({ label, error, hint, toggle, aside, inputClassName, ...input }: InputHTMLAttributes<HTMLInputElement> & {
  label: string; error?: string | null; hint?: ReactNode; toggle?: boolean; aside?: ReactNode; inputClassName?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="auth-field">
      <div className="auth-label-row">
        <label className="auth-label" htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className="auth-control">
        <input
          id={id}
          {...input}
          type={toggle ? (shown ? 'text' : 'password') : input.type}
          className={`auth-input${toggle ? ' has-toggle' : ''}${inputClassName ? ` ${inputClassName}` : ''}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {toggle && (
          <button type="button" className="auth-toggle" onClick={() => setShown((v) => !v)} aria-pressed={shown} aria-label={shown ? 'Hide password' : 'Show password'}>
            {shown ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {error && <p id={`${id}-err`} className="auth-error-text">{error}</p>}
      {hint && !error && <p id={`${id}-hint`} className="auth-hint">{hint}</p>}
    </div>
  );
}

export function AuthAlert({ tone, children }: { tone: 'danger' | 'info' | 'success'; children: ReactNode }) {
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`auth-alert is-${tone}`}>{children}</div>;
}

export function AuthSpinner({ label = 'Working' }: { label?: string }) {
  return <><span className="auth-spinner" aria-hidden="true" /><span className="auth-sr">{label}</span></>;
}

/** Seconds → "4:59" / "12s". */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

/** A ticking countdown to `until` (ms epoch); 0 when passed. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

/** 6-digit authenticator code: one-time-code autofill, numeric keypad, digits only. */
export function CodeInput({ value, onChange, error, disabled, inputRef, label = 'Authentication code' }: {
  value: string; onChange: (v: string) => void; error?: string | null; disabled?: boolean; inputRef?: React.Ref<HTMLInputElement>; label?: string;
}) {
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor="auth-code">{label}</label>
      <input
        id="auth-code" ref={inputRef} name="one-time-code" className="auth-input is-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*"
        maxLength={6} placeholder="000000" value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={error ? 'auth-code-err' : undefined}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      {error && <p id="auth-code-err" className="auth-error-text">{error}</p>}
    </div>
  );
}
