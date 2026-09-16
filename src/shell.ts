import { t } from './i18n.js';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Installation } from './types.js';

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell', 'cmd'] as const;
export type Shell = typeof SHELLS[number];
export type Changes = Record<string, string | undefined>;
export function shellName(value: string): Shell {
  if (!(SHELLS as readonly string[]).includes(value)) throw new Error(t("Supported shells: {0}", SHELLS.join(', ')));
  return value as Shell;
}
function environment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = process.platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase()) : name;
  return key ? env[key] : undefined;
}
export function activation(item: Installation, env: NodeJS.ProcessEnv = process.env, home = item.javaHome): Changes {
  const delimiter = item.platform === 'windows' ? ';' : ':';
  const bin = path.join(home, 'bin');
  const currentPath = environment(env, 'PATH') ?? '';
  const equal = (a: string, b: string) => item.platform === 'windows' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const parts = currentPath.split(delimiter).filter(p => !equal(p, env.NOVA_BIN ?? '\0') && !equal(p, bin));
  const changes: Changes = { JAVA_HOME: home, PATH: [bin, ...parts].join(delimiter), NOVA_BIN: bin, NOVA_ACTIVE: item.id };
  if (!env.NOVA_ACTIVE) {
    const original = environment(env, 'JAVA_HOME');
    changes.NOVA_ORIGINAL_JAVA_HOME_SET = original === undefined ? '0' : '1';
    changes.NOVA_ORIGINAL_JAVA_HOME = original ?? '';
  }
  return changes;
}
export function deactivation(env: NodeJS.ProcessEnv = process.env): Changes {
  if (!env.NOVA_ACTIVE) return {};
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const parts = (environment(env, 'PATH') ?? '').split(delimiter).filter(p => process.platform === 'win32' ? p.toLowerCase() !== env.NOVA_BIN?.toLowerCase() : p !== env.NOVA_BIN);
  return {
    PATH: parts.join(delimiter),
    JAVA_HOME: env.NOVA_ORIGINAL_JAVA_HOME_SET === '1' ? env.NOVA_ORIGINAL_JAVA_HOME ?? '' : undefined,
    NOVA_BIN: undefined, NOVA_ACTIVE: undefined, NOVA_ORIGINAL_JAVA_HOME: undefined, NOVA_ORIGINAL_JAVA_HOME_SET: undefined,
  };
}
function safeValue(value: string): void {
  if (/[\x00\r\n]/.test(value)) throw new Error(t("Shell environment values cannot contain NUL or newlines."));
}
export function quote(value: string, shell: Shell): string {
  safeValue(value);
  if (shell === 'powershell') {
    // Windows PowerShell 5.1 decodes the initial native pipeline using its
    // legacy console code page. Keep generated code ASCII even for Unicode paths.
    if (/[^\x20-\x7e]/.test(value)) return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`;
    return "'" + value.replaceAll("'", "''") + "'";
  }
  if (shell === 'fish') return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  if (shell === 'cmd') {
    if (value.includes('"')) throw new Error(t("CMD paths and environment values cannot contain double quotes."));
    return '"' + value.replaceAll('%', '%%') + '"';
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function render(changes: Changes, shell: Shell): string {
  const lines = Object.entries(changes).map(([name, value]) => {
    if (!/^[A-Z_]+$/.test(name)) throw new Error(t("Invalid environment variable name."));
    if (shell === 'powershell') return value === undefined ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue` : `$env:${name} = ${quote(value, shell)}`;
    if (shell === 'fish') {
      if (value === undefined) return `set -e ${name}`;
      const values = name === 'PATH' ? value.split(':') : [value];
      return `set -gx ${name} ${values.map(v => quote(v, shell)).join(' ')}`;
    }
    if (shell === 'cmd') return `@set ${quote(`${name}=${value ?? ''}`, shell)}`;
    return value === undefined ? `unset ${name}` : `export ${name}=${quote(value, shell)}`;
  });
  if (shell === 'bash' || shell === 'zsh') lines.push('hash -r 2>/dev/null || true');
  return lines.join(shell === 'cmd' ? '\r\n' : '\n') + '\n';
}
export function integration(shell: Exclude<Shell, 'cmd'>, node = process.execPath, cli = fileURLToPath(new URL('./cli.js', import.meta.url))): string {
  const run = `${quote(node, shell)} ${quote(cli, shell)}`;
  if (shell === 'powershell') return `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function global:nova {
  $novaIndex = 0
  while ($novaIndex -lt $args.Count) {
    if ($args[$novaIndex] -eq '--lang') { $novaIndex += 2 }
    elseif ($args[$novaIndex].StartsWith('--lang=')) { $novaIndex += 1 }
    else { break }
  }
  if ($novaIndex -lt $args.Count -and $args[$novaIndex] -in @('use', 'deactivate') -and $args -notcontains '--help' -and $args -notcontains '-h') {
    $novaCode = & ${run} __env powershell @args
    if ($LASTEXITCODE -ne 0) { return }
    if ($novaCode) { Invoke-Expression ($novaCode -join [Environment]::NewLine) }
  } else { & ${run} @args }
}
$env:NOVA_SHELL = 'powershell'
`;
  if (shell === 'fish') return `function nova
  set -l nova_index 1
  while test $nova_index -le (count $argv)
    switch $argv[$nova_index]
      case --lang
        set nova_index (math $nova_index + 2)
      case '--lang=*'
        set nova_index (math $nova_index + 1)
      case '*'
        break
    end
  end
  if test $nova_index -le (count $argv); and contains -- $argv[$nova_index] use deactivate; and not contains -- --help $argv; and not contains -- -h $argv
    set -l nova_code (${run} __env fish $argv)
    set -l nova_status $status
    if test $nova_status -ne 0
      return $nova_status
    end
    eval (string join ';' -- $nova_code)
  else
    ${run} $argv
  end
end
set -gx NOVA_SHELL fish
`;
  return `nova() {
  local nova_action='' nova_skip=0 nova_arg
  for nova_arg in "$@"; do
    if [ "$nova_skip" -eq 1 ]; then nova_skip=0; continue; fi
    case "$nova_arg" in
      --lang) nova_skip=1 ;;
      --lang=*) ;;
      *) nova_action="$nova_arg"; break ;;
    esac
  done
  case "$nova_action" in
    use|deactivate)
      case " $* " in *' --help '*|*' -h '*) ${run} "$@"; return $? ;; esac
      local nova_code nova_status
      nova_code=$(${run} __env ${shell} "$@")
      nova_status=$?
      [ "$nova_status" -eq 0 ] || return "$nova_status"
      eval "$nova_code"
      ;;
    *) ${run} "$@" ;;
  esac
}
export NOVA_SHELL=${shell}
`;
}
export function cmdStartup(root: string, startup: Changes, env: NodeJS.ProcessEnv = process.env): Changes {
  const directory = path.join(root, 'shell', 'cmd');
  const currentPath = startup.PATH ?? environment(env, 'PATH') ?? '';
  return { ...startup, NOVA_SHELL: 'cmd', PATH: [directory, ...currentPath.split(';').filter(p => p.toLowerCase() !== directory.toLowerCase())].join(';') };
}
export async function cmdIntegration(root: string, node = process.execPath, cli = fileURLToPath(new URL('./cli.js', import.meta.url))): Promise<string> {
  const directory = path.join(root, 'shell', 'cmd');
  await mkdir(directory, { recursive: true });
  const run = `${quote(node, 'cmd')} ${quote(cli, 'cmd')}`;
  const apply = (args: string) => `setlocal DisableDelayedExpansion
set "nova_script=%TEMP%\\nova-%RANDOM%-%RANDOM%.cmd"
${run} __cmd-env "%nova_script%" ${args}
if errorlevel 1 (endlocal & exit /b 1)
endlocal & set "NOVA_CMD_SCRIPT=%nova_script%"
call "%NOVA_CMD_SCRIPT%"
set "NOVA_CMD_STATUS=%errorlevel%"
del "%NOVA_CMD_SCRIPT%"
set "NOVA_CMD_SCRIPT="
set "NOVA_CMD_STATUS=" & exit /b %NOVA_CMD_STATUS%
`;
  const wrapper = `@echo off
if "!"=="" (
  echo ${t('nova requires CMD delayed expansion disabled. Start cmd /V:OFF.')} 1>&2
  exit /b 1
)
:dispatch
if /I "%~1"=="--lang" (
  shift
  shift
  goto dispatch
)
set "NOVA_CMD_ARG=%~1"
if "%NOVA_CMD_ARG:~0,7%"=="--lang=" (
  set "NOVA_CMD_ARG="
  shift
  goto dispatch
)
set "NOVA_CMD_ARG="
if /I "%~1"=="use" goto env
if /I "%~1"=="deactivate" goto env
if /I "%~1"=="__activate-default" goto startup
${run} %*
exit /b %errorlevel%
:env
if "%~2"=="--help" goto plain
if "%~2"=="-h" goto plain
${apply('%*')}
:startup
${apply('default')}
:plain
${run} %*
exit /b %errorlevel%
`;
  // CMD resolves npm's generated nova.cmd before it can affect the parent shell.
  // Put our batch wrapper first; it applies generated SET commands in that shell.
  const init = path.join(directory, 'init.cmd');
  // UTF-8 is also required for non-ASCII Node/CLI paths and SET values.
  await writeFile(path.join(directory, 'nova.cmd'), wrapper.replaceAll('\n', '\r\n'), 'utf8');
  await writeFile(init, '@echo off\r\nchcp 65001 >nul\r\ncall ' + quote(path.join(directory, 'nova.cmd'), 'cmd').replaceAll('%%', '%%%%') + ' __activate-default\r\n', 'utf8');
  return init;
}
