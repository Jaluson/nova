import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { displayWidth, fit, pageSize, renderPage, type ListRow } from '../src/list-view.js';
import { atomicJson } from '../src/fs-utils.js';
import { MAJORS } from '../src/versions.js';
import { Store } from '../src/store.js';
import { artifact, cleanup, seed, target, temp } from './helpers.js';

afterEach(cleanup);
const rows: ListRow[] = Array.from({ length: 45 }, (_, index) => ({ version: `21.0.${45 - index}.1.1`, plain: `21.0.${45 - index}.1.1\tlinux/x64` }));
const cli = path.resolve('dist/cli.js');
function run(args: string[], root: string) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NOVA_HOME: root, JAVA_HOME: '', NOVA_ACTIVE: '' } });
}
async function remoteCache(): Promise<string> {
  const root = await temp();
  for (const major of MAJORS) {
    await atomicJson(path.join(root, 'cache', `corretto-${major}.json`), { schema: 1, fetchedAt: Date.now(),
      artifacts: rows.map((_, index) => artifact(`${major}.0.${45 - index}.1.1`)),
    });
  }
  return root;
}

describe('list pagination layout', () => {
  it('shows bounded pages, totals and navigation hints without dropping versions', () => {
    const first = renderPage(rows, { title: 'Corretto' }, {}, 1, 20, 79, false);
    const last = renderPage(rows, { title: 'Corretto' }, {}, 3, 20, 79, false);
    expect(first).toContain('1-20 / 45  |  Page 1/3');
    expect(first).not.toContain('21.0.25.1.1');
    expect(last).toContain('41-45 / 45  |  Page 3/3');
    expect(last).toContain('21.0.1.1.1');
    expect(() => renderPage(rows, { title: 'Corretto' }, {}, 4, 20, 79, false)).toThrow('out of range');
  });
  it('adapts to terminal height and keeps narrow Unicode paths within the screen', () => {
    expect(pageSize({}, 24)).toBe(16);
    expect(pageSize({}, 60)).toBe(20);
    expect(pageSize({ pageSize: 10 }, 60)).toBe(10);
    expect(pageSize({}, 5)).toBe(1);
    const data = [{ version: '21.0.9.1.1', status: 'current', detail: '/用户/项目/JDK/很长的目录', plain: '' }];
    const output = renderPage(data, { title: 'Installed JDKs', statuses: true }, { verbose: true }, 1, 1, 26, true);
    expect(output).toContain('current');
    expect(output.trimEnd().split('\n').every(line => displayWidth(line) <= 26)).toBe(true);
    expect(fit('中文目录', 5)).toBe('中文…');
    expect(fit('e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…');
    expect(fit('\x1b[31mred\x1b[0m\ntext', 30)).toBe('red text');
  });
  it('hides installation paths in compact mode and shows them with verbose', () => {
    const data = [{ version: '21.0.9.1.1', status: 'current, default', detail: '/opt/jdk21', plain: '' }];
    expect(renderPage(data, { title: 'JDKs', statuses: true }, {}, 1, 20, 100, false)).not.toContain('/opt/jdk21');
    expect(renderPage(data, { title: 'JDKs', statuses: true }, { verbose: true }, 1, 20, 100, false)).toContain('/opt/jdk21');
  });
});

describe('list CLI output modes', () => {
  it('preserves all plain remote rows for pipes and --all without ANSI or prompts', async () => {
    const root = await remoteCache();
    const plain = run(['ls-remote', '21'], root);
    const all = run(['ls-remote', '21', '--all'], root);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.trim().split('\n')).toHaveLength(45);
    expect(all.stdout).toBe(plain.stdout);
    expect(plain.stdout).not.toContain('\x1b');
    expect(plain.stdout).not.toContain('Page');
  });
  it('paginates remote results from all majors and supports an explicit major filter', async () => {
    const root = await remoteCache();
    const allMajors = run(['ls-remote', '--page', '2', '--page-size', '10'], root);
    expect(allMajors.status, allMajors.stderr).toBe(0);
    expect(allMajors.stdout).toContain('11-20 / 270  |  Page 2/27');
    const filtered = run(['ls-remote', '21', '--page', '3', '--page-size', '20'], root);
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stdout).toContain('41-45 / 45');
    expect(filtered.stdout).not.toContain('26.0.');
    expect(run(['ls-remote', '21', '--page', '99'], root).stderr).toContain('out of range');
  });
  it('shows platform and architecture beside remote versions in the terminal table', () => {
    const output = renderPage([{ version: '21.0.9.1.1', status: 'linux/x64', plain: '21.0.9.1.1\tlinux/x64' }],
      { title: 'Remote Corretto releases', statuses: true }, {}, 1, 20, 80, false);
    expect(output).toContain('VERSION');
    expect(output).toContain('STATUS');
    expect(output).toContain('linux/x64');
  });
  it('keeps a default local version on page one and supports full paths with --all', async () => {
    const store = new Store(await temp());
    for (const version of ['17.0.1.1.1', '21.0.1.1.1', '25.0.1.1.1']) await seed(store, version);
    const def = await store.setDefault('17', target);
    const page = run(['ls', '--page', '1', '--page-size', '1'], store.root);
    expect(page.status, page.stderr).toBe(0);
    expect(page.stdout).toContain('17.0.1.1.1  default');
    expect(page.stdout).not.toContain(def.javaHome);
    expect(run(['ls', '--all'], store.root).stdout).toContain(def.javaHome);
    expect(run(['ls', '--page', '1', '--verbose'], store.root).stdout).toContain('PATH');
  });
  it.each([
    ['ls', '--page', '0'], ['ls', '--page-size', '-1'], ['ls', '--page', '2x'],
    ['ls-remote', '--page', '1.5'], ['ls', '--all', '--page', '1'], ['ls-remote', '--all', '--page-size', '10'],
  ])('rejects invalid or conflicting flags: %j', async (...args) => {
    const result = run(args, await temp());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/positive integer|cannot be used/);
  });
});
