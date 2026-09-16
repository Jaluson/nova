import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getLanguage, languageFlag, parseLanguage, resolveLanguage, setLanguage, systemLanguage, t, zhCN } from '../src/i18n.js';
import { displayWidth, renderPage } from '../src/list-view.js';
import { readSettings, saveLanguage } from '../src/settings.js';
import { atomicJson } from '../src/fs-utils.js';
import { Store } from '../src/store.js';
import { artifact, cleanup, fakeHome, seed, target, temp } from './helpers.js';

afterEach(async () => { setLanguage('en'); await cleanup(); });
const cli = path.resolve('dist/cli.js');
function run(args: string[], root: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: {
    ...process.env, NOVA_HOME: root, JAVA_HOME: '', NOVA_ACTIVE: '', NOVA_LANG: '',
    LC_ALL: 'en_US.UTF-8', LC_MESSAGES: '', LANG: 'en_US.UTF-8', ...env,
  } });
}

describe('language resolution and catalogs', () => {
  it('supports canonical languages, common aliases and auto with strict explicit validation', () => {
    expect(parseLanguage('zh')).toBe('zh-CN');
    expect(parseLanguage('zh_CN')).toBe('zh-CN');
    expect(parseLanguage('en-US')).toBe('en');
    expect(parseLanguage('auto')).toBe('auto');
    expect(() => parseLanguage('fr')).toThrow('Unsupported language');
    expect(languageFlag(['ls', '--lang', 'zh', '--lang=en'])).toBe('en');
    expect(languageFlag(['--', '--lang=zh'])).toBeUndefined();
  });
  it('uses flag > NOVA_LANG > saved preference > system, and auto follows the system', () => {
    const env = { NOVA_LANG: 'en', LANG: 'zh_CN.UTF-8' };
    expect(resolveLanguage('zh-CN', 'en', env)).toBe('zh-CN');
    expect(resolveLanguage(undefined, 'zh-CN', env)).toBe('en');
    expect(resolveLanguage(undefined, 'en', { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLanguage(undefined, undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(resolveLanguage('auto', 'en', env)).toBe('zh-CN');
    expect(systemLanguage({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(systemLanguage({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-CN');
    expect(systemLanguage({}, 'zh-CN')).toBe('zh-CN');
    expect(systemLanguage({ LANG: 'fr_FR.UTF-8' })).toBe('en');
  });
  it('preserves all placeholders and inserts values literally in both languages', () => {
    const slots = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    for (const [english, chinese] of Object.entries(zhCN)) {
      expect(chinese.length, english).toBeGreaterThan(0);
      expect(slots(chinese), english).toEqual(slots(english));
    }
    setLanguage('zh-CN');
    expect(t('Invalid version: {0}', '$& {1}')).toBe('版本号无效：$& {1}');
    setLanguage('en');
    expect(t('Invalid version: {0}', 'bad')).toBe('Invalid version: bad');
  });
  it('renders Chinese pagination within a narrow terminal', () => {
    setLanguage('zh-CN');
    const rows = Array.from({ length: 3 }, (_, i) => ({ version: `21.0.${i}.1.1`, status: t('current'), plain: '' }));
    const view = renderPage(rows, { title: t('Installed JDKs'), statuses: true }, {}, 1, 2, 38, true);
    expect(view).toContain('版本'); expect(view).toContain('状态'); expect(view).toContain('第 1/2 页');
    expect(view).toContain('q：退出');
    expect(view.trimEnd().split('\n').every(line => displayWidth(line) <= 38)).toBe(true);
  });
});

describe('language command and configuration', () => {
  it('persists the preference across processes and preserves default JDK in both write directions', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    const item = await store.setDefault('21', target);
    const changed = run(['language', 'zh'], store.root);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout).toContain('已保存语言偏好：zh-CN');
    expect((await readSettings(store.root)).defaultId).toBe(item.id);
    expect(run(['language'], store.root).stdout).toContain('当前语言：zh-CN');
    expect(run(['default', '21'], store.root).stdout).toContain('默认版本');
    expect((await readSettings(store.root)).language).toBe('zh-CN');
    expect(run(['--lang', 'en', 'language'], store.root).stdout).toContain('Language: en (preference: zh-CN)');
    expect(run(['language'], store.root, { NOVA_LANG: 'en' }).stdout).toContain('Language: en');
    expect(run(['language', 'auto'], store.root, { LC_ALL: 'zh_CN.UTF-8' }).stdout).toContain('当前生效语言：zh-CN');
    expect(run(['language'], store.root).stdout).toContain('Language: en (preference: auto)');
  });
  it('preserves other settings and uses the existing write lock', async () => {
    const root = await temp();
    await atomicJson(path.join(root, 'config.json'), { custom: 'retained', defaultId: 'example' });
    await saveLanguage(root, 'zh-CN');
    expect(await readSettings(root)).toEqual({ custom: 'retained', defaultId: 'example', language: 'zh-CN' });
    await writeFile(path.join(root, '.write-lock'), 'busy');
    await expect(saveLanguage(root, 'en')).rejects.toThrow('Another nova write');
  });
  it('localizes root/subcommand help before parsing and does not write settings for temporary flags', async () => {
    const root = await temp();
    const help = run(['--lang', 'zh-CN', '--help'], root);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('用法：'); expect(help.stdout).toContain('命令：');
    expect(help.stdout).toContain('查看或保存语言偏好');
    const subHelp = run(['ls', '--help', '--lang=zh-CN'], root);
    expect(subHelp.stdout).toContain('显示命令帮助'); expect(subHelp.stdout).toContain('全局选项：');
    expect(run(['ls'], root, { LC_ALL: 'zh_CN.UTF-8' }).stdout).toContain('尚未安装');
    expect(run(['language'], root).stdout).toContain('preference: auto');
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    { args: ['install'], message: '缺少必需参数' },
    { args: ['ls', '--page'], message: '缺少参数值' },
    { args: ['ls', '--page', '0'], message: '请输入正整数' },
    { args: ['ls', '--all', '--page', '1'], message: '不能与' },
    { args: ['ls', '--nonsense'], message: '未知选项' },
    { args: ['nonsense'], message: '未知命令' },
    { args: ['ls', 'extra'], message: '参数过多' },
    { args: ['install', 'bad'], message: '版本号无效' },
    { args: ['language', 'fr'], message: '不支持的语言' },
  ])('localizes argument and domain errors: $args', async ({ args, message }) => {
    const result = run(['--lang', 'zh-CN', ...args], await temp());
    expect(result.status).not.toBe(0); expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('error:');
  });
  it('localizes local and remote lists without changing version strings, paths, or command names', async () => {
    const root = await temp();
    const home = path.join(await temp(), 'Java Home');
    await fakeHome(home, artifact());
    const listed = run(['ls', '--all', '--lang', 'zh-CN'], root, { JAVA_HOME: home });
    expect(listed.stdout).toContain('当前  外部'); expect(listed.stdout).toContain(home);
    expect(run(['current', '--lang', 'zh-CN'], root, { JAVA_HOME: home }).stdout.trim()).toBe('21.0.9');
    await atomicJson(path.join(root, 'cache', 'corretto-21.json'), { schema: 1, fetchedAt: Date.now(), artifacts: [artifact()] });
    const remote = run(['ls-remote', '21', '--page', '1', '--lang', 'zh-CN'], root);
    expect(remote.status, remote.stderr).toBe(0);
    expect(remote.stdout).toContain('版本'); expect(remote.stdout).toContain('第 1/1 页');
    expect(remote.stdout).toContain('21.0.9.11.1');
  });
  it('keeps initialization and environment output executable under Chinese locale', async () => {
    const store = new Store(await temp());
    await seed(store, '21.0.9.11.1');
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const env = run(['__env', shell, '--lang', 'zh-CN', 'use', '21'], store.root);
      expect(env.status, env.stderr).toBe(0);
      expect(env.stdout).toContain('JAVA_HOME');
      expect(env.stdout).not.toContain('当前');
      const init = run(['init', shell, '--lang', 'zh-CN'], store.root);
      expect(init.status, init.stderr).toBe(0);
      expect(init.stdout).toContain('NOVA_SHELL');
    }
  });
});
