import path from 'node:path';
import { atomicJson, readJson, withLock } from './fs-utils.js';
import type { LanguagePreference } from './i18n.js';

export interface Settings { defaultId?: string; language?: LanguagePreference; jdkDir?: string; aliases?: Record<string, string>; [key: string]: unknown }
export async function readSettings(root: string): Promise<Settings> {
  return await readJson<Settings>(path.join(root, 'config.json')) ?? {};
}
export async function saveLanguage(root: string, language: LanguagePreference): Promise<void> {
  await withLock(root, async () => {
    const settings = await readSettings(root);
    await atomicJson(path.join(root, 'config.json'), { ...settings, language });
  });
}
