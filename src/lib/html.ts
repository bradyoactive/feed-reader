import type { Entry } from '../api/types';

const SUMMARY_LIMIT = 600;

export interface ArticleSource {
  title?: string;
  /** The article's HTML (content, or summary when there's no content). */
  html?: string | null;
  url?: string;
  /** An image the feed attached (an enclosure), preferred over one found in the HTML. */
  image?: string;
}

/**
 * The parts of an Entry that come from the article itself, the same for every server: a safe link, a short
 * plain-text summary and a picture. The HTML is parsed once and never inserted into the page.
 */
export function parseArticle({ title, html, url, image }: ArticleSource): Pick<Entry, 'title' | 'url' | 'summary' | 'imageUrl'> {
  const doc = html ? new DOMParser().parseFromString(html, 'text/html') : null;
  return {
    title: title || '(untitled)',
    url: safeUrl(url) ?? '',
    imageUrl: safeUrl(image, url) ?? (doc ? firstImage(doc, url) : undefined),
    summary: doc ? summaryText(doc) : '',
  };
}

function summaryText(doc: Document): string {
  doc.querySelectorAll('script, style, noscript, iframe, figure figcaption').forEach((n) => n.remove());
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT).trimEnd()}…` : text;
}

/** First usable image in the article, resolved against the article URL. */
function firstImage(doc: Document, baseUrl?: string): string | undefined {
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
