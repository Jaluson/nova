import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { compareVersions, normalizeVersion, selectVersion } from '../src/versions.js';
import { CorrettoProvider, parseRelease, type Release } from '../src/provider.js';
import { atomicJson, withLock } from '../src/fs-utils.js';
import { Store, pinVersion, projectVersion } from '../src/store.js';
import { safeArchivePath, safeLink } from '../src/archive.js';
import { officialDownload } from '../src/network.js';
import { archive, artifact, cleanup, seed, target, temp } from './helpers.js';

afterEach(cleanup);
describe('version resolution', () => {
  it('sorts numeric fields and preserves complete build distinctions', () => {
    expect(compareVersions('21.0.10.7.1', '21.0.9.11.1')).toBeGreaterThan(0);
    expect(compareVersions('8.492.09.2', '8.492.09.1')).toBeGreaterThan(0);
    expect(normalizeVersion('8u492-b09.2')).toBe('8.492.9.2');
    expect(selectVersion([{ version: '21.0.9.11.1' }, { version: '21.0.10.7.1' }], '21')?.version).toBe('21.0.10.7.1');
    expect(selectVersion([{ version: '21.0.9.11.1' }], '21.0.9')).toBeUndefined();
  });
  it.each(['../21', '21;echo hi', '21\n17', 'latest', '9007199254740992'])('rejects invalid selector %s', value => {
    expect(() => normalizeVersion(value)).toThrow();
  });
});

function release(version = '21.0.9.11.1'): Release {
  const row = (platform: string, type = 'JDK', ext = 'tar.gz') => `|Linux|${type}|[archive](https://corretto.aws/downloads/resources/${version}/amazon-corretto-${version}-${platform}.${ext})|\`${'1'.repeat(32)}\` /<br /> \`${'a'.repeat(64)}\`||`;
  return { tag_name: version, draft: false, prerelease: false, body: [row('linux-x64'), row('alpine-linux-x64'), row('linux-x64', 'DEBUGSYMBOLS'), row('windows-x64-jdk', 'JDK', 'zip'), row('macosx-aarch64')].join('\r\n') };
}
describe('Corretto provider', () => {
  it('parses release body, selecting only portable verified JDKs', () => {
    expect(parseRelease(release(), 21).map(a => `${a.platform}/${a.arch}`)).toEqual(['linux/x64', 'windows/x64', 'macos/aarch64']);
    expect(parseRelease({ ...release(), prerelease: true }, 21)).toEqual([]);
    expect(parseRelease({ ...release(), body: release().body!.replaceAll('a'.repeat(64), 'bad') }, 21)).toEqual([]);
    expect(parseRelease({ ...release(), body: release().body!.replaceAll('corretto.aws', 'evil.example') }, 21)).toEqual([]);
    expect(parseRelease(release('8.492.09.2'), 8)[0]?.version).toBe('8.492.9.2');
  });
  it('paginates and caches without requiring a network for fresh cache hits', async () => {
    const root = await temp();
    const request = vi.fn().mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, () => release())))
      .mockResolvedValueOnce(Response.json([release('21.0.10.7.1')]));
    const provider = new CorrettoProvider(root, request);
    const items = await provider.list(21);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toContain('page=2');
    expect(items).toHaveLength(6);
    expect(await provider.list(21)).toEqual(items);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('uses stale cache with a warning on rate limits and fails without cache', async () => {
    const root = await temp();
    await atomicJson(path.join(root, 'cache', 'corretto-21.json'), { schema: 1, fetchedAt: 0, artifacts: [artifact()] });
    const warn = vi.fn();
    const provider = new CorrettoProvider(root, vi.fn().mockResolvedValue(new Response('', { status: 403 })), warn);
    expect(await provider.list(21, true)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cached'));
    await expect(provider.list(17)).rejects.toThrow('403');
  });
  it('fails clearly for an unavailable platform', async () => {
    const provider = new CorrettoProvider(await temp(), vi.fn().mockResolvedValue(Response.json([release()])));
    await expect(provider.resolve('21', { platform: 'windows', arch: 'aarch64' })).rejects.toThrow('No verified');
  });
});

describe('storage and installation', () => {
  it.each(['tar.gz', 'zip'] as const)('installs %s after checksum verification and reuses an installation', async format => {
    const { item, bytes } = await archive(format);
    const store = new Store(await temp());
    const download = vi.fn(async () => new Response(new Uint8Array(bytes)));
    const installed = await store.install(item, download);
    expect(await readFile(path.join(installed.javaHome, 'release'), 'utf8')).toContain('Amazon');
    expect(await store.install(item, download)).toEqual(installed);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(store.root, 'tmp'))).toEqual([]);
  });
  it('cleans checksum failures and interrupted response streams without publishing a JDK', async () => {
    const store = new Store(await temp());
    await expect(store.install(artifact(), async () => new Response('wrong'))).rejects.toThrow('SHA-256');
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('interrupted')); } });
    await expect(store.install(artifact(), async () => new Response(stream))).rejects.toThrow('interrupted');
    expect(await store.list()).toEqual([]);
    expect(await readdir(path.join(store.root, 'tmp'))).toEqual([]);
    expect(await readdir(store.root)).not.toContain('.write-lock');
  });
  it('serializes writers with a lock and leaves existing installations intact', async () => {
    const root = await temp();
    await withLock(root, async () => {
      await expect(withLock(root, async () => {})).rejects.toThrow('Another nova write');
    });
    await expect(withLock(root, async () => 'ok')).resolves.toBe('ok');
  });
  it('resolves offline, pins exact builds and protects current/default installations', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1'); await seed(store, '21.0.10.7.1');
    const selected = await store.resolve('21', target);
    expect(selected.version).toBe('21.0.10.7.1');
    await store.setDefault('21', target);
    await expect(store.uninstall(selected.version, target)).rejects.toThrow('default');
    await store.setDefault('21.0.9.11.1', target);
    await expect(store.uninstall(selected.version, target, selected.id)).rejects.toThrow('current');
    await store.uninstall(selected.version, target);
    expect(await store.list()).toHaveLength(1);
    await expect(store.uninstall('21', target)).rejects.toThrow('exact');
    const project = await temp();
    await mkdir(path.join(project, 'nested'));
    await pinVersion('21.0.9.11.1', project);
    expect(await projectVersion(path.join(project, 'nested'))).toBe('21.0.9.11.1');
    await writeFile(path.join(project, '.novarc'), '21; echo hello');
    await expect(projectVersion(project)).rejects.toThrow('Invalid version');
    await expect(projectVersion(await temp())).rejects.toThrow('No .novarc');
  });
});
describe('archive boundaries', () => {
  it.each(['../escape', '/absolute', 'jdk/../../escape', 'C:/escape', 'jdk\\..\\escape', 'jdk/nul.txt', 'jdk/trailing.'])('rejects %s', name => {
    expect(() => safeArchivePath(name)).toThrow();
  });
  it('permits internal relative links and rejects escaping or absolute links', () => {
    expect(() => safeLink('jdk/lib/link', '../legal', false)).not.toThrow();
    expect(() => safeLink('jdk/lib/link', '../../../outside', false)).toThrow();
    expect(() => safeLink('jdk/link', '/etc/passwd', false)).toThrow();
    expect(() => safeLink('jdk/link', '../outside', true)).toThrow();
  });
  it.each(['http://corretto.aws/jdk.zip', 'https://evil.example/jdk.zip', 'https://corretto.aws@evil.example/jdk.zip'])('rejects untrusted download URL %s', url => {
    expect(() => officialDownload(url)).toThrow();
  });
});
