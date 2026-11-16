import { useState, type FormEvent } from 'react';
import { ArrowLeft, Info, LogOut, Rss } from 'lucide-react';
import { createBackend } from '../api';
import { greaderLogin } from '../api/greader';
import { withScheme } from '../api/http';
import { minifluxLogin, type MinifluxAuth } from '../api/miniflux';
import { describeError } from '../api/types';
import type { ConnectionConfig } from '../lib/storage';
import { Field, inputClass, Notice } from './ui';

type Api = 'miniflux' | 'greader';
type MfAuthType = 'token' | 'basic';

interface Props {
  current: ConnectionConfig | null;
  notice: string | null;
  onConnect(config: ConnectionConfig, remember: boolean): void;
  onDisconnect?: () => void;
  onBack?: () => void;
}

export function ConnectScreen({ current, notice, onConnect, onDisconnect, onBack }: Props) {
  const existing = current && current.kind !== 'demo' ? current : null;
  const [api, setApi] = useState<Api>(existing?.kind ?? 'miniflux');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [mfAuth, setMfAuth] = useState<MfAuthType>(
    existing?.kind === 'miniflux' && existing.auth.type === 'basic' ? 'basic' : 'token',
  );
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(
    existing?.kind === 'greader' ? existing.username : existing?.kind === 'miniflux' && existing.auth.type === 'basic' ? existing.auth.username : '',
  );
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const mf = api === 'miniflux';

  /** Signs in and returns a config ready to save. */
  async function signIn(): Promise<ConnectionConfig> {
    if (!url.trim()) throw new Error('Enter your server URL.');
    const base = withScheme(url.trim()).replace(/\/+$/, '');
    if (mf) {
      const auth: MinifluxAuth =
        mfAuth === 'token' ? { type: 'token', token: token.trim() } : { type: 'basic', username: username.trim(), password };
      if (auth.type === 'token' && !auth.token) throw new Error('Paste your Miniflux API key.');
      const userId = await minifluxLogin(base, auth);
      return { kind: 'miniflux', url: base, auth, userId };
    }
    if (!username.trim() || !password) throw new Error('Enter your username and API password.');
    const authToken = await greaderLogin(base, username.trim(), password);
    return { kind: 'greader', url: base, username: username.trim(), authToken };
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const config = await signIn();
      const backend = createBackend(config);
      const [feeds, cats] = await Promise.all([backend.getFeeds(), backend.getCategories()]);
      setResult({ ok: true, message: `Connected — ${feeds.length} feeds in ${cats.length} categories.` });
    } catch (err) {
      setResult({ ok: false, message: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      onConnect(await signIn(), remember);
    } catch (err) {
      setResult({ ok: false, message: describeError(err) });
      setBusy(false);
    }
  }

  const choice = (on: boolean) =>
    `flex flex-col items-start gap-0.5 rounded-xl border-[1.5px] px-3.5 py-3 text-left ${
      on ? 'border-accent bg-sel-bg' : 'border-input-border bg-input-bg'
    }`;
  const seg = (on: boolean) =>
    `h-[34px] flex-1 rounded-lg text-[13px] font-medium ${on ? 'bg-seg-on text-text shadow-seg' : 'text-muted2'}`;

  return (
    <div className="min-h-full bg-side px-5 py-12 text-text sm:py-16">
      <div className="mx-auto flex max-w-[520px] flex-col items-center gap-7">
        {onBack && (
          <button onClick={onBack} className="-mb-3 flex items-center gap-1.5 self-start rounded-lg px-1 py-1 text-sm font-medium text-accent">
            <ArrowLeft size={16} aria-hidden /> Back to articles
          </button>
        )}
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-on-accent">
            <Rss size={26} strokeWidth={2.4} aria-hidden />
          </span>
          <h1 className="text-[28px] font-bold tracking-tight">Connect Skim to your server</h1>
          <p className="max-w-[460px] text-[15px] leading-relaxed text-muted2">
            Skim is a static page. It talks straight from your browser to your own Miniflux or Google Reader–compatible
            server — there is no Skim backend.
          </p>
        </div>

        {notice && <Notice tone="error">{notice}</Notice>}

        <form onSubmit={submit} className="flex w-full flex-col gap-5 rounded-2xl border border-border bg-bg p-7">
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2 text-[13px] font-semibold">API type</legend>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" aria-pressed={mf} onClick={() => setApi('miniflux')} className={choice(mf)}>
                <span className="text-sm font-semibold">Miniflux</span>
                <span className="text-[12.5px] leading-snug text-muted2">Native REST API (v1)</span>
              </button>
              <button type="button" aria-pressed={!mf} onClick={() => setApi('greader')} className={choice(!mf)}>
                <span className="text-sm font-semibold">Google Reader API</span>
                <span className="text-[12.5px] leading-snug text-muted2">FreshRSS, Miniflux and others</span>
              </button>
            </div>
          </fieldset>

          <Field
            id="server"
            label="Server URL"
            hint={
              mf
                ? 'The address you open Miniflux at.'
                : 'FreshRSS: https://…/api/greader.php · Miniflux: its base URL, with Google Reader integration turned on.'
            }
          >
            <input
              id="server"
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={mf ? 'https://reader.example.com' : 'https://rss.example.com/api/greader.php'}
              className={inputClass}
            />
          </Field>

          {mf && (
            <div className="flex rounded-[10px] bg-seg-bg p-[3px]">
              <button type="button" aria-pressed={mfAuth === 'token'} onClick={() => setMfAuth('token')} className={seg(mfAuth === 'token')}>
                API key
              </button>
              <button type="button" aria-pressed={mfAuth === 'basic'} onClick={() => setMfAuth('basic')} className={seg(mfAuth === 'basic')}>
                Username &amp; password
              </button>
            </div>
          )}

          {mf && mfAuth === 'token' ? (
            <Field id="token" label="API key" hint="Create one in Miniflux under Settings → API Keys. You can revoke it there any time.">
              <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="username" label="Username">
                <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
              </Field>
              <Field id="password" label={mf ? 'Password' : 'API password'}>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
              </Field>
              {!mf && (
                <span className="text-[12.5px] leading-snug text-muted2 sm:col-span-2">
                  Skim signs in once and keeps only the token the server returns, not your password. In FreshRSS, set
                  the API password under Profile → API management.
                </span>
              )}
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 h-[18px] w-[18px] accent-[var(--accent)]"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Remember on this device</span>
              <span className="text-[12.5px] leading-snug text-muted2">
                Saved in this browser’s local storage{mf && mfAuth === 'basic' ? ', including the password' : ''}. Untick
                to keep it for this tab only.
              </span>
            </span>
          </label>

          <div className="flex gap-2.5 rounded-[10px] bg-side px-3.5 py-3 text-[12.5px] leading-normal text-desc">
            <Info size={16} className="mt-px flex-none" aria-hidden />
            <span>
              Your server must allow cross-origin requests from <strong className="font-semibold">{location.origin}</strong>.
              Credentials are only ever sent to the server above.
            </span>
          </div>

          {result && (
            <Notice tone={result.ok ? 'ok' : 'error'} role="status">
              {result.message}
            </Notice>
          )}

          <div className="flex flex-wrap justify-end gap-2.5">
            <button
              type="button"
              onClick={test}
              disabled={busy}
              className="h-11 rounded-[10px] border border-input-border bg-input-bg px-4.5 text-sm font-semibold disabled:opacity-60"
            >
              Test connection
            </button>
            <button type="submit" disabled={busy} className="h-11 rounded-[10px] bg-accent px-5.5 text-sm font-semibold text-on-accent disabled:opacity-60">
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[13px] text-muted2">
          <button onClick={() => onConnect({ kind: 'demo' }, false)} className="font-medium text-accent underline-offset-2 hover:underline">
            Try it with demo data
          </button>
          {onDisconnect && (
            <button onClick={onDisconnect} className="flex items-center gap-1.5 font-medium text-err-fg underline-offset-2 hover:underline">
              <LogOut size={14} aria-hidden /> Sign out and forget this server
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
