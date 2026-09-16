import { t } from './i18n.js';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import yauzl from 'yauzl';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Artifact } from './types.js';
import { isMissing } from './fs-utils.js';

export function safeArchivePath(name: string): string {
  if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) throw new Error(t("Unsafe archive path: {0}", name));
  // Prevent alternate Windows names and device files, including when tested on Unix.
  if (name.split('/').some(part => part !== '.' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error(t("Unsafe archive path: {0}", name));
  return name;
}
export function safeLink(name: string, link: string, hard: boolean): void {
  if (!link || /[\\\x00-\x1f:]/.test(link) || path.posix.isAbsolute(link)) throw new Error(t("Unsafe archive link: {0}", name));
  const target = path.posix.normalize(hard ? link : path.posix.join(path.posix.dirname(name), link));
  safeArchivePath(target);
}
async function extractTar(file: string, destination: string): Promise<void> {
  // Validate the entire archive before tar writes anything. tar also refuses traversal
  // through symlink parents with preservePaths:false during extraction.
  const names = new Set<string>();
  let invalid: unknown;
  await tar.t({ file, strict: true, onReadEntry(entry) {
    try {
    safeArchivePath(entry.path);
    const normalized = path.posix.normalize(entry.path).replace(/\/$/, '');
    if (names.has(normalized) && entry.type !== 'Directory') throw new Error(t("Duplicate archive entry: {0}", entry.path));
    names.add(normalized);
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') safeLink(entry.path, entry.linkpath ?? '', entry.type === 'Link');
    else if (!['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(entry.type)) throw new Error(t("Unsupported archive entry: {0}", entry.type));
    } catch (error) { invalid ??= error; }
  } });
  if (invalid) throw invalid;
  await tar.x({ file, cwd: destination, strict: true, preservePaths: false, noChmod: false, noMtime: true });
}
async function extractZip(file: string, destination: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
  try {
    await new Promise<void>((resolve, reject) => {
      const names = new Set<string>();
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          safeArchivePath(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const type = mode & 0o170000;
          if (type && type !== 0o100000 && type !== 0o040000) throw new Error(t("Unsupported ZIP link or special file: {0}", entry.fileName));
          const key = entry.fileName.toLowerCase().replace(/\/$/, '');
          if (names.has(key)) throw new Error(t("Duplicate ZIP entry: {0}", entry.fileName));
          names.add(key);
          const dest = path.join(destination, entry.fileName);
          if (entry.fileName.endsWith('/')) await mkdir(dest, { recursive: true });
          else {
            await mkdir(path.dirname(dest), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value!)));
            await pipeline(stream, createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
            if (mode & 0o111) await chmod(dest, 0o755);
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}
export async function extractArchive(file: string, destination: string, format: Artifact['format']): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (format === 'zip') await extractZip(file, destination);
  else await extractTar(file, destination);
}
export async function findJavaHome(root: string, platform: Artifact['platform']): Promise<string> {
  const candidates = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(root, entry.name), path.join(root, entry.name, 'Contents', 'Home'));
  }
  const suffix = platform === 'windows' ? '.exe' : '';
  const actualRoot = await realpath(root);
  for (const candidate of candidates) {
    try {
      for (const executable of ['java', 'javac']) {
        const file = path.join(candidate, 'bin', executable + suffix);
        const actual = await realpath(file);
        if (!actual.startsWith(actualRoot + path.sep)) throw new Error(t("JDK executable escapes installation directory."));
        const stat = await lstat(actual);
        if (!stat.isFile() || (platform !== 'windows' && process.platform !== 'win32' && !(stat.mode & 0o111))) throw new Error(t("Invalid JDK executable: {0}", file));
      }
      return candidate;
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  throw new Error(t("Archive does not contain a usable JDK (java and javac required)."));
}
export async function validateRelease(javaHome: string, artifact: Artifact): Promise<void> {
  let entries: Record<string, string>;
  try {
    const release = await readFile(path.join(javaHome, 'release'), 'utf8');
    entries = Object.fromEntries([...release.matchAll(/^([A-Z_]+)="(.*)"\r?$/gm)].map(m => [m[1]!, m[2]!]));
  } catch (error) {
    if (!isMissing(error) || !artifact.version.startsWith('8.')) throw error;
    // Corretto 8 portable archives can omit the release file. Only after the
    // archive has passed its official checksum, ask this JVM for its properties.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'].includes(key.toUpperCase())) delete env[key];
    const executable = path.join(javaHome, 'bin', artifact.platform === 'windows' ? 'java.exe' : 'java');
    const output = await promisify(execFile)(executable, ['-XshowSettings:properties', '-version'], { env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const properties = Object.fromEntries([...`${output.stdout}\n${output.stderr}`.matchAll(/^\s*([\w.]+) = (.+)\r?$/gm)].map(m => [m[1]!, m[2]!.trim()]));
    entries = {
      IMPLEMENTOR: properties['java.vendor'] ?? '', JAVA_VERSION: properties['java.version'] ?? '',
      OS_ARCH: properties['os.arch'] ?? '', OS_NAME: /^Windows\b/.test(properties['os.name'] ?? '') ? 'Windows' : properties['os.name'] ?? '',
    };
  }
  if (!/amazon|corretto/i.test(`${entries.IMPLEMENTOR ?? ''} ${entries.JAVA_RUNTIME_VERSION ?? ''}`)) throw new Error(t("Archive is not an Amazon Corretto JDK."));
  const major = artifact.version.split('.')[0]!;
  const javaVersion = entries.JAVA_VERSION ?? '';
  if (!(major === '8' ? javaVersion.startsWith('1.8.0_') : javaVersion.startsWith(`${major}.`) || javaVersion === major)) throw new Error(t("JDK release version does not match requested major."));
  const expectedArch = artifact.arch === 'aarch64' ? ['aarch64', 'arm64'] : ['amd64', 'x86_64', 'x64'];
  if (!expectedArch.includes(entries.OS_ARCH ?? '')) throw new Error(t("JDK architecture does not match download metadata."));
  const expectedOs = { linux: ['Linux'], macos: ['Darwin', 'Mac OS X'], windows: ['Windows'] }[artifact.platform];
  if (!expectedOs.includes(entries.OS_NAME ?? '')) throw new Error(t("JDK operating system does not match download metadata."));
}
