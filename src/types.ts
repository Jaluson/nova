import { t } from './i18n.js';
export type Platform = 'windows' | 'macos' | 'linux';
export type Arch = 'x64' | 'aarch64';
export interface Target { platform: Platform; arch: Arch }
export interface Artifact extends Target {
  provider: 'corretto';
  version: string;
  url: string;
  sha256: string;
  format: 'zip' | 'tar.gz';
}
export interface Installation extends Artifact {
  id: string;
  javaHome: string;
  installedAt: string;
}
export function isArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Artifact>;
  if (item.provider !== 'corretto' || typeof item.version !== 'string' || !/^\d+(?:\.\d+)+$/.test(item.version)) return false;
  if (!['linux', 'macos', 'windows'].includes(item.platform as string) || !['x64', 'aarch64'].includes(item.arch as string)) return false;
  if (typeof item.url !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(item.sha256)) return false;
  if (item.format !== 'zip' && item.format !== 'tar.gz') return false;
  try {
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || !['corretto.aws', 'downloads.corretto.aws'].includes(url.hostname) || url.username || url.password || url.port) return false;
  } catch { return false; }
  return (item.platform === 'windows') === (item.format === 'zip');
}
export function isInstallation(value: unknown): value is Installation {
  return isArtifact(value) && typeof (value as Partial<Installation>).id === 'string' && typeof (value as Partial<Installation>).javaHome === 'string' && typeof (value as Partial<Installation>).installedAt === 'string';
}
export interface Provider {
  list(major: number, refresh?: boolean): Promise<Artifact[]>;
  resolve(selector: string, target: Target): Promise<Artifact>;
}
export function hostTarget(): Target {
  const platforms: Partial<Record<NodeJS.Platform, Platform>> = { win32: 'windows', darwin: 'macos', linux: 'linux' };
  const arches: Partial<Record<NodeJS.Architecture, Arch>> = { x64: 'x64', arm64: 'aarch64' };
  const platform = platforms[process.platform];
  const arch = arches[process.arch];
  if (!platform || !arch || (platform === 'windows' && arch !== 'x64')) {
    throw new Error(t("Unsupported platform: {0}/{1}", process.platform, process.arch));
  }
  if (platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (!report.header?.glibcVersionRuntime) throw new Error(t("nova v1 requires glibc on Linux; musl/Alpine is not supported."));
  }
  return { platform, arch };
}
export function sameTarget(a: Target, b: Target): boolean {
  return a.platform === b.platform && a.arch === b.arch;
}
