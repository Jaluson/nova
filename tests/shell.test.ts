import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activation, deactivation, integration, quote, render, type Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { cleanup, seed, target, temp } from './helpers.js';

afterEach(cleanup);
const cli = path.resolve('dist/cli.js');
const availability = (shell: string) => spawnSync(shell, ['pwsh', 'powershell.exe'].includes(shell) ? ['-NoProfile', '-Command', 'exit 0'] : ['--version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
const envFor = (root: string) => {
  const env = { ...process.env, NOVA_HOME: root, JAVA_HOME: 'original Java home', NOVA_PROBE: 'should-not-expand' };
  for (const key of Object.keys(env)) if (key.startsWith('NOVA_') && !['NOVA_HOME', 'NOVA_PROBE'].includes(key)) delete env[key as keyof typeof env];
  return env;
};
const shells: { name: Shell; binary: string; args: string[]; ext: string }[] = [
  { name: 'bash', binary: 'bash', args: ['--noprofile', '--norc'], ext: 'sh' },
  { name: 'zsh', binary: 'zsh', args: ['-f'], ext: 'zsh' },
  { name: 'fish', binary: 'fish', args: ['--no-config'], ext: 'fish' },
  { name: 'powershell', binary: process.platform === 'win32' && !availability('pwsh') ? 'powershell.exe' : 'pwsh', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'], ext: 'ps1' },
];

describe('environment generation', () => {
  it('preserves unrelated PATH edits across switches and deactivation', async () => {
    const store = new Store(await temp()); await seed(store, '21.0.9.11.1');
    const item = await store.resolve('21', target);
    const env = { PATH: ['/one', '/two'].join(path.delimiter), JAVA_HOME: '/original' };
    const first = activation(item, env);
    const switched = activation(item, { ...env, ...first, PATH: first.PATH + path.delimiter + '/added' });
    expect(switched.PATH?.split(path.delimiter).filter(p => p === first.NOVA_BIN)).toHaveLength(1);
    const restored = deactivation({ ...env, ...first, ...switched });
    expect(restored.PATH).toBe(['/one', '/two', '/added'].join(path.delimiter));
    expect(restored.JAVA_HOME).toBe('/original');
    expect(deactivation({})).toEqual({});
    const noOriginal = activation(item, { PATH: '/one' });
    expect(deactivation(noOriginal).JAVA_HOME).toBeUndefined();
  });
  it('quotes shell values and rejects multiline commands', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell', 'cmd'] as const) {
      expect(() => render({ JAVA_HOME: 'x\necho bad' }, shell)).toThrow();
      expect(() => render({ 'BAD;NAME': 'value' }, shell)).toThrow();
    }
    expect(render({ JAVA_HOME: 'C:\\hello %NOVA_PROBE% & 中文' }, 'cmd')).toContain('%%NOVA_PROBE%%');
    expect(quote("a'b", 'powershell')).toBe("'a''b'");
  });
});

for (const shell of shells) {
  describe.skipIf(!availability(shell.binary) || (process.platform === 'win32' && shell.name !== 'powershell'))(`${shell.name} integration`, () => {
    it('isolates sessions, applies defaults, uses .novarc, preserves errors and restores JAVA_HOME', async () => {
      const base = await temp();
      const root = path.join(base, "中文 space ' & %NOVA_PROBE% $ dollar");
      await mkdir(root);
      const store = new Store(root);
      await seed(store, '17.0.17.10.1'); await seed(store, '21.0.9.11.1');
      await store.setDefault('17', target);
      const env = envFor(root);
      const run = shell.name === 'powershell' ? `& ${quote(process.execPath, shell.name)} ${quote(cli, shell.name)}` : `${quote(process.execPath, shell.name)} ${quote(cli, shell.name)}`;
      const initialization = shell.name === 'powershell' ? `${run} init powershell | Out-String | Invoke-Expression`
        : shell.name === 'fish' ? `${run} init fish | source` : `eval "$(${run} init ${shell.name})"`;
      const log = shell.name === 'powershell' ? 'Write-Output $env:JAVA_HOME' : shell.name === 'fish' ? 'printf "%s\\n" "$JAVA_HOME"' : 'printf "%s\\n" "$JAVA_HOME"';
      const status = shell.name === 'powershell' ? 'Write-Output "status=$LASTEXITCODE"' : shell.name === 'fish' ? 'echo status=$status' : 'echo status=$?';
      const script = [initialization, 'nova current', 'nova --lang zh-CN use 21', 'nova current', initialization, 'nova current',
        'nova --lang=zh-CN use 99', status, 'nova current', 'nova pin 17', 'nova use', 'nova current', 'nova default 21', 'nova current',
        ...(process.platform === 'win32' ? [] : ['java -version', 'javac -version']), 'nova --lang en deactivate', log].join('\n');
      const file = path.join(base, `session.${shell.ext}`);
      await writeFile(file, script);
      const result = spawnSync(shell.binary, [...shell.args, file], { env, cwd: base, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('status=1');
      expect(result.stdout.trim().split(/\r?\n/).filter(line => /^\d/.test(line)), result.stderr + result.stdout).toEqual([
        '17.0.17.10.1', '21.0.9.11.1', '21.0.9.11.1', '21.0.9.11.1', '17.0.17.10.1', '17.0.17.10.1',
      ]);
      expect(result.stdout.trim().endsWith('original Java home')).toBe(true);
      expect(await readFile(path.join(base, '.novarc'), 'utf8')).toBe('17.0.17.10.1\n');
      if (process.platform !== 'win32') expect(result.stdout).toContain('javac 17.0.17.10.1');
      await writeFile(file, [initialization, 'nova current'].join('\n'));
      const next = spawnSync(shell.binary, [...shell.args, file], { env, cwd: base, encoding: 'utf8' });
      expect(next.status, next.stderr).toBe(0);
      expect(next.stdout.trim()).toBe('21.0.9.11.1');
    });
  });
}

describe.skipIf(process.platform !== 'win32')('CMD integration', () => {
  it('initializes a batch wrapper, supports project switching, escaping and restoration', async () => {
    const base = await temp();
    const root = path.join(base, '中文 space & %NOVA_PROBE%');
    const store = new Store(root);
    await seed(store, '17.0.17.10.1'); await seed(store, '21.0.9.11.1');
    await store.setDefault('17', target);
    const env = envFor(root);
    const initResult = spawnSync(process.execPath, [cli, 'init', 'cmd'], { env, encoding: 'utf8' });
    expect(initResult.status, initResult.stderr).toBe(0);
    const file = path.join(base, 'session.cmd');
    await writeFile(file, ['@echo off', 'chcp 65001 >nul', `call ${quote(initResult.stdout.trim(), 'cmd').replaceAll('%%', '%%%%')}`, 'call nova current', 'call nova --lang zh-CN use 21', 'echo activated=%errorlevel%', 'call nova current', 'call nova --lang=zh-CN use 99', 'echo status=%errorlevel%', 'call nova current', 'call nova pin 17', 'call nova use', 'call nova current', 'call nova default 21', 'call nova current', 'call nova --lang en deactivate', 'echo restored=%errorlevel%', 'echo %JAVA_HOME%'].join('\r\n'));
    const result = spawnSync('cmd.exe', ['/d', '/v:off', '/c', file], { env, cwd: base, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('status=1');
    expect(result.stdout).toContain('activated=0');
    expect(result.stdout).toContain('restored=0');
    expect(result.stdout.trim().split(/\r?\n/).filter(line => /^\d/.test(line)), result.stderr + result.stdout).toEqual(['17.0.17.10.1', '21.0.9.11.1', '21.0.9.11.1', '17.0.17.10.1', '17.0.17.10.1']);
    expect(result.stdout.trim().endsWith('original Java home')).toBe(true);
    // Reuse the original init file: it must read the new default at execution time.
    const nextInit = initResult;
    await writeFile(file, ['@echo off', 'chcp 65001 >nul', `call ${quote(nextInit.stdout.trim(), 'cmd').replaceAll('%%', '%%%%')}`, 'call nova current'].join('\r\n'));
    const next = spawnSync('cmd.exe', ['/d', '/v:off', '/c', file], { env, cwd: base, encoding: 'utf8' });
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout.trim()).toBe('21.0.9.11.1');
  });
});
