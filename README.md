# Nova

Nova 是一个基于 Tauri 2 的开发环境管理工具，当前主要用于在 Windows 上管理 JDK 和 Maven 的多版本安装、切换与环境变量配置。

它的核心思路和 `nvm` 类似：把多个版本集中存放在 Nova 管理目录下，再通过一个固定的符号链接路径指向“当前版本”。环境变量只需要配置一次，后续切换版本时不再反复修改 `JAVA_HOME` 或 `MAVEN_HOME`。

## 当前能力

- 管理 JDK 版本
  - 远程查询可下载版本
  - 从 `Tsinghua`、`Corretto`、`Adoptium`、`Zulu` 下载并安装
  - 从本地目录或 ZIP 导入
  - 切换当前版本
  - 卸载已安装版本
- 管理 Maven 版本
  - 从 Apache 元数据查询远程版本
  - 下载并安装
  - 从本地目录或 ZIP 导入
  - 切换当前版本
  - 卸载已安装版本
- 下载任务管理
  - 显示进度、速度和任务数
  - 支持暂停、继续、取消
- 环境变量辅助
  - 检查 `JAVA_HOME` / `MAVEN_HOME` 是否指向 Nova 管理路径
  - 一键配置当前用户环境变量
  - 支持尝试配置系统级环境变量
- Maven 配置管理
  - 管理 `settings.xml` 路径
  - 管理本地仓库路径
  - 管理镜像配置
- 首次启动引导
  - 配置 JDK 存储目录
  - 配置默认符号链接路径
  - 生成环境变量命令

## 工作方式

默认情况下，Nova 会使用以下目录：

```text
~/.nova/
  config.toml
  versions/          # JDK 安装目录
  current            # 当前 JDK 的符号链接
  maven/
    versions/        # Maven 安装目录
    current          # 当前 Maven 的符号链接
  cache/
  cache/maven/
```

典型的环境变量配置方式：

```powershell
[System.Environment]::SetEnvironmentVariable("JAVA_HOME", "$HOME\.nova\current", "User")
[System.Environment]::SetEnvironmentVariable("MAVEN_HOME", "$HOME\.nova\maven\current", "User")
```

之后 Nova 通过更新 `current` 链接来完成版本切换。

在 Windows 下，Nova 会优先创建目录符号链接；如果权限或系统策略不允许，会降级为 `junction`。

## 技术栈

- Tauri 2
- Rust
- Vanilla JavaScript
- Tailwind CSS 4

## 开发环境要求

建议在 Windows 上开发和运行。当前仓库包含 Windows 打包脚本，桌面端能力也围绕 Windows 环境变量和路径行为实现。

需要的基础环境：

- Node.js
- Rust toolchain
- WebView2 运行时
- Windows 下可用的 Rust / Tauri 构建环境

本仓库记录的 Rust 环境：

- `rustc 1.96.0`
- `cargo 1.96.0`

## 安装依赖

```powershell
npm install
```

## 本地开发

这个项目的前端资源直接从 `src/` 提供，CSS 需要单独监听构建。开发时建议开两个终端。

终端 1：

```powershell
npm run dev:css
```

终端 2：

```powershell
npx tauri dev
```

## 生产构建

先构建 CSS，再构建 Tauri 应用：

```powershell
npm run build:css
npx tauri build
```

## Windows 便携包

仓库内置了一个 Windows 便携包脚本：

```powershell
.\scripts\build-portable-windows.ps1
```

脚本会执行以下流程：

1. 构建 CSS
2. 执行 `npx tauri build --no-bundle`
3. 组装便携目录
4. 输出 ZIP 到 `dist/`

默认产物示例：

```text
dist/
  Nova-0.1.0-windows-portable/
  Nova-0.1.0-windows-portable.zip
```

## 配置文件

配置文件默认位于：

```text
~/.nova/config.toml
```

示例：

```toml
[jvm]
setup_done = true
default_source = "tsinghua"
# versions_dir = "D:\\Java\\versions"
# symlink_path = "D:\\Java\\current"

[maven]
# versions_dir = "D:\\Maven\\versions"
# symlink_path = "D:\\Maven\\current"
# settings_path = "C:\\Users\\<user>\\.m2\\settings.xml"
# local_repository = "D:\\m2-repository"

[[maven.mirrors]]
id = "aliyun"
name = "Aliyun"
url = "https://maven.aliyun.com/repository/public"
mirror_of = "*"
```

## 目录结构

```text
.
├─ src/                 # 前端页面、脚本、样式
├─ src-tauri/           # Tauri / Rust 后端
├─ scripts/             # 辅助脚本
├─ dist/                # 构建产物
├─ package.json
└─ README.md
```

`src-tauri/src/` 中的主要模块：

- `lib.rs`: Tauri 命令注册与应用入口
- `setup.rs`: 首次引导、环境变量检查与配置
- `jdk.rs`: JDK 安装、导入、切换、卸载
- `maven.rs`: Maven 安装、导入、切换、卸载、settings 管理
- `download.rs`: 下载任务与进度控制
- `config.rs`: 配置读写
- `symlink.rs`: 链接创建、读取、删除
- `provider/`: JDK 远程源实现

## 已实现的 Tauri 命令

这个项目已经不是模板工程，Rust 后端暴露了完整的桌面命令接口，包含但不限于：

- 初始化与状态检查
  - `is_setup_needed`
  - `complete_setup`
  - `check_java_home`
  - `check_maven_home`
- JDK 管理
  - `list_versions`
  - `list_remote_versions`
  - `install_version`
  - `import_jdk`
  - `use_version`
  - `uninstall_version`
- Maven 管理
  - `list_maven_versions`
  - `list_remote_maven_versions`
  - `install_maven_version`
  - `import_maven`
  - `use_maven_version`
  - `uninstall_maven_version`
- 下载控制
  - `pause_download`
  - `resume_download`
  - `cancel_download`
- 配置管理
  - `get_config`
  - `update_config`
  - `update_tool_config`
  - `load_maven_settings`
  - `save_maven_settings`

## 当前限制

- 当前文档和脚本以 Windows 为主
- 系统级环境变量配置通常需要管理员权限
- 前端仍然直接使用原生 HTML / JS，未引入组件框架
- CSS 需要手动监听或手动构建
- 仓库里存在 `dist/` 和构建产物目录，提交和发布时需要自行控制产物范围

## 说明

原始 `README.md` 仍是 Tauri 模板文案，本次已按仓库实际实现更新。后续如果继续扩展平台支持、安装源或发布方式，README 也需要同步维护。
