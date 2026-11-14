/** Each feed gets one of ten colours (with light and dark variants in index.css), picked from its id. */
export function feedColor(feedId: string): string {
  let h = 0;
  for (let i = 0; i < feedId.length; i++) h = (h * 31 + feedId.charCodeAt(i)) | 0;
  return `var(--f-${Math.abs(h) % 10})`;
}

export function feedInitial(title: string): string {
  return (title.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}
