# nova

用 Node.js + TypeScript 编写的终端 JDK 版本管理器，提供类似 nvm 的使用方式。首版仅支持 **Amazon Corretto 官方便携版 JDK**。

## 安装

需要 Node.js **22.12 或更高版本**。当前仓库的 npm 包名为 `nova-jdk`，安装后的命令为 `nova`；尚未发布到 npm，可先从源码打包安装：

```sh
npm ci
npm pack
npm install -g ./nova-jdk-0.1.0.tgz
nova --version
```

支持 Windows x64、macOS x64/ARM64、Linux glibc x64/ARM64。具体版本是否可安装取决于 Amazon 提供的压缩包。Windows ARM64、32 位系统和 Alpine/musl 暂不支持。WSL 按 Linux 管理，与 Windows 的安装分开。

## 配置终端

Node 子进程不能直接修改父终端的环境，需要先加载 Shell 集成。初始化会定义 `nova` 包装器，并应用默认版本；`npm install` 不会修改你的终端配置或系统环境变量。

### Bash

在 `~/.bashrc` 中加入，在当前终端也执行一次：

```bash
eval "$(nova init bash)"
```

登录 Shell 需要由 `~/.bash_profile` 加载 `~/.bashrc`。

### Zsh

在 `~/.zshrc` 中加入：

```zsh
eval "$(nova init zsh)"
```

### Fish

在 `~/.config/fish/config.fish` 中加入：

```fish
nova init fish | source
```

### PowerShell

支持 PowerShell 7，以及 Windows PowerShell 5.1。在 `$PROFILE` 中加入：

```powershell
nova init powershell | Out-String | Invoke-Expression
```

### CMD

在普通 CMD（关闭 delayed expansion，即 `cmd /V:OFF`）中执行：

```bat
for /f "delims=" %i in ('nova init cmd') do "%i"
```

`nova init cmd` 生成 `%USERPROFILE%\.nova\shell\cmd\init.cmd` 和 `nova.cmd`，输出初始化文件的绝对路径。初始化将包装器加入当前终端的 PATH，并启用 UTF-8 代码页，支持中文路径。

也可把初始化脚本作为 CMD 快捷方式的 `/K` 参数；每次执行脚本都会读取最新默认版本。自定义 `NOVA_HOME` 时使用命令实际输出的路径。

```bat
cmd /D /V:OFF /K "%USERPROFILE%\.nova\shell\cmd\init.cmd"
```

在批处理脚本中，使用 `call nova use 21`、`call nova current` 等方式，确保执行后返回调用方。批处理直接 `call` 包含字面量 `%` 的文件路径时，需按 CMD 的二次展开规则将每个 `%` 写成 `%%%%`。

## 快速开始

完成上面的终端初始化后：

```sh
nova ls-remote 21
nova install 17
nova install 21
nova use 21
java -version
javac -version
nova default 17
nova current
nova ls
```

此时当前终端仍使用 21；新打开并加载集成的终端使用 17。已有终端之间互不影响；从已启用 nova 的终端启动的子 Shell 继承父终端的选择。

## 命令

| 命令 | 说明 |
| --- | --- |
| `nova ls-remote [major] [--refresh]` | 分页浏览当前平台可下载的版本，可强制刷新缓存 |
| `nova install <version>` | 安装主版本最新稳定补丁，或指定精确版本 |
| `nova ls [--verbose]` | 分页浏览本地 JDK，标记 current/default/external；可显示路径 |
| `nova use [version]` | 切换当前终端；不传版本时向上查找 `.novarc` |
| `nova default <version>` | 设置新终端默认版本 |
| `nova current` | 输出 `JAVA_HOME` 指向的 JDK 版本，支持外部 JDK |
| `nova pin [version]` | 将本地版本写入当前目录 `.novarc`；省略时使用当前版本 |
| `nova deactivate` | 移除 nova 的 JDK 路径并恢复原 `JAVA_HOME` |
| `nova uninstall <exact-version>` | 删除一个精确版本 |
| `nova init <shell>` | 生成对应终端的集成代码或入口 |
| `nova doctor` | 检查安装、默认版本、终端集成、`JAVA_HOME` 和 PATH |
| `nova language [en\|zh-CN\|auto]` | 查看或保存界面语言偏好 |

