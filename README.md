# nova

[![CI](https://github.com/Jaluson/nova/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaluson/nova/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/nova-jdk)](https://www.npmjs.com/package/nova-jdk) [![license](https://img.shields.io/npm/l/nova-jdk)](LICENSE)

Cross-platform JDK version management for the terminal, inspired by nvm. The first release installs verified Amazon Corretto portable JDK archives and works with Bash, Zsh, Fish, PowerShell, and Windows CMD.

[中文文档](README.zh-CN.md) · [npm](https://www.npmjs.com/package/nova-jdk) · [Issues](https://github.com/Jaluson/nova/issues)

## Requirements

- Node.js 22.12 or newer
- x64 or ARM64 on Linux (glibc), macOS, or Windows
- A shell integration loaded in the current terminal

Windows ARM64, 32-bit systems, and Alpine/musl Linux are not supported in this release.

## Install

```sh
npm install --global nova-jdk
nova --version
```

To install the development version from this repository:

```sh
git clone https://github.com/Jaluson/nova.git
cd nova
npm ci
npm run build
npm install --global .
```

## Shell integration

`nova use` keeps `JAVA_HOME` and the JDK `bin` directory pointed at a stable path under `NOVA_HOME/current`. Switching versions updates a directory symlink (or a Windows junction), so environment variables do not change on every switch. Add the matching command to your shell profile and run it once in the current terminal:

```sh
# Bash
eval "$(nova init bash)"

# Zsh
eval "$(nova init zsh)"

# Fish
nova init fish | source
```

PowerShell:

```powershell
nova init powershell | Out-String | Invoke-Expression
```

CMD (run with delayed expansion disabled):

```bat
for /f "delims=" %i in ('nova init cmd') do "%i"
```

Reload the profile after upgrading nova so the wrapper uses the new implementation.

## Quick start

```sh
nova ls-remote 21       # browse verified Corretto releases
nova install 21         # install the newest JDK 21 release
nova use 21             # select it in this terminal
java -version
nova default 21         # select the default for new terminals
nova current
nova ls
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `nova ls-remote [major]` | Browse downloadable Corretto versions |
| `nova install <version>` | Install a major or exact version |
| `nova ls` | Browse installed and externally configured JDKs |
| `nova use [version]` | Select a version in the current shell |
| `nova default <version>` | Set the default for new shells |
| `nova current` | Show the JDK selected by `JAVA_HOME` |
| `nova pin [version]` | Save a project version in `.novarc` |
| `nova deactivate` | Restore the environment before nova |
| `nova uninstall <exact-version>` | Remove an installed version |
| `nova doctor` | Diagnose installation and shell integration |
| `nova update [--check]` | Check for or install the latest nova release |
| `nova language [language]` | Show or save the interface language |
| `nova jdk-dir [directory]` | Show or move the downloaded JDK directory |
| `nova config [key] [value]` | Show or update configuration |
| `nova update [--check]` | Check for or install the latest nova release |

Supported Corretto major versions currently include 8, 11, 17, 21, 25, and 26. The remote index determines which exact releases are available for a platform.

Remote listings can be filtered or consumed by automation:

```sh
nova ls-remote --latest                 # newest release for every major
nova ls-remote --platform linux --arch x64
nova ls-remote 21 --json                # JSON array for scripts
nova ls --json                          # installed JDKs as JSON
nova update --check                      # check for a newer nova release
nova update                             # update nova globally via npm
```

## Language support

The CLI currently provides English and Simplified Chinese. It follows the system locale by default and keeps version numbers, paths, and generated shell code unchanged.

```sh
nova language              # show effective language and preference
nova language zh-CN        # save Simplified Chinese
nova language en           # save English
nova language auto         # follow the system locale
nova --lang en ls          # override language for one command
```

Language precedence is `--lang`, `NOVA_LANG`, saved preference, then the system locale. `zh`, `zh_CN`, and `en-US` are accepted aliases. The translation catalog is isolated in `src/i18n.ts`, so additional locales can be added without changing command behavior.

## Lists and existing Java installations

Interactive `ls` and `ls-remote` use compact pages. Use `--all` for a complete list, `--page` for a static page, and `--verbose` to include paths. A pipe receives plain output without terminal controls.

If `JAVA_HOME` already points to a valid JDK, `nova ls` shows it as an external JDK without importing, moving, or deleting it. The first nova activation remembers that value, and `nova deactivate` restores it. Nova manages only its own Corretto installations.

## Data and security

The default data directory is `~/.nova` (`%USERPROFILE%\\.nova` on Windows); set `NOVA_HOME` to use another location. Release metadata is cached locally. Downloads are checked against SHA-256 metadata before extraction, and archive paths and file types are validated before an installation is published.

To move already downloaded JDKs, provide a new directory. It must be empty or not yet exist; nova moves the complete directory and updates the configuration and stable links together:

```sh
nova jdk-dir
nova jdk-dir /data/nova-jdks
```

The configured path is stored in `config.json` as `jdkDir`. Metadata, locks, caches, and shell integration remain under `NOVA_HOME`.

`nova config` provides the same settings from one entry point:

```sh
nova config
nova config language zh-CN
nova config jdk-dir /data/nova-jdks
```

Nova does not provide installers, JREs, telemetry, automatic upgrades, or a custom mirror in this release. See [SECURITY.md](SECURITY.md) for reporting security issues.

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack
```

The test suite covers version selection, metadata caching, safe extraction, concurrent writes, `JAVA_HOME` detection, pagination, language selection, and shell integrations. Real downloads are opt-in:

```sh
npm run smoke
```

Contributions are welcome. Please open an issue before large changes and include the platform, Node.js version, shell, and a reproducible command when reporting a bug.

## License

MIT. See [LICENSE](LICENSE).
