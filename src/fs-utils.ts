import { t } from './i18n.js';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if (isMissing(error)) return undefined; throw new Error(t("Cannot read {0}: {1}", file, String(error))); }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
export async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, '.write-lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t("Another nova write is in progress. If no nova process is running, remove {0} and retry.", file));
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await action();
  } finally { await handle.close(); await rm(file, { force: true }); }
}
