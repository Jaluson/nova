import { t } from './i18n.js';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractArchive, findJavaHome, validateRelease } from './archive.js';
import { atomicJson, isMissing, readJson, withLock } from './fs-utils.js';
import { cancellation, fetchDownload } from './network.js';
import { normalizeVersion, selectVersion } from './versions.js';
import { isInstallation, sameTarget, type Artifact, type Installation, type Target } from './types.js';
import { readSettings } from './settings.js';

export function novaRoot(): string {
  return path.resolve(process.env.NOVA_HOME || path.join(homedir(), '.nova'));
}
export function installationId(artifact: Artifact): string {
  return `corretto-${normalizeVersion(artifact.version)}-${artifact.platform}-${artifact.arch}`;
}
export function stableHome(root: string, target: Target): string {
  return path.join(root, 'current', `${target.platform}-${target.arch}`);
}
function within(root: string, child: string): boolean {
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const childKey = process.platform === 'win32' ? child.toLowerCase() : child;
  return childKey === rootKey || childKey.startsWith(rootKey + path.sep);
}
export class Store {
  constructor(readonly root: string = novaRoot()) {}
  async jdkDirectory(): Promise<string> {
    const configured = (await readSettings(this.root)).jdkDir;
    return configured ? path.resolve(configured) : path.join(this.root, 'jdks');
  }
  async list(target?: Target, report: (message: string) => void = () => {}): Promise<Installation[]> {
    const directory = await this.jdkDirectory();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const installs: Installation[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let record: Installation | undefined;
      try { record = await readJson<Installation>(path.join(directory, entry.name, 'nova.json')); }
      catch (error) { report(t("Cannot read installation record {0}: {1}", entry.name, String(error))); continue; }
      if (!record) continue;
      const installRoot = path.join(directory, entry.name);
      const resolvedHome = path.resolve(record.javaHome);
      if (!isInstallation(record) || record.id !== entry.name || installationId(record) !== entry.name || !within(installRoot, resolvedHome)) {
        report(t("Invalid installation record: {0}", entry.name)); continue;
      }
      if (!target || sameTarget(record, target)) installs.push(record);
    }
    return installs;
  }
  async resolve(selector: string, target: Target): Promise<Installation> {
    const aliases = (await readSettings(this.root)).aliases ?? {};
    const resolvedSelector = aliases[selector] ?? selector;
    const result = selectVersion(await this.list(target), resolvedSelector);
    if (!result) throw new Error(t("Corretto {0} is not installed. Run nova install {1}.", selector, resolvedSelector));
    await this.check(result);
    return result;
  }
  /** Point the stable JAVA_HOME entry at an installed JDK. */
  async activate(installation: Installation, target: Target): Promise<string> {
    return withLock(this.root, async () => {
      const link = stableHome(this.root, target);
      await mkdir(path.dirname(link), { recursive: true });
      await rm(link, { recursive: true, force: true });
      await symlink(installation.javaHome, link, process.platform === 'win32' ? 'junction' : 'dir');
      return link;
    });
  }
  async relocateJdks(directory: string): Promise<string> {
    const destination = path.resolve(directory);
    return withLock(this.root, async () => {
      const source = await this.jdkDirectory();
      if (path.resolve(source) === destination) return destination;
      try {
        const entries = await readdir(destination);
        if (entries.length) throw new Error(t("JDK directory is not empty: {0}", destination));
      } catch (error) { if (!isMissing(error)) throw error; }
      const records: Array<{ record: Installation; relativeHome: string; file: string; original: string }> = [];
      try {
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const file = path.join(source, entry.name, 'nova.json');
          const original = await readFile(file, 'utf8');
          const record = JSON.parse(original) as unknown;
          if (!isInstallation(record) || record.id !== entry.name || installationId(record) !== entry.name || !within(path.join(source, entry.name), path.resolve(record.javaHome))) throw new Error(t("Invalid installation record: {0}", entry.name));
          records.push({ record, relativeHome: path.relative(source, record.javaHome), file, original });
        }
      } catch (error) { if (!isMissing(error)) throw error; }
      await mkdir(path.dirname(destination), { recursive: true });
      let moved = false;
      try { await rename(source, destination); moved = true; } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(destination, { recursive: true });
      }
      const configFile = path.join(this.root, 'config.json');
      let originalConfig: string | undefined;
      try { originalConfig = await readFile(configFile, 'utf8'); } catch (error) { if (!isMissing(error)) throw error; }
      const oldLinks: Array<{ link: string; target?: string }> = [];
      for (const { record } of records) {
        const link = stableHome(this.root, record);
        try { oldLinks.push({ link, target: await readlink(link) }); } catch (error) { if (!isMissing(error)) throw error; oldLinks.push({ link }); }
      }
      try {
        for (const { record, relativeHome } of records) await atomicJson(path.join(destination, record.id, 'nova.json'), { ...record, javaHome: path.join(destination, relativeHome) });
        const settings = await readSettings(this.root);
        const next = { ...settings };
        if (destination === path.join(this.root, 'jdks')) delete next.jdkDir;
        else next.jdkDir = destination;
        await atomicJson(configFile, next);
        for (const { record, relativeHome } of records) {
          const link = stableHome(this.root, record);
          await rm(link, { recursive: true, force: true });
          await symlink(path.join(destination, relativeHome), link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return destination;
      } catch (error) {
        if (moved) {
          await rename(destination, source).catch(() => {});
          for (const item of records) await atomicJson(item.file, JSON.parse(item.original));
        }
        if (originalConfig === undefined) await rm(configFile, { force: true });
        else await writeFile(configFile, originalConfig, 'utf8');
        for (const { link, target } of oldLinks) {
          await rm(link, { recursive: true, force: true });
          if (target) await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        throw error;
      }
    });
  }
  async check(installation: Installation): Promise<void> {
    const suffix = installation.platform === 'windows' ? '.exe' : '';
    try {
      const root = await realpath(path.join(await this.jdkDirectory(), installation.id));
      const home = await realpath(installation.javaHome);
      if (!within(root, home)) throw new Error(t('JDK executable escapes installation directory.'));
    } catch (error) {
      if (!isMissing(error)) throw new Error(t("Installation {0} is incomplete. Reinstall it.", installation.version));
    }
    for (const name of ['java', 'javac']) {
      try { if (!(await stat(path.join(installation.javaHome, 'bin', name + suffix))).isFile()) throw new Error(t("Not a file")); }
      catch { throw new Error(t("Installation {0} is incomplete. Reinstall it.", installation.version)); }
    }
  }
  async defaultInstallation(target: Target): Promise<Installation | undefined> {
    const config = await readJson<{ defaultId?: string }>(path.join(this.root, 'config.json'));
    if (!config?.defaultId) return undefined;
    const result = (await this.list(target)).find(i => i.id === config.defaultId);
    if (!result) throw new Error(t("Default JDK is missing or incompatible. Run nova default <installed-version>."));
    await this.check(result);
    return result;
  }
  async setDefault(selector: string, target: Target): Promise<Installation> {
    return withLock(this.root, async () => {
      const installation = await this.resolve(selector, target);
      await atomicJson(path.join(this.root, 'config.json'), { ...await readSettings(this.root), defaultId: installation.id });
      return installation;
    });
  }
  async install(artifact: Artifact, download: (url: string) => Promise<Response> = fetchDownload, progress: (bytes: number, total: number) => void = () => {}): Promise<Installation> {
    return withLock(this.root, async () => {
      const id = installationId(artifact);
      const existing = (await this.list()).find(i => i.id === id);
      if (existing) { await this.check(existing); return existing; }
      const tmpRoot = path.join(this.root, 'tmp');
      await mkdir(tmpRoot, { recursive: true });
      const temporary = await mkdtemp(path.join(tmpRoot, 'install-'));
      try {
        const archive = path.join(temporary, `jdk.${artifact.format}`);
        const response = await download(artifact.url);
        if (!response.ok || !response.body) throw new Error(t("Download failed: HTTP {0}", response.status));
        const hash = createHash('sha256');
        let bytes = 0;
        const total = Number(response.headers.get('content-length') ?? 0);
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk); bytes += chunk.length; progress(bytes, total); callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: cancellation.signal });
        if (hash.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error(t("SHA-256 mismatch. Installation cancelled."));
        cancellation.signal.throwIfAborted();
        const payload = path.join(temporary, 'payload');
        await extractArchive(archive, payload, artifact.format);
        const javaHome = await findJavaHome(payload, artifact.platform);
        await validateRelease(javaHome, artifact);
      const destination = path.join(await this.jdkDirectory(), id);
        const installed: Installation = { ...artifact, id, javaHome: path.join(destination, path.relative(payload, javaHome)), installedAt: new Date().toISOString() };
        await atomicJson(path.join(payload, 'nova.json'), installed);
        await mkdir(path.dirname(destination), { recursive: true });
        cancellation.signal.throwIfAborted();
        await rename(payload, destination);
        return installed;
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  async uninstall(selector: string, target: Target, activeId?: string): Promise<void> {
    if (!normalizeVersion(selector).includes('.')) throw new Error(t("uninstall requires an exact version from nova ls."));
    await withLock(this.root, async () => {
      // Do not require intact binaries: broken installations must be removable.
      const item = selectVersion(await this.list(target), selector);
      if (!item) throw new Error(t("Corretto {0} is not installed.", selector));
      const config = await readJson<{ defaultId?: string }>(path.join(this.root, 'config.json'));
      if (config?.defaultId === item.id) throw new Error(t("Cannot uninstall the default JDK. Select another default first."));
      if (activeId === item.id) throw new Error(t("Cannot uninstall the current JDK. Run nova deactivate or nova use first."));
      await rm(path.join(await this.jdkDirectory(), item.id), { recursive: true });
    });
  }
}
export async function projectVersion(start = process.cwd()): Promise<string> {
  let directory = path.resolve(start);
  for (;;) {
    let selected: string | undefined;
    for (const name of ['.novarc', '.nova-version', '.java-version']) {
      try { await stat(path.join(directory, name)); selected = path.join(directory, name); break; } catch (error) { if (!isMissing(error)) throw error; }
    }
    selected ??= path.join(directory, '.novarc');
    try {
      const content = (await readFile(selected, 'utf8')).trim();
      const version = normalizeVersion(content);
      if (!version.includes('.')) throw new Error(t(".novarc must contain one exact Corretto version."));
      return version;
    } catch (error) { if (!isMissing(error)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(t("No .novarc found. Specify a version or run nova pin <version>."));
    directory = parent;
  }
}
export async function pinVersion(version: string, directory = process.cwd()): Promise<void> {
  await writeFile(path.join(directory, '.novarc'), normalizeVersion(version) + '\n', 'utf8');
}
