import { AuthError, HttpError } from './types';

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

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store' });
  if (res.status === 401 || res.status === 403) {
    throw new AuthError();
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = readableError(body);
    } catch {
      /* keep statusText */
    }
    throw new HttpError(res.status, detail);
  }
  return res;
}
