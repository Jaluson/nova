import { t } from './i18n.js';
export const MAJORS = [8, 11, 17, 21, 25, 26] as const;

export function versionParts(input: string): number[] {
  const value = input.trim();
  const legacy = /^8u(\d+)(?:[.-]b?(\d+))?(?:\.(\d+))?$/.exec(value);
  const parts = legacy
    ? [8, Number(legacy[1]), ...(legacy[2] ? [Number(legacy[2])] : []), ...(legacy[3] ? [Number(legacy[3])] : [])]
    : /^\d+(?:\.\d+)*$/.test(value) ? value.split('.').map(Number) : [];
  if (!parts.length || parts.some(p => !Number.isSafeInteger(p))) throw new Error(t("Invalid version: {0}", input));
  return parts;
}
export function normalizeVersion(input: string): string {
  return versionParts(input).join('.');
}
export function compareVersions(a: string, b: string): number {
  const av = versionParts(a), bv = versionParts(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
export function majorOf(selector: string): number {
  const major = versionParts(selector)[0]!;
  if (!(MAJORS as readonly number[]).includes(major)) throw new Error(t("Supported major versions: {0}", MAJORS.join(', ')));
  return major;
}
export function selectVersion<T extends { version: string }>(items: T[], selector: string): T | undefined {
  const normalized = normalizeVersion(selector);
  return items.filter(item => normalized.includes('.')
    ? normalizeVersion(item.version) === normalized
    : versionParts(item.version)[0] === Number(normalized))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}
