import { t } from './i18n.js';
export const cancellation = new AbortController();
const DOWNLOAD_HOSTS = new Set(['corretto.aws', 'downloads.corretto.aws']);
export function officialDownload(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
    throw new Error(t("Untrusted Corretto download URL: {0}", url));
  }
  return parsed;
}
export async function fetchDownload(url: string): Promise<Response> {
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15 * 60_000)]);
  let next = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    officialDownload(next);
    const response = await fetch(next, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(t("Download redirect has no location."));
      next = new URL(location, next).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(t("Download failed: HTTP {0}", response.status)); }
    return response;
  }
  throw new Error(t("Too many download redirects."));
}
