import { noteNetworkFailure, noteNetworkSuccess } from '../lib/network';
import { AuthError, HttpError, isNetworkError } from './types';

/** A typed address with https:// added when it has no scheme ("example.com/feed" → "https://example.com/feed"). */
export function withScheme(address: string): string {
  return /^https?:\/\//i.test(address) ? address : `https://${address}`;
}

/** Joins a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Miniflux answers errors as {"error_message": "..."}; other servers send plain text. */
export function readableError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error_message?: unknown };
    if (typeof parsed.error_message === 'string') return parsed.error_message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200);
}

/**
 * fetch for API calls: never sends cookies, never answered from the HTTP cache. Reports whether the server
 * answered at all, which is how Skim knows it's offline (see lib/network).
 */
export async function send(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store' });
    noteNetworkSuccess();
    return res;
  } catch (err) {
    if (isNetworkError(err)) noteNetworkFailure();
    throw err;
  }
}

/** The error for a response that isn't ok: AuthError when the login was refused, else HttpError with the server's reason. */
export async function responseError(res: Response): Promise<Error> {
  if (res.status === 401 || res.status === 403) return new AuthError();
  let detail = res.statusText;
  try {
    const body = await res.text();
    if (body) detail = readableError(body);
  } catch {
    /* keep statusText */
  }
  return new HttpError(res.status, detail);
}

/** send, throwing responseError for anything but a success. */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await send(url, init);
  if (!res.ok) throw await responseError(res);
  return res;
}
