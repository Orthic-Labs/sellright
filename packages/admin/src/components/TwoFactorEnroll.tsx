import { useState, type CSSProperties } from 'react';
import { authThemeVars } from '../lib/branding';
import { RecoveryCodes } from './auth/RecoveryCodes';
import { TotpSetup } from './auth/TotpSetup';
import './auth/auth.css';

/**
 * Settings > Security: authenticator-app enrolment (issue #333 rebuild). Same component as the mandatory enrolment
 * screen — server-rendered QR, key grouped in fours with Copy, code-only confirmation (the current password only when
 * this session is not freshly signed in), then the one-time recovery codes with Copy and Download.
 */
export function TwoFactorEnroll({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [started, setStarted] = useState(false);
  return (
    <div style={{ ...(authThemeVars(null) as CSSProperties), maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--a-text)' }}>
      {codes ? <RecoveryCodes codes={codes} onDone={onDone} doneLabel="Done" />
        : started ? <TotpSetup onEnabled={setCodes} onCancel={onCancel} cancelLabel="Cancel" />
        : <button type="button" className="auth-btn auth-btn-primary" onClick={() => setStarted(true)}>Set up an authenticator app</button>}
    </div>
  );
}
