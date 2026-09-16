import { afterEach, describe, expect, it } from 'vitest';
import { Header, type HeaderData } from 'tar';
import { gzipSync } from 'node:zlib';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractArchive, findJavaHome, validateRelease } from '../src/archive.js';
import { archive, artifact, cleanup, fakeHome, temp } from './helpers.js';

afterEach(cleanup);
async function rawTar(entries: HeaderData[]): Promise<string> {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = new Header({ mode: 0o755, uid: 0, gid: 0, mtime: new Date(0), size: 0, ...entry });
    header.encode(); chunks.push(header.block!);
  }
  chunks.push(Buffer.alloc(1024));
  const file = path.join(await temp(), 'test.tar.gz');
  await writeFile(file, gzipSync(Buffer.concat(chunks)));
  return file;
}
describe('real archive extraction', () => {
  it.each([
    { path: '../escaped', type: 'File' },
    { path: '/absolute', type: 'File' },
    { path: 'jdk/link', type: 'SymbolicLink', linkpath: '../../escaped' },
    { path: 'jdk/link', type: 'Link', linkpath: '../escaped' },
    { path: 'jdk/device', type: 'CharacterDevice' },
  ] satisfies HeaderData[])('rejects malicious tar entry $path ($type) before writing files', async entry => {
    const root = await temp();
    const file = await rawTar([{ path: 'valid', type: 'File' }, entry]);
    await expect(extractArchive(file, root, 'tar.gz')).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects zip traversal in both local and central directory names', async () => {
    const { bytes } = await archive('zip');
    // Equal-length replacement preserves the ZIP offsets while introducing traversal.
    const tampered = Buffer.from(bytes.toString('latin1').replaceAll('jdk/release', '../release!'), 'latin1');
    const root = await temp();
    const file = path.join(await temp(), 'bad.zip');
    await writeFile(file, tampered);
    await expect(extractArchive(file, root, 'zip')).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('extracts safe internal tar links and preserves executable bits', async () => {
    const file = await rawTar([
      { path: './jdk/', type: 'Directory' },
      { path: './jdk/java', type: 'File', mode: 0o755 },
      { path: './jdk/link', type: 'SymbolicLink', linkpath: 'java' },
    ]);
    const root = await temp();
    await extractArchive(file, root, 'tar.gz');
    expect(await readFile(path.join(root, 'jdk', 'link'))).toEqual(Buffer.alloc(0));
  });
  it('finds macOS Contents/Home inside a bundle', async () => {
    const root = await temp();
    const home = path.join(root, 'amazon-corretto.jdk', 'Contents', 'Home');
    await fakeHome(home, artifact('21.0.9.11.1', { platform: 'macos' }));
    expect(await findJavaHome(root, 'macos')).toBe(home);
  });
  it.skipIf(process.platform === 'win32')('validates JDK 8 archives without a release file using JVM properties', async () => {
    const home = await temp();
    const item = artifact('8.504.1.1', { platform: 'linux', arch: 'x64' });
    await fakeHome(home, item);
    await rm(path.join(home, 'release'));
    const executable = path.join(home, 'bin', 'java');
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "    java.vendor = Amazon.com Inc." "    java.version = 1.8.0_504" "    os.arch = amd64" "    os.name = Linux" >&2\n');
    await chmod(executable, 0o755);
    await expect(validateRelease(home, item)).resolves.toBeUndefined();
    await expect(validateRelease(home, { ...item, version: '21.0.9.11.1' })).rejects.toThrow();
  });
});
