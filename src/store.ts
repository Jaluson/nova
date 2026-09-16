import { t } from './i18n.js';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractArchive, findJavaHome, validateRelease } from './archive.js';
import { atomicJson, isMissing, readJson, withLock } from './fs-utils.js';
import { cancellation, fetchDownload } from './network.js';
import { normalizeVersion, selectVersion } from './versions.js';
import { sameTarget, type Artifact, type Installation, type Target } from './types.js';
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
export class Store {
  constructor(readonly root: string = novaRoot()) {}
  async jdkDirectory(): Promise<string> {
    const configured = (await readSettings(this.root)).jdkDir;
    return configured ? path.resolve(configured) : path.join(this.root, 'jdks');
  }
  async list(target?: Target): Promise<Installation[]> {
    const directory = await this.jdkDirectory();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const installs: Installation[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readJson<Installation>(path.join(directory, entry.name, 'nova.json'));
      if (!record) continue;
      const installRoot = path.join(directory, entry.name);
      if (record.id !== entry.name || installationId(record) !== entry.name || !path.resolve(record.javaHome).startsWith(installRoot + path.sep)) throw new Error(t("Invalid installation record: {0}", entry.name));
      if (!target || sameTarget(record, target)) installs.push(record);
    }
    return installs;
  }
  async resolve(selector: string, target: Target): Promise<Installation> {
    const result = selectVersion(await this.list(target), selector);
    if (!result) throw new Error(t("Corretto {0} is not installed. Run nova install {1}.", selector, selector));
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
      const records: Array<{ record: Installation; relativeHome: string }> = [];
      try {
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const file = path.join(source, entry.name, 'nova.json');
          const record = await readJson<Installation>(file);
          if (record) records.push({ record, relativeHome: path.relative(source, record.javaHome) });
        }
      } catch (error) { if (!isMissing(error)) throw error; }
      await mkdir(path.dirname(destination), { recursive: true });
      try { await rename(source, destination); } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(destination, { recursive: true });
      }
      for (const { record, relativeHome } of records) {
        const idFile = path.join(destination, record.id, 'nova.json');
        await atomicJson(idFile, { ...record, javaHome: path.join(destination, relativeHome) });
      }
      const settings = await readSettings(this.root);
      const next = { ...settings };
      if (destination === path.join(this.root, 'jdks')) delete next.jdkDir;
      else next.jdkDir = destination;
      await atomicJson(path.join(this.root, 'config.json'), next);
      // Absolute links point into the old directory, so recreate each target.
      for (const item of await this.list()) {
        const link = stableHome(this.root, item);
        await rm(link, { recursive: true, force: true });
        await symlink(item.javaHome, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return destination;
    });
  }
  async check(installation: Installation): Promise<void> {
    const suffix = installation.platform === 'windows' ? '.exe' : '';
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
    const file = path.join(directory, '.novarc');
    try {
      const content = (await readFile(file, 'utf8')).trim();
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
