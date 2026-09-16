# nova

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

交互式 `ls` 和 `ls-remote` 使用紧凑分页；使用 `--all` 查看完整列表，使用 `--page` 输出指定页，使用 `--verbose` 显示路径。输出到管道时不会插入终端控制符。

如果 `JAVA_HOME` 已经指向有效 JDK，`nova ls` 会将其显示为外部 JDK，不会导入、移动或删除它。首次激活 nova 时会记住原值，`nova deactivate` 可以恢复。nova 只管理自己安装的 Corretto。

## 开发与贡献

```sh
npm ci
npm run typecheck
npm test
npm pack
```

真实下载测试需要显式运行 `npm run smoke`。提交问题时请附上操作系统、Node.js 版本、Shell 和可复现命令。项目采用 MIT 许可证。
