// Explicitly opt-in network test. All JDK downloads and configuration are isolated.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { hostTarget } from '../dist/types.js';
import { quote } from '../dist/shell.js';

const root = await mkdtemp(path.join(tmpdir(), 'nova-smoke-'));
const env = { ...process.env, NOVA_HOME: root };
for (const key of Object.keys(env)) if (key.startsWith('NOVA_') && key !== 'NOVA_HOME') delete env[key];
const cli = path.resolve('dist/cli.js');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 20 * 60_000, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
  return result.stdout;
}
try {
  const versions = (process.env.NOVA_SMOKE_VERSIONS || '21').split(',');
  const store = new Store(root);
  const target = hostTarget();
  for (const version of versions) {
    run(process.execPath, [cli, 'install', version]);
    const item = await store.resolve(version, target);
    run(process.execPath, [cli, 'install', item.version]);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    run(path.join(item.javaHome, 'bin', 'java' + suffix), ['-version']);
    run(path.join(item.javaHome, 'bin', 'javac' + suffix), ['-version']);
  }
  run(process.execPath, [cli, 'default', versions[0]]);
  const candidates = process.platform === 'win32' ? ['powershell', 'cmd'] : ['bash', 'zsh', 'fish', 'powershell'];
  for (const shell of candidates) {
    let binary = shell === 'powershell' ? 'pwsh' : shell === 'cmd' ? 'cmd.exe' : shell;
    if (shell === 'powershell' && process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).error) binary = 'powershell.exe';
    const probe = spawnSync(binary, shell === 'powershell' ? ['-NoProfile', '-Command', 'exit 0'] : shell === 'cmd' ? ['/c', 'exit 0'] : ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) continue;
    console.log(`Testing ${shell} with official JDKs`);
    const invoke = `${quote(process.execPath, shell)} ${quote(cli, shell)}`;
    const init = shell === 'powershell' ? `& ${invoke} init powershell | Out-String | Invoke-Expression`
      : shell === 'fish' ? `${invoke} init fish | source` : shell === 'cmd' ? '' : `eval "$(${invoke} init ${shell})"`;
    let startup = init;
    if (shell === 'cmd') {
      const initFile = run(process.execPath, [cli, 'init', 'cmd']).trim();
      startup = '@echo off\r\nchcp 65001 >nul\r\ncall ' + quote(initFile, 'cmd');
    }
    const commands = [startup];
    const checked = command => {
      commands.push(command);
      if (shell === 'powershell') commands.push('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
      else if (shell === 'cmd') commands.push('if errorlevel 1 exit /b 1');
      else if (shell === 'fish') commands.push('or exit $status');
    };
    for (const version of versions) {
      const prefix = shell === 'cmd' ? 'call ' : '';
      for (const command of [`${prefix}nova use ${version}`, `${prefix}nova doctor`, 'java -version', 'javac -version']) checked(command);
    }
    if (shell === 'bash' || shell === 'zsh') commands.unshift('set -e');
    checked((shell === 'cmd' ? 'call ' : '') + 'nova deactivate');
    const file = path.join(root, `smoke.${shell === 'powershell' ? 'ps1' : shell}`);
    await writeFile(file, commands.join(shell === 'cmd' ? '\r\n' : '\n'));
    run(binary, shell === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : shell === 'cmd' ? ['/d', '/v:off', '/c', file] : [file]);
  }
  console.log('Official Corretto smoke test passed.');
} finally {
  if (process.env.NOVA_SMOKE_KEEP === '1') console.log(`Kept smoke data: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
