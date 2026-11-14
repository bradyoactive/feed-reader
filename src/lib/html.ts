const SUMMARY_LIMIT = 600;

/** Turns article HTML into a short plain-text summary without ever inserting it into the page. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, figure figcaption').forEach((n) => n.remove());
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT).trimEnd()}…` : text;
}

/** First usable image URL in article HTML, resolved against the article URL. */
export function firstImage(html: string | undefined | null, baseUrl?: string): string | undefined {
  if (!html) return undefined;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? img.getAttribute('data-src');
    if (!src || src.startsWith('data:')) continue;
    // Skip tracking pixels and tiny icons when the markup tells us their size.
    const w = Number(img.getAttribute('width'));
    const h = Number(img.getAttribute('height'));
    if ((w && w < 48) || (h && h < 48)) continue;
    return safeUrl(src, baseUrl);
  }
  return undefined;
}

/** Resolves a possibly-relative URL and only lets http(s) through. */
export function safeUrl(url: string | undefined, baseUrl?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