支持的主版本为 **8、11、17、21、25、26**。远程版本列表仅显示具有 SHA-256 的官方稳定 JDK 压缩包，不提供安装器、JRE、调试符号包或预发布。

### 界面语言

支持简体中文和英文，默认跟随系统语言。帮助、提示、错误和分页界面使用所选语言，版本号、路径和 Shell 代码保持原样；操作系统或第三方返回的错误详情保留原文。

```sh
nova language                 # 查看当前语言和保存的偏好
nova language zh-CN           # 保存为简体中文
nova language en              # 保存为英文
nova language auto            # 恢复跟随系统
nova --lang en ls             # 仅本次使用英文
nova ls-remote --lang zh-CN    # 语言选项也可放在子命令后
```

优先级：`--lang` > 环境变量 `NOVA_LANG` > 保存的偏好 > 系统语言。`auto` 根据 `LC_ALL`、`LC_MESSAGES`、`LANG` 的顺序选择，未设置时使用 Node 检测到的系统语言；中文环境显示简体中文，其他语言环境使用英文。也接受 `zh`、`zh_CN`、`en-US` 等语言别名。

语言偏好保存在 nova 的 `config.json` 中，与默认 JDK 设置共存。`--lang` 和 `NOVA_LANG` 不修改保存的偏好。脚本需要固定英文输出时，可设置 `NOVA_LANG=en`。升级后重新加载上文的 Shell 集成，使 `nova --lang zh-CN use 21` 等带全局选项的切换命令在当前终端生效。

### 列表浏览

在交互式终端中，`ls` 和 `ls-remote` 使用紧凑表格，每页默认最多 20 条，并根据终端高度自动减少，避免刷屏。超过一页时进入分页浏览：

- `n`、右/下方向键、空格：下一页；`p`、左/上方向键：上一页。
- `Home` / `End`：第一页 / 最后一页；`q` / Esc：退出并保留当前页；Ctrl+C：中断。
- 页尾显示版本总数、当前范围和页码；调整窗口大小会重新排版。
- 本地列表优先展示当前版本和默认版本；完整路径默认隐藏，`--verbose` 显示适合当前终端宽度的路径。

```sh
nova ls                       # 紧凑本地列表
nova ls --verbose             # 显示路径，过长时省略
nova ls-remote 21              # 只浏览 JDK 21
nova ls-remote --page-size 10  # 每页最多 10 条
nova ls-remote 21 --page 2     # 直接输出第 2 页，不进入交互模式
nova ls --all                 # 输出所有版本及完整路径
nova ls-remote --all          # 输出所有远程版本
```

`--all` 不能和 `--page`、`--page-size` 同时使用。输出到管道、文件或非交互式终端时，默认保留原来的完整文本列表，不输出终端控制码、不等待按键；显式指定 `--page` 或 `--page-size` 时输出对应的静态分页。

### 已配置 JAVA_HOME

第一次使用时，`nova ls` 会自动识别 `JAVA_HOME` 指向的已有 JDK，无需先安装或初始化 Shell。使用 `nova ls --all` 可以查看完整路径，例如：

```text
21.0.7  current  external (Eclipse Adoptium)    /opt/my-jdk
```

外部 JDK 可以来自任意发行商；该识别仅用于展示，不会导入、移动或删除已有 JDK。`install`、`use`、`default`、`pin`、`uninstall` 仍管理 nova 安装的 Corretto。`current` 标记以实际 `JAVA_HOME` 为准；若它指向 nova 已管理的目录（含符号链接），只显示一条记录。

`JAVA_HOME` 必须指向包含 `bin/java` 和 `bin/javac` 的 JDK 根目录。路径无效时 `ls` 会提示原因，并继续列出 nova 的安装。这里的 `current` 表示 `JAVA_HOME` 的选择；若 PATH 配置不同，直接运行 `java` 仍可能使用另一个版本。

### 精确版本与更新

```sh
nova install 21.0.9.11.1
nova install 21.0.10.7.1
nova use 21.0.9.11.1
```

