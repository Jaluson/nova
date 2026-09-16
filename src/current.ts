import { t } from './i18n.js';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isMissing } from './fs-utils.js';
import type { Installation } from './types.js';

export interface CurrentJdk {
  javaHome: string;
  version: string;
  vendor: string;
  installation?: Installation;
}

async function canonicalHome(home: string): Promise<string> {
  const resolved = await realpath(home);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Inspect JAVA_HOME without importing it into nova's installation store. */
export async function currentJdk(installed: Installation[], env: NodeJS.ProcessEnv = process.env): Promise<CurrentJdk | undefined> {
  const key = process.platform === 'win32' ? Object.keys(env).find(name => name.toUpperCase() === 'JAVA_HOME') : 'JAVA_HOME';
  const configured = key ? env[key] : undefined;
  if (!configured) return undefined;
  const javaHome = path.resolve(configured);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  try {
    for (const name of ['java', 'javac']) {
      const executable = path.join(javaHome, 'bin', name + suffix);
      if (!(await stat(executable)).isFile()) throw new Error(t("{0} is not a file", name));
      await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    }
    const actualHome = await canonicalHome(javaHome);
    for (const installation of installed) {
      let managedHome: string;
      try { managedHome = await canonicalHome(installation.javaHome); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      if (actualHome === managedHome) return { javaHome, version: installation.version, vendor: 'Amazon Corretto', installation };
    }

    let version: string | undefined;
    let vendor: string | undefined;
    try {
      const release = await readFile(path.join(javaHome, 'release'), 'utf8');
      version = /^JAVA_VERSION="([^"\r\n]+)"\r?$/m.exec(release)?.[1];
      vendor = /^IMPLEMENTOR="([^"\r\n]+)"\r?$/m.exec(release)?.[1];
    } catch (error) { if (!isMissing(error)) throw error; }

    // Older JDKs can lack a release file. Invoke only the configured executable,
    // never a PATH lookup or shell command, with a bounded runtime and output.
    if (!version) {
      const childEnv = { ...env };
      for (const name of Object.keys(childEnv)) if (['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'].includes(name.toUpperCase())) delete childEnv[name];
      const result = await promisify(execFile)(path.join(javaHome, 'bin', 'java' + suffix), ['-XshowSettings:properties', '-version'], {
        env: childEnv, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      version = /^\s*java\.version\s*=\s*([^\r\n]+)$/m.exec(output)?.[1]?.trim()
        ?? /(?:openjdk|java) version "([^"\r\n]+)"/.exec(output)?.[1];
      vendor ??= /^\s*java\.vendor\s*=\s*([^\r\n]+)$/m.exec(output)?.[1]?.trim();
    }
    if (!version) throw new Error(t("Cannot determine the Java version"));
    return { javaHome, version, vendor: vendor ?? t('unknown vendor') };
  } catch (error) {
    throw new Error(t("Cannot inspect JAVA_HOME ({0}): {1}", javaHome, error instanceof Error ? error.message : String(error)));
  }
}
