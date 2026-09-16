#!/usr/bin/env node
import { getLanguage, languageFlag, parseLanguage, resolveLanguage, setLanguage, systemLanguage, t } from './i18n.js';
import { Command, InvalidArgumentError, Option } from 'commander';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import path from 'node:path';
import { stableHome, Store, pinVersion, projectVersion } from './store.js';
import { CorrettoProvider } from './provider.js';
import { MAJORS, compareVersions, majorOf, normalizeVersion } from './versions.js';
import { hostTarget, sameTarget, type Installation } from './types.js';
import { activation, cmdIntegration, cmdStartup, deactivation, integration, render, shellName, type Changes } from './shell.js';
import { cancellation } from './network.js';
import { currentJdk, type CurrentJdk } from './current.js';
import { displayList, type ListOptions, type ListRow } from './list-view.js';
import { readSettings, saveLanguage } from './settings.js';
import { localizeCommander } from './command-i18n.js';
import { latestVersion, updatePackage } from './update.js';

const store = new Store();
const requestedLanguage = languageFlag(process.argv.slice(2));
setLanguage(systemLanguage());
try {
  // Establish the environment/flag locale before reporting configuration errors.
  setLanguage(resolveLanguage(requestedLanguage, undefined));
  setLanguage(resolveLanguage(requestedLanguage, (await readSettings(store.root)).language));
} catch (error) {
  console.error(t('nova: {0}', error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
const provider = new CorrettoProvider(store.root);
const program = new Command();
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
program.name('nova').description(t("Manage Amazon Corretto portable JDKs"))
  .version(pkg.version, '-V, --version', t('output the version number'))
  .option('--lang <language>', t('Language for this command: en, zh-CN, or auto'), parseLanguage)
  .showHelpAfterError();
program.addHelpText('after', `\n${t('Quick start:')}\n  ${t('nova init <shell>')}     ${t('Load shell integration (run once per terminal)')}\n  ${t('nova ls-remote 21')}     ${t('List available Corretto JDK 21 releases')}\n  ${t('nova install 21')}       ${t('Download and install the newest JDK 21')}\n  ${t('nova use 21')}           ${t('Switch this terminal to JDK 21')}\n  ${t('nova current')}          ${t('Show the JDK selected by JAVA_HOME')}\n\n${t('Tips:')}\n  ${t('Run nova <command> --help for command-specific options.')}\n  ${t('nova use changes the stable JAVA_HOME link; nova deactivate restores the previous JAVA_HOME.')}\n`);
localizeCommander(program);

program.command('language [language]').description(t('Show or save language preference (en, zh-CN, auto)'))
  .action(async (value?: string) => {
    if (value === undefined) {
      console.log(t('Language: {0} (preference: {1})', getLanguage(), (await readSettings(store.root)).language ?? 'auto'));
      return;
    }
    const preference = parseLanguage(value);
    await saveLanguage(store.root, preference);
    setLanguage(resolveLanguage(requestedLanguage, preference));
    console.log(t('Language preference saved: {0}. Effective language: {1}.', preference, getLanguage()));
  });

program.command('jdk-dir [directory]').description(t('Show or move the directory used for downloaded JDKs'))
  .option('--dry-run', t('Show the destination without moving files'))
  .action(async (directory?: string, options: { dryRun?: boolean } = {}) => {
    if (directory === undefined) { console.log(await store.jdkDirectory()); return; }
    if (options.dryRun) { console.log(t('Would move JDKs to: {0}', path.resolve(directory))); return; }
    const moved = await store.relocateJdks(directory);
    console.log(t('JDK directory: {0}', moved));
  });
program.command('config [key] [value]').description(t('Show or update nova configuration'))
  .action(async (key?: string, value?: string) => {
    const settings = await readSettings(store.root);
    if (key === undefined) { console.log(JSON.stringify({ ...settings, jdkDir: await store.jdkDirectory() }, null, 2)); return; }
    if (key === 'language') {
      if (value === undefined) { console.log(settings.language ?? 'auto'); return; }
      const preference = parseLanguage(value); await saveLanguage(store.root, preference); setLanguage(resolveLanguage(requestedLanguage, preference)); console.log(t('Language preference saved: {0}. Effective language: {1}.', preference, getLanguage())); return;
    }
    if (key === 'jdk-dir') {
      if (value === undefined) { console.log(await store.jdkDirectory()); return; }
      console.log(t('JDK directory: {0}', await store.relocateJdks(value))); return;
    }
    throw new Error(t('Unknown configuration key: {0}. Use language or jdk-dir.', key));
  });
program.command('alias [name] [version]').description(t('Show or set a version alias'))
  .action(async (name?: string, version?: string) => {
    const settings = await readSettings(store.root);
    if (name === undefined) { console.log(JSON.stringify(settings.aliases ?? {}, null, 2)); return; }
    if (version === undefined) { console.log(settings.aliases?.[name] ?? t('Alias is not set: {0}', name)); return; }
    const item = await store.resolve(version, hostTarget());
    const aliases = { ...(settings.aliases ?? {}), [name]: item.version };
    const { atomicJson, withLock } = await import('./fs-utils.js');
    await withLock(store.root, async () => atomicJson(path.join(store.root, 'config.json'), { ...await readSettings(store.root), aliases }));
    console.log(t('Alias {0}: {1}', name, item.version));
  });
program.command('update').description(t('Check for and install the latest nova version'))
  .option('--check', t('Only check whether an update is available'))
  .option('--dry-run', t('Show the update without installing it'))
  .action(async (options: { check?: boolean; dryRun?: boolean }) => {
    const info = await latestVersion(pkg.version);
    if (!info.updateAvailable) { console.log(t('nova is already up to date ({0}).', info.current)); return; }
    console.log(t('New nova version available: {0} (current {1}).', info.latest, info.current));
    if (options.check || options.dryRun) return;
    console.log(t('Updating nova globally...'));
    await updatePackage();
    console.log(t('nova updated to {0}.', info.latest));
  });

async function active(): Promise<Installation> {
  const item = (await store.list(hostTarget())).find(i => i.id === process.env.NOVA_ACTIVE);
  if (!item) throw new Error(t("No nova JDK active in this terminal. Initialize your shell and run nova use <version>."));
  await store.check(item);
  const configured = process.env.JAVA_HOME;
  const stable = stableHome(store.root, hostTarget());
  if (configured !== item.javaHome && configured !== stable) throw new Error(t("JAVA_HOME was changed outside nova. Run nova use <version> to restore it."));
  return item;
}
async function envChanges(action: string, version?: string): Promise<Changes> {
  if (action === 'deactivate') {
    if (version) throw new Error(t("deactivate takes no version."));
    return deactivation();
  }
  if (action === 'default') {
    if (version) throw new Error(t("Internal default initialization takes no version."));
    if (process.env.NOVA_ACTIVE) return {};
    const selected = await store.defaultInstallation(hostTarget());
    return selected ? activation(selected, process.env, await store.activate(selected, hostTarget())) : {};
  }
  if (action !== 'use') throw new Error(t("Unknown environment action: {0}", action));
  const target = hostTarget();
  const selected = await store.resolve(version ?? await projectVersion(), target);
  return activation(selected, process.env, await store.activate(selected, target));
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError(t("Expected a positive integer."));
  return Number(value);
}
function listOptions(command: Command): Command {
  return command
    .addOption(new Option('--all', t("Print the full list without paging")).conflicts(['page', 'pageSize']))
    .option('--page <number>', t("Print one page without interactive browsing"), positiveInteger)
    .option('--page-size <number>', t("Versions per page (default: 20, limited by terminal height)"), positiveInteger)
    .option('--json', t('Output JSON for scripts and automation'));
}
function platformOption(value: string): 'linux' | 'macos' | 'windows' {
  if (!['linux', 'macos', 'windows'].includes(value)) throw new InvalidArgumentError(t('Expected platform: linux, macos, or windows.'));
  return value as 'linux' | 'macos' | 'windows';
}
function archOption(value: string): 'x64' | 'aarch64' {
  if (!['x64', 'aarch64'].includes(value)) throw new InvalidArgumentError(t('Expected architecture: x64 or aarch64.'));
  return value as 'x64' | 'aarch64';
}

listOptions(program.command('ls-remote [major]').description(t("Browse verified remote versions for this platform")))
  .option('--refresh', t("Refresh the release cache"))
  .option('--platform <platform>', t('Filter by platform: linux, macos, or windows'), platformOption)
  .option('--arch <architecture>', t('Filter by architecture: x64 or aarch64'), archOption)
  .option('--latest', t('Show only the newest release for each major version'))
  .action(async (major: string | undefined, options: ListOptions & { refresh?: boolean; platform?: 'linux' | 'macos' | 'windows'; arch?: 'x64' | 'aarch64'; latest?: boolean }) => {
    if (major && normalizeVersion(major).includes('.')) throw new Error(t("ls-remote accepts a major version, for example 21."));
    const majors = major ? [majorOf(major)] : [...MAJORS];
    const host = hostTarget();
    const target = { platform: options.platform ?? host.platform, arch: options.arch ?? host.arch };
    const results = await Promise.allSettled(majors.map(value => provider.list(value, options.refresh)));
    const artifacts = results.flatMap((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(t("Corretto {0}: {1}", majors[i], String(result.reason))); process.exitCode = 1; return [];
    }).filter(a => sameTarget(a, target)).sort((a, b) => compareVersions(b.version, a.version));
    const visible = options.latest ? artifacts.filter((artifact, index, all) => index === all.findIndex(other => majorOf(other.version) === majorOf(artifact.version))) : artifacts;
    const latestByMajor = new Set(artifacts.filter((a, i, all) => i === all.findIndex(b => majorOf(b.version) === majorOf(a.version))).map(a => a.version));
    if (visible.length) await displayList(visible.map(artifact => ({
      version: artifact.version,
      status: `${artifact.platform}/${artifact.arch}${latestByMajor.has(artifact.version) ? ` · ${t('latest')}` : ''}`,
      plain: `${artifact.version}\t${artifact.platform}/${artifact.arch}`,
    })), { title: `${t('Remote Corretto releases')}${major ? ` ${major}` : ''}`, statuses: true }, { ...options, jsonData: options.json ? { schema: 1, command: 'ls-remote', platform: target.platform, arch: target.arch, items: visible.map(a => ({ version: a.version, platform: a.platform, arch: a.arch, latest: latestByMajor.has(a.version) })) } : undefined });
    if (!visible.length && !process.exitCode) console.log(t("No verified portable JDKs available for this platform."));
  });
program.command('install <version>').description(t("Install a major’s latest patch or an exact Corretto version"))
  .option('--dry-run', t('Show what would be installed without changing anything'))
  .action(async (version: string, options: { dryRun?: boolean }) => {
    const target = hostTarget();
    const normalized = normalizeVersion(version);
    const local = normalized.includes('.') ? (await store.list(target)).find(i => i.version === normalized) : undefined;
    if (local) { await store.check(local); console.log(t("Already installed: {0}", local.version)); return; }
    const artifact = await provider.resolve(version, target);
    if (options.dryRun) { console.log(t('Would install Corretto {0} ({1}/{2}).', artifact.version, artifact.platform, artifact.arch)); return; }
    console.error(t("Installing Corretto {0} ({1}/{2})", artifact.version, artifact.platform, artifact.arch));
    let lastProgress = 0;
    const installed = await store.install(artifact, undefined, (bytes, total) => {
      if (!process.stderr.isTTY || Date.now() - lastProgress < 1000) return;
      lastProgress = Date.now();
      process.stderr.write(t("\rDownloaded {0} MiB{1}", (bytes / 1048576).toFixed(1), total ? ` / ${(total / 1048576).toFixed(1)} MiB` : ''));
    });
    if (lastProgress) process.stderr.write('\n');
    console.log(t("Installed Corretto {0}\nRun nova use {1} to activate it.", installed.version, installed.version));
  });
listOptions(program.command('ls').description(t("Browse managed JDKs and the current JAVA_HOME JDK")))
  .option('--verbose', t("Include installation paths in the terminal view"))
  .action(async (options: ListOptions) => {
  const target = hostTarget();
  const installed = (await store.list(target)).sort((a, b) => compareVersions(b.version, a.version));
  let defaultId: string | undefined;
  try { defaultId = (await store.defaultInstallation(target))?.id; } catch (error) { console.error(String(error)); }
  let current: CurrentJdk | undefined;
  try { current = await currentJdk(installed); } catch (error) { console.error(t("Warning: {0}", error instanceof Error ? error.message : String(error))); }
  const rows: ListRow[] = installed.map(item => {
    const isCurrent = item.id === current?.installation?.id;
    const isDefault = item.id === defaultId;
    return { version: item.version, status: [isCurrent ? t('current') : '', isDefault ? t('default') : ''].filter(Boolean).join(', '),
      detail: item.javaHome, priority: isCurrent ? 2 : isDefault ? 1 : 0,
      plain: `${item.version}${isCurrent ? '  ' + t('current') : ''}${isDefault ? '  ' + t('default') : ''}\t${item.javaHome}` };
  });
  if (current && !current.installation) rows.push({ version: current.version, status: `${t('current')}, ${t('external')} (${current.vendor})`, detail: current.javaHome, priority: 2,
    plain: `${current.version}  ${t('current')}  ${t('external')} (${current.vendor})\t${current.javaHome}` });
  if (rows.length) await displayList(rows, { title: t('Installed JDKs'), statuses: true }, { ...options, jsonData: options.json ? { schema: 1, command: 'ls', items: rows.map(r => ({ version: r.version, status: r.status ?? '', path: r.detail ?? '', current: r.status?.includes(t('current')) ?? false, default: r.status?.includes(t('default')) ?? false, external: r.status?.includes(t('external')) ?? false })) } : undefined });
  if (!installed.length && !current) console.log(t("No nova-managed JDKs installed. Run nova install 21."));
});
program.command('use [version]').description(t("Activate an installed JDK in this terminal; defaults to .novarc"))
  .action(() => { throw new Error(t("Shell integration required. Run nova init <bash|zsh|fish|powershell|cmd> and follow the README setup instructions.")); });
program.command('deactivate').description(t("Restore this terminal’s previous Java environment"))
  .action(() => { throw new Error(t("Shell integration required. See nova init --help and the README.")); });
program.command('default <version>').description(t("Set the JDK for newly initialized terminals")).action(async (version: string) => {
  const item = await store.setDefault(version, hostTarget());
  console.log(t("Default: Corretto {0}", item.version));
});
program.command('current').description(t("Print the JAVA_HOME JDK version, including external JDKs")).action(async () => {
  const current = await currentJdk(await store.list(hostTarget()));
  if (!current) throw new Error(t("JAVA_HOME is not set. Configure it or run nova use <version>."));
  console.log(current.version);
});
program.command('pin [version]').description(t("Write an exact installed version to .novarc in the current directory")).action(async (version?: string) => {
  const selected = version ? await store.resolve(version, hostTarget()) : await active();
  await pinVersion(selected.version);
  console.log(t("Pinned Corretto {0} in {1}", selected.version, path.join(process.cwd(), '.novarc')));
});
program.command('uninstall <exact-version>').description(t("Remove an installed JDK (except current/default)"))
  .option('--yes', t('Skip the confirmation prompt'))
  .action(async (version: string, options: { yes?: boolean }) => {
  if (!options.yes && process.stdin.isTTY) {
    const answer = await new Promise<string>(resolve => { const rl = createInterface({ input: process.stdin, output: process.stderr }); rl.question(t('Uninstall Corretto {0}? [y/N] ', version), value => { rl.close(); resolve(value); }); });
    if (!/^y(?:es)?$/i.test(answer.trim())) { console.log(t('Cancelled.')); return; }
  }
  await store.uninstall(version, hostTarget(), process.env.NOVA_ACTIVE);
  console.log(t("Uninstalled Corretto {0}", normalizeVersion(version)));
});
program.command('init <shell>').description(t("Emit Shell initialization code (CMD: emit an initialization script path)"))
  .addHelpText('after', '\nBash/Zsh: eval "$(nova init bash)"\nFish: nova init fish | source\nPowerShell: nova init powershell | Out-String | Invoke-Expression\nCMD: for /f "delims=" %i in (\'nova init cmd\') do "%i"\n' + t('Use the matching shell name; add initialization to your shell profile for new terminals.'))
  .action(async (value: string) => {
    const shell = shellName(value);
    if (shell === 'cmd' && process.platform !== 'win32') throw new Error(t("CMD initialization is only available on Windows."));
    if (shell === 'cmd') { console.log(await cmdIntegration(store.root)); return; }
    let startup: Changes = {};
    try { startup = await envChanges('default'); } catch (error) { console.error(t("Warning: {0}", String(error))); }
    process.stdout.write(integration(shell) + render(startup, shell));
  });
program.command('doctor').description(t("Check Shell integration and Java environment")).action(async () => {
  let failures = 0;
  const report = (ok: boolean, message: string) => { console.log(t("{0}  {1}", ok ? t('OK') : t('FAIL'), message)); if (!ok) failures++; };
  report(Boolean(process.env.NOVA_SHELL), t("Shell integration: {0}", process.env.NOVA_SHELL ?? t('not initialized')));
  console.log(t("NOVA_HOME: {0}", store.root));
  try { await stat(stableHome(store.root, hostTarget())); report(true, t('Stable JAVA_HOME link exists')); }
  catch { report(false, t('Stable JAVA_HOME link is missing')); }
  try {
    const list = await store.list(hostTarget());
    for (const item of list) { try { await store.check(item); report(true, t("Installed {0}", item.version)); } catch (error) { report(false, String(error)); } }
    const def = await store.defaultInstallation(hostTarget());
    console.log(t("Default: {0}", def?.version ?? t('not set')));
  } catch (error) { report(false, String(error)); }
  try {
    const item = await active();
    report(true, t("JAVA_HOME: {0}", item.javaHome));
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    let found: string | undefined;
    for (const entry of pathValue.split(path.delimiter)) {
      const candidate = path.resolve(entry || '.', executable);
      try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); found = candidate; break; } catch { /* Try the next PATH entry. */ }
    }
    const expected = path.join(stableHome(store.root, hostTarget()), 'bin', executable);
    report(process.platform === 'win32' ? found?.toLowerCase() === expected.toLowerCase() : found === expected, t("PATH java: {0}", found ?? t('not found')));
  } catch (error) { report(false, String(error)); }
  if (failures) process.exitCode = 1;
});

program.command('__env <shell> <action> [version]', { hidden: true }).action(async (shell: string, action: string, version?: string) => {
  const parsedShell = shellName(shell);
  process.stdout.write(render(await envChanges(action, version), parsedShell));
});
program.command('__cmd-env <file> <action> [version]', { hidden: true }).action(async (file: string, action: string, version?: string) => {
  let changes: Changes;
  try { changes = await envChanges(action, version); }
  catch (error) { if (action !== 'default') throw error; console.error(t("Warning: {0}", String(error))); changes = {}; }
  const code = render(action === 'default' ? cmdStartup(store.root, changes) : changes, 'cmd');
  await writeFile(file, '@echo off\r\n' + code + '\r\nexit /b 0\r\n', { flag: 'wx', encoding: 'utf8', mode: 0o600 });
});

process.once('SIGINT', () => cancellation.abort(new Error(t("Interrupted"))));
process.once('SIGTERM', () => cancellation.abort(new Error(t("Terminated"))));
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); throw error; });
try { await program.parseAsync(); }
catch (error) {
  console.error(t("nova: {0}", error instanceof Error ? error.message : String(error)));
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
