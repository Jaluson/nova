import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { ZipFile } from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Artifact, Target } from '../src/types.js';
import { atomicJson } from '../src/fs-utils.js';
import { installationId, Store } from '../src/store.js';

export const target: Target = { platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', arch: process.arch === 'arm64' ? 'aarch64' : 'x64' };
export const temporary: string[] = [];
export async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'nova-test-'));
  temporary.push(root); return root;
}
export async function cleanup(): Promise<void> { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); }
export function artifact(version = '21.0.9.11.1', extra: Partial<Artifact> = {}): Artifact {
  return { provider: 'corretto', version, ...target, url: `https://corretto.aws/downloads/resources/${version}/jdk.tar.gz`, sha256: 'a'.repeat(64), format: target.platform === 'windows' ? 'zip' : 'tar.gz', ...extra };
}
export async function fakeHome(root: string, item: Artifact): Promise<void> {
  await mkdir(path.join(root, 'bin'), { recursive: true });
  const suffix = item.platform === 'windows' ? '.exe' : '';
  for (const name of ['java', 'javac']) {
    const file = path.join(root, 'bin', name + suffix);
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${name} ${item.version}'\n`);
    await chmod(file, 0o755);
  }
  await writeFile(path.join(root, 'release'), `IMPLEMENTOR="Amazon.com Inc."\nJAVA_VERSION="${item.version.startsWith('8.') ? '1.8.0_492' : item.version.split('.').slice(0, 3).join('.')}"\nOS_ARCH="${item.arch === 'x64' ? 'x86_64' : 'aarch64'}"\nOS_NAME="${{ windows: 'Windows', linux: 'Linux', macos: 'Darwin' }[item.platform]}"\n`);
}
export async function seed(store: Store, version: string): Promise<void> {
  const item = artifact(version);
  const id = installationId(item);
  const javaHome = path.join(store.root, 'jdks', id, 'jdk', ...(target.platform === 'macos' ? ['Contents', 'Home'] : []));
  await fakeHome(javaHome, item);
  await atomicJson(path.join(store.root, 'jdks', id, 'nova.json'), { ...item, id, javaHome, installedAt: new Date().toISOString() });
}
export async function archive(format: Artifact['format'], version = '21.0.9.11.1'): Promise<{ item: Artifact; bytes: Buffer }> {
  const root = await temp();
  const item = artifact(version, { format, ...(format === 'zip' ? { platform: 'windows' as const, arch: 'x64' as const } : { platform: 'linux' as const }) });
  const source = path.join(root, 'source');
  await fakeHome(path.join(source, 'jdk'), item);
  const file = path.join(root, `archive.${format}`);
  if (format === 'tar.gz') await tar.c({ cwd: source, gzip: true, file }, ['jdk']);
  else {
    const zip = new ZipFile();
    for (const entry of ['bin/java.exe', 'bin/javac.exe', 'release']) zip.addFile(path.join(source, 'jdk', entry), `jdk/${entry}`);
    zip.end(); await pipeline(zip.outputStream, createWriteStream(file));
  }
  const bytes = await readFile(file);
  item.sha256 = createHash('sha256').update(bytes).digest('hex');
  return { item, bytes };
}
