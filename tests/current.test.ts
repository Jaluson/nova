import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentJdk } from '../src/current.js';
import { Store } from '../src/store.js';
import { artifact, cleanup, fakeHome, seed, target, temp } from './helpers.js';

afterEach(cleanup);
const cli = path.resolve('dist/cli.js');
async function externalHome(version = '21.0.7', vendor = 'Eclipse Adoptium'): Promise<string> {
  const home = path.join(await temp(), '自定义 Java Home');
  await fakeHome(home, artifact());
  await writeFile(path.join(home, 'release'), `JAVA_VERSION="${version}"\nIMPLEMENTOR="${vendor}"\n`);
  return home;
}
function run(args: string[], root: string, javaHome: string, active?: string): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NOVA_HOME: root, JAVA_HOME: javaHome, NOVA_ACTIVE: active ?? '' } });
}

describe('existing JAVA_HOME discovery', () => {
  it('shows a first-time external JDK and its vendor without importing or modifying it', async () => {
    const root = await temp();
    const home = await externalHome();
    const output = run(['ls'], root, home);
    expect(output).toContain('21.0.7  current  external (Eclipse Adoptium)');
    expect(output).toContain(home);
    expect(output).not.toContain('No nova-managed JDKs');
    expect(run(['current'], root, home).trim()).toBe('21.0.7');
    expect(await readdir(root)).toEqual([]);
    expect((await readdir(home)).sort()).toEqual(['bin', 'release']);
  });

  it('marks a managed installation current even without NOVA_ACTIVE, with no duplicate external row', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    const item = await store.resolve('21', target);
    const output = run(['ls'], store.root, item.javaHome);
    expect(output.trim().split(/\r?\n/)).toHaveLength(1);
    expect(output).toContain('21.0.9.11.1  current');
    expect(output).not.toContain('external');
    expect(run(['current'], store.root, item.javaHome).trim()).toBe(item.version);
  });

  it('uses actual JAVA_HOME instead of a stale NOVA_ACTIVE marker and preserves default labels', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    const item = await store.setDefault('21', target);
    const home = await externalHome('17.0.12', 'Oracle Corporation');
    const output = run(['ls'], store.root, home, item.id);
    expect(output).toContain('21.0.9.11.1  default');
    expect(output).not.toContain('21.0.9.11.1  current');
    expect(output).toContain('17.0.12  current  external (Oracle Corporation)');
  });

  it('deduplicates a managed JDK reached through a symbolic link or junction', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    const item = await store.resolve('21', target);
    const alias = path.join(await temp(), 'jdk-link');
    await symlink(item.javaHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await currentJdk([item], { JAVA_HOME: alias }))?.installation?.id).toBe(item.id);
  });

  it('does not turn an invalid JAVA_HOME into a current JDK or hide managed installations', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    const home = path.join(await temp(), 'missing');
    await expect(currentJdk([], { JAVA_HOME: home })).rejects.toThrow('Cannot inspect JAVA_HOME');
    const output = run(['ls'], store.root, home);
    expect(output).toContain('21.0.9.11.1');
    expect(output).not.toContain('current');
    expect(await currentJdk([], {})).toBeUndefined();
    expect(run(['ls'], store.root, '')).not.toContain('current');
  });

  it('requires both java and javac, so a JRE is not labeled as an external JDK', async () => {
    const home = await externalHome();
    await rm(path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));
    await expect(currentJdk([], { JAVA_HOME: home })).rejects.toThrow('Cannot inspect JAVA_HOME');
  });

  it.skipIf(process.platform === 'win32')('recognizes a JDK 8 with no release file without interpreting path metacharacters', async () => {
    const home = path.join(await temp(), "jdk ' $ & 8");
    await mkdir(home);
    await fakeHome(home, artifact('8.504.1.1'));
    await rm(path.join(home, 'release'));
    await writeFile(path.join(home, 'bin', 'java'), '#!/bin/sh\nprintf "%s\\n" "    java.version = 1.8.0_504" "    java.vendor = Amazon.com Inc." >&2\n');
    const detected = await currentJdk([], { JAVA_HOME: home });
    expect(detected?.version).toBe('1.8.0_504');
    expect(detected?.vendor).toBe('Amazon.com Inc.');
    expect(detected?.installation).toBeUndefined();
  });
});