- 精确版本采用 Corretto 完整构建号，不能只用 `21.0.9` 代替 `21.0.9.11.1`。
- `install 21` 查询远程最新稳定补丁；`use 21`、`default 21`、`pin 21` 选择本地最高版本。
- 安装不会自动切换，也不会覆盖或删除旧版本。更新时再次 `install 21`，然后 `use 21`。
- 已安装的精确版本可离线重复安装，直接复用；本地查询、切换和设置默认版本均不依赖网络。
- JDK 8 支持完整数字构建号及 `8u492-b09.2` 形式，显示时统一为 `8.492.9.2`。可用版本以 `ls-remote 8` 为准。

### 项目版本

```sh
nova pin 21
# 将生成的 .novarc 提交到项目仓库
nova use
```

`.novarc` 只保存一行精确版本。`nova use` 从当前目录向上寻找最近的文件；格式错误或版本未安装时明确报错，原环境保持不变。不会在进入目录时自动切换，也不会执行文件内容。

## 数据与网络

默认数据目录为 `~/.nova`（Windows 为 `%USERPROFILE%\.nova`）。可在初始化前设置 `NOVA_HOME` 为其他目录。

```text
~/.nova/
  jdks/          # 按完整版本、系统和架构隔离的 JDK，内含 nova.json
  cache/         # Corretto 发布元数据
  tmp/           # 安装过程临时目录
  shell/cmd/     # CMD 包装器与初始化入口
  config.json    # 默认安装标识与语言偏好
  .write-lock    # 仅写操作期间存在
```

- 数据来源：[Amazon 官方发布记录](https://github.com/corretto/corretto-21/releases)，压缩包来自 Amazon 官方下载域名。
- 元数据缓存一小时；网络失败可回退到缓存，并输出缓存时间及错误提示。GitHub 限流时可配置可选的 `GITHUB_TOKEN`，凭据不会写入安装记录。
- 下载流式写入临时目录，校验 SHA-256 后安全解压，检查发行信息与 `java`/`javac`，最后原子发布。失败不会留下已安装记录。
- Corretto 8 的部分压缩包没有 `release` 文件，nova 会在校验通过后调用该 JDK 查询发行商、版本和平台信息。
- ZIP 拒绝链接和特殊文件；tar 允许安装内部的安全链接，拒绝目录越界。Unix 执行权限会保留。
- 安装、删除、默认配置和语言偏好共用写锁；重复并发写操作会明确报错。
- 首版无断点续传、镜像源、自动代理配置、遥测或自动升级。

## 故障排查

- **`use` 提示 Shell integration required**：按上文加载当前 Shell 对应的初始化入口；直接运行 `node dist/cli.js use` 无法改变父终端。
- **Java 路径不正确**：执行 `nova doctor`，再运行 `nova use <version>`；切换会刷新 Bash/Zsh 的命令路径缓存。
- **不能删除默认版本**：先 `nova default <另一个已安装版本>`。当前终端使用的版本需先切换或 `nova deactivate`。nova 无法感知其他已打开终端的引用，删除前请结束那些终端对该版本的使用。
- **残留写锁**：正常失败或 Ctrl+C 会清理锁。强制杀进程或断电后，确认没有 nova 写进程运行，再删除数据目录中的 `.write-lock`，并可清理 `tmp` 中的残留目录。
- **CMD 提示 delayed expansion**：使用 `cmd /V:OFF`。CMD 环境值不接受双引号，所有 Shell 环境值均不接受换行或 NUL。
- **移动了 nova 或 Node 安装位置**：重新执行终端初始化；CMD 先重新生成 `nova init cmd` 入口。

## 开发与测试

```sh
npm ci
npm run typecheck
npm test
npm pack
```

普通测试使用固定发布记录和生成的最小压缩包，覆盖版本解析、缓存、安装清理、写锁、项目配置和 Shell 实际会话。系统未安装或不适用的 Shell 测试会跳过。

真实官方下载测试需显式运行，下载数据放在独立临时目录，结束后清理：

```sh
npm run smoke
# Bash/Zsh 下验证两个主版本：
NOVA_SMOKE_VERSIONS=17,21 npm run smoke
```

CI 配置包含 Windows、macOS、Linux × Node 22/24，验证构建、测试和 npm 包安装；手动触发时可启用真实下载测试。CLI 层负责命令，数据源、版本解析、存储、解压、网络与 Shell 适配分别独立，方便后续增加 JDK 发行商。

许可：MIT。
