import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { t } from './i18n.js';

const run = promisify(execFile);
const PACKAGE = 'nova-jdk';

export interface UpdateInfo { current: string; latest: string; updateAvailable: boolean }

function compare(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

export async function latestVersion(current: string, fetcher: typeof fetch = fetch): Promise<UpdateInfo> {
  const response = await fetcher(`https://registry.npmjs.org/${PACKAGE}`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(t('Cannot check npm for updates: HTTP {0}', response.status));
  const data = await response.json() as { ['dist-tags']?: { latest?: string } };
  const latest = data['dist-tags']?.latest;
  if (!latest) throw new Error(t('npm did not return a latest version.'));
  return { current, latest, updateAvailable: compare(latest, current) > 0 };
}

export async function updatePackage(): Promise<void> {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    await access(npmCli);
    await run(process.execPath, [npmCli, 'install', '--global', `${PACKAGE}@latest`], { windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      await run(npm, ['install', '--global', `${PACKAGE}@latest`], { windowsHide: true, maxBuffer: 1024 * 1024 });
      return;
    }
    throw error;
  }
}
