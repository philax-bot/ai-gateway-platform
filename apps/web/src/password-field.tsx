import { useState } from 'react';
import { Icon } from './v2';

/* Signal Atlas password field: one masked input plus one eye toggle for every
   password, passphrase and installation token. The toggle only changes what the
   screen shows; value, autocomplete hint and validation stay untouched, and the
   visible state is local to this field so switching it never leaves the secret
   readable after the form closes. */
export function PasswordInput({ id, value, onChange, required, minLength, describedBy, autoComplete }: {
  id: string; value: string; onChange: (value: string) => void; required?: boolean; minLength?: number; describedBy?: string; autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false), hint = visible ? '隐藏密码' : '显示密码';
  return <span className="password-field">
    <input id={id} type={visible ? 'text' : 'password'} value={value} required={required} minLength={minLength} aria-describedby={describedBy} autoComplete={autoComplete} onChange={event => onChange(event.target.value)} />
    <button type="button" className="password-toggle" aria-pressed={visible} aria-controls={id} aria-label={hint} title={hint} onClick={() => setVisible(current => !current)}><Icon name={visible ? 'eyeOff' : 'eye'} size={17} /></button>
  </span>;
}
