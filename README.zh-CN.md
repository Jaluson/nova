# nova

[![CI](https://github.com/Jaluson/nova/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaluson/nova/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/nova-jdk)](https://www.npmjs.com/package/nova-jdk) [![许可证](https://img.shields.io/npm/l/nova-jdk)](LICENSE)

面向终端的跨平台 JDK 版本管理器，使用方式参考 nvm。首个版本只安装经过校验的 Amazon Corretto 便携版 JDK，支持 Bash、Zsh、Fish、PowerShell 和 Windows CMD。

[English](README.md) · [npm](https://www.npmjs.com/package/nova-jdk) · [问题反馈](https://github.com/Jaluson/nova/issues)

## 环境要求

- Node.js 22.12 或更高版本
- Linux（glibc）、macOS 或 Windows 的 x64/ARM64
- 当前终端已加载 nova Shell 集成

本版本暂不支持 Windows ARM64、32 位系统和 Alpine/musl Linux。

## 安装

```sh
npm install --global nova-jdk
nova --version
```

从源码安装开发版本：

```sh
git clone https://github.com/Jaluson/nova.git
cd nova
npm ci
npm run build
npm install --global .
```

## 快速开始

先按照 [English README](README.md) 中的 Shell 集成说明初始化当前终端。`JAVA_HOME` 和 JDK 的 `bin` 目录会固定指向 `NOVA_HOME/current` 下的稳定路径；切换版本时只更新软链接（Windows 使用 junction）：

```text
~/.nova/current/linux-x64 -> ~/.nova/jdks/<版本>/jdk
```

然后运行：

```sh
nova ls-remote 21
nova install 21
nova use 21
java -version
nova default 21
nova current
nova ls
```

常用命令包括 `ls-remote`、`install`、`ls`、`use`、`default`、`current`、`pin`、`deactivate`、`uninstall`、`doctor` 和 `language`。支持的 Corretto 主版本目前包括 8、11、17、21、25、26，具体补丁版本由平台远程索引决定。

更新 nova 本身：

```sh
nova update --check
nova update
```

远程列表支持筛选和脚本输出：

```sh
nova ls-remote --latest                 # 每个主版本只显示最新版本
nova ls-remote --platform linux --arch x64
nova ls-remote 21 --json                # 输出带 schema 的 JSON
nova ls --json                          # 已安装 JDK 的带 schema JSON
```

也可以使用统一配置入口：

```sh
nova config
nova config language zh-CN
nova config jdk-dir /data/nova-jdks
nova update --check       # 检查 nova 更新
nova update               # 通过 npm 全局更新 nova
nova install 21 --dry-run # 预览安装，不修改文件
nova alias lts 21.0.9.11.1
nova use lts
nova uninstall 21.0.9.11.1 --yes  # 脚本中跳过确认
```

使用 `nova jdk-dir` 查看 JDK 存储目录，传入新目录可以移动所有已下载的 JDK：

```sh
nova jdk-dir
nova jdk-dir /data/nova-jdks
```

目标目录必须为空或不存在。nova 会同步移动完整目录、更新 `config.json` 和重建稳定链接；缓存、锁和 Shell 集成仍保留在 `NOVA_HOME` 下。

## 多语言

CLI 当前支持英文和简体中文，默认跟随系统语言。版本号、路径和生成的 Shell 代码不会被翻译：

```sh
nova language              # 查看当前语言和保存的偏好
nova language zh-CN        # 保存简体中文
nova language en           # 保存英文
nova language auto         # 跟随系统语言
nova --lang en ls          # 仅本次使用英文
```

优先级为 `--lang`、`NOVA_LANG`、保存的偏好、系统语言。也接受 `zh`、`zh_CN` 和 `en-US` 等别名。翻译目录位于 `src/i18n.ts`，后续可以独立增加其他语言。

## 现有 JDK 和列表

交互式 `ls` 和 `ls-remote` 会打开 Nova TUI。使用 `↑/↓` 或 `j/k` 选择，`/` 搜索，`?` 查看帮助，`Enter` 安装或切换，`d` 设置默认版本，`x` 卸载，`q` 退出。使用 `--plain` 输出紧凑文本，使用 `--all` 查看完整列表，使用 `--page` 输出指定页，使用 `--verbose` 显示路径。JSON 和管道输出保持稳定且不包含终端控制符。

如果 `JAVA_HOME` 已经指向有效 JDK，`nova ls` 会将其显示为外部 JDK，不会导入、移动或删除它。首次激活 nova 时会记住原值，`nova deactivate` 可以恢复。nova 只管理自己安装的 Corretto。

## 开发与贡献

```sh
npm ci
npm run typecheck
npm test
npm pack
```

真实下载测试需要显式运行 `npm run smoke`。提交问题时请附上操作系统、Node.js 版本、Shell 和可复现命令。项目采用 MIT 许可证。
