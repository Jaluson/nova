import { t } from './i18n.js';
import path from 'node:path';
import { atomicJson, readJson } from './fs-utils.js';
import { cancellation, officialDownload } from './network.js';
import { majorOf, normalizeVersion, selectVersion } from './versions.js';
import { sameTarget, type Artifact, type Provider, type Target } from './types.js';

export interface Release { tag_name: string; draft: boolean; prerelease: boolean; body: string | null }
interface Cache { schema: 1; fetchedAt: number; artifacts: Artifact[] }
export function parseRelease(release: Release, major: number): Artifact[] {
  if (release.draft || release.prerelease) return [];
  let version: string;
  try { version = normalizeVersion(release.tag_name); } catch { return []; }
  if (!version.startsWith(`${major}.`)) return [];
  const result: Artifact[] = [];
  for (const line of (release.body ?? '').split(/\r?\n/)) {
    const columns = line.split('|');
    if (columns[2]?.trim() !== 'JDK') continue;
    const url = /\]\((https:\/\/[^\s)]+\.(?:tar\.gz|zip))\)/.exec(columns[3] ?? '')?.[1];
    const sha256 = /\b[a-f\d]{64}\b/i.exec(columns[4] ?? '')?.[0]?.toLowerCase();
    if (!url || !sha256) continue;
    let parsed: URL;
    try { parsed = officialDownload(url); } catch { continue; }
    const file = path.posix.basename(parsed.pathname);
    if (!file.startsWith('amazon-corretto-') || file.includes('alpine') || file.includes('debugsymbols')) continue;
    const match = /-(linux|macosx|windows)-(x64|aarch64)(?:-jdk)?\.(tar\.gz|zip)$/.exec(file);
    if (!match) continue;
    try {
      if (normalizeVersion(file.slice('amazon-corretto-'.length, match.index)) !== version) continue;
    } catch { continue; }
    const platform = match[1] === 'macosx' ? 'macos' : match[1] as 'linux' | 'windows';
    if ((platform === 'windows') !== (match[3] === 'zip')) continue;
    result.push({ provider: 'corretto', version, platform, arch: match[2] as Target['arch'], url, sha256, format: match[3] as Artifact['format'] });
  }
  return result;
}

export class CorrettoProvider implements Provider {
  constructor(private root: string, private request: typeof fetch = fetch, private warn: (message: string) => void = console.error) {}
  async list(major: number, refresh = false): Promise<Artifact[]> {
    majorOf(String(major));
    const file = path.join(this.root, 'cache', `corretto-${major}.json`);
    let cache: Cache | undefined;
    try { cache = await readJson<Cache>(file); } catch { /* A bad cache can be rebuilt. */ }
    if (cache?.schema !== 1 || !Array.isArray(cache.artifacts) || !Number.isFinite(cache.fetchedAt)) cache = undefined;
    if (!refresh && cache && Date.now() - cache.fetchedAt < 3_600_000) return cache.artifacts;
    try {
      const artifacts: Artifact[] = [];
      for (let page = 1; ; page++) {
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'nova-jdk', 'X-GitHub-Api-Version': '2022-11-28' };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const response = await this.request(`https://api.github.com/repos/corretto/corretto-${major}/releases?per_page=100&page=${page}`, {
          headers, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]), redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(t("GitHub API HTTP {0}{1}", response.status, [403, 429].includes(response.status) ? t('; rate limit may be exhausted. Set GITHUB_TOKEN or retry later') : ''));
        }
        const releases: unknown = await response.json();
        if (!Array.isArray(releases)) throw new Error(t("Invalid GitHub release response."));
        for (const release of releases) {
          if (typeof release?.tag_name !== 'string' || !(typeof release.body === 'string' || release.body === null)) throw new Error(t("Invalid GitHub release record."));
          artifacts.push(...parseRelease(release as Release, major));
        }
        if (releases.length < 100) break;
      }
      if (!artifacts.length) throw new Error(t("No verified portable JDKs found for Corretto {0}.", major));
      const unique = [...new Map(artifacts.map(a => [`${a.version}/${a.platform}/${a.arch}`, a])).values()];
      try { await atomicJson(file, { schema: 1, fetchedAt: Date.now(), artifacts: unique }); }
      catch { this.warn(t("Warning: could not save release cache.")); }
      return unique;
    } catch (error) {
      cancellation.signal.throwIfAborted();
      if (cache) {
        this.warn(t("Warning: using cached Corretto {0} metadata from {1}; {2}", major, new Date(cache.fetchedAt).toISOString(), String(error)));
        return cache.artifacts;
      }
      throw error;
    }
  }
  async resolve(selector: string, target: Target): Promise<Artifact> {
    const items = (await this.list(majorOf(selector))).filter(a => sameTarget(a, target));
    const artifact = selectVersion(items, selector);
    if (!artifact) throw new Error(t("No verified Corretto {0} archive for {1}/{2}. Run nova ls-remote {3}.", selector, target.platform, target.arch, majorOf(selector)));
    return artifact;
  }
}
