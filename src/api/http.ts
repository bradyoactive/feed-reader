import { AuthError, HttpError } from './types';

/** Joins a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
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
      if (body) detail = body.slice(0, 200);
    } catch {
      /* keep statusText */
    }
    throw new HttpError(res.status, detail);
  }
  return res;
}
