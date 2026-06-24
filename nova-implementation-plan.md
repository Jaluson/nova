# nova — JDK 版本管理器（Tauri GUI）实现计划

## Context

构建一个界面精美的 JDK 版本管理器，使用 Tauri 2.0（Rust 后端 + Web 前端）。兼顾视觉美观、性能和小体积（~5-8MB）。当前 Windows，预留 Mac/Linux 适配。

**核心思路（类 nvm）**：程序管理 `~/.nova/versions/` 下的多个 JDK 版本，通过一个符号链接指向当前使用的版本。用户需**手动**将 `JAVA_HOME` 指向该符号链接路径，并加入 `PATH`。之后切换版本只需程序更新符号链接目标即可，无需修改环境变量。

## 核心决策

| 决策项 | 选择 |
|--------|------|
| 框架 | **Tauri 2.0**（Rust 后端 + Web 前端） |
| 前端 | **HTML + TailwindCSS + 原生 JS**（轻量，不引入重型框架） |
| 切换机制 | 符号链接，默认 `~/.nova/current` → `~/.nova/versions/<ver>`，支持自定义路径 |
| JDK 源 | **Corretto(默认)** + Adoptium + Zulu + 本地导入 |
| 包格式 | 仅 zip |
| 包体积 | ~5-8MB（Windows 11 自带 WebView2） |

## 符号链接机制（类 nvm）

### 工作原理

```
用户手动设置:
  JAVA_HOME = C:\Users\<user>\.nova\current     (Windows)
  PATH += %JAVA_HOME%\bin

程序自动管理:
  ~/.nova/current  ──symlink──▶  ~/.nova/versions/21.0.11/
  ~/.nova/current  ──symlink──▶  ~/.nova/versions/17.0.19/   (切换后)
```

用户配置一次环境变量，之后所有版本切换都由程序通过更新 symlink 完成，**无需再动环境变量**。

### 自定义符号链接路径

用户可在 `config.toml` 或设置界面中指定自定义路径：

```toml
[jvm]
# 默认: null (使用 ~/.nova/current)
# 自定义: 任意绝对路径，如 "D:\\Java\\current" 或 "/opt/java/current"
symlink_path = "D:\\Java\\current"
```

**约束**：
- 必须是绝对路径
- 程序需有该路径父目录的写权限（创建/删除符号链接）
- 切换自定义路径时，旧符号链接会被删除，在新路径重新创建

### Windows 符号链接注意事项

Windows 创建符号链接需要以下任一条件：
1. **开发者模式开启**（推荐，设置 → 更新和安全 → 开发者选项）
2. **以管理员身份运行** nova

如果两者都不满足，nova 会在引导页中提示用户开启开发者模式，或改用 **目录联接（Junction）** 作为降级方案（Junction 不需要特殊权限）。

> **Junction 降级**： Junction 在功能上等价于目录符号链接，且不需要开发者模式或管理员权限。但 Junction 只能指向本地路径（对我们场景足够）。程序优先使用 symlink，失败时自动降级为 Junction。

### 各平台环境变量配置参考

首次引导页会展示对应平台的配置命令，供用户复制：

**Windows（CMD）**：
```cmd
setx JAVA_HOME "%USERPROFILE%\.nova\current"
setx PATH "%PATH%;%JAVA_HOME%\bin"
```

**Windows（PowerShell）**：
```powershell
[System.Environment]::SetEnvironmentVariable("JAVA_HOME", "$env:USERPROFILE\.nova\current", "User")
$oldPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
[System.Environment]::SetEnvironmentVariable("Path", "$oldPath;$env:USERPROFILE\.nova\current\bin", "User")
```

**macOS/Linux（bash）**：
```bash
echo 'export JAVA_HOME="$HOME/.nova/current"' >> ~/.bashrc
echo 'export PATH="$JAVA_HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

**macOS/Linux（zsh）**：
```zsh
echo 'export JAVA_HOME="$HOME/.nova/current"' >> ~/.zshrc
echo 'export PATH="$JAVA_HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

> 如果用户自定义了 `symlink_path`，上述命令中的路径需要替换为自定义路径。

## 界面设计

### 引导页（首次启动）

应用首次启动时（`~/.nova/config.toml` 不存在或未标记 `setup_done = true`），显示引导页：

```
┌───────────────────────────────────────────────────────────────┐
│  ☕ JVM Manager                              ─  □  ✕         │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│          ☕                                    │
│                                                               │
│        欢迎使用 Nova JDK 管理器                                │
│                                                               │
│   ─── 第 1 步：选择 JDK 存储位置 ──────────────────────────    │
│                                                               │
│   JDK 安装目录:                                               │
│   [C:\Users\21135\.nova\versions                   ] 📂       │
│                                                               │
│   ─── 第 2 步：配置符号链接路径 ──────────────────────────    │
│                                                               │
│   符号链接路径 (JAVA_HOME 将指向此路径):                       │
│                                                               │
│   ○ 使用默认路径                                               │
│     C:\Users\21135\.nova\current                              │
│                                                               │
│   ○ 自定义路径                                                 │
│     [D:\Java\current                                ] 📂       │
│                                                               │
│   ─── 第 3 步：配置环境变量 ──────────────────────────────    │
│                                                               │
│   请在终端中执行以下命令（点击可复制）：                         │
│                                                               │
│   ┌─────────────────────────────────────────────────────┐     │
│   │  [CMD]  [PowerShell]                                │     │
│   │                                                     │     │
│   │  setx JAVA_HOME "%USERPROFILE%\.nova\current"      │     │
│   │  setx PATH "%PATH%;%JAVA_HOME%\bin"                │     │
│   └─────────────────────────────────────────────────────┘     │
│                                                               │
│   ☐ 我已完成环境变量配置                                       │
│                                                               │
│                          [ 完成设置 ]                          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**引导页逻辑**：
- 第 1 步：选择 JDK 存储目录，默认 `~/.nova/versions`，可自定义
- 第 2 步：选择符号链接路径，默认 `~/.nova/current`，可自定义
- 第 3 步：根据用户选择的路径，动态生成对应平台的环境变量配置命令
- 复选框"我已完成环境变量配置"不强制勾选，但未勾选时每次启动主界面底部会显示提醒条
- 点击"完成设置"后标记 `setup_done = true`，后续启动直接进入主界面

### 主界面 — 深色主题，现代感

```
┌───────────────────────────────────────────────────────────────┐
│  ☕ JVM Manager                              ─  □  ✕         │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  🔍 安装新版本    📂 本地导入    🔄 刷新    源: Corretto ▼│  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  版本        发行版       状态        操作               │  │
│  │  ─────────  ──────────  ─────────  ──────────────────   │  │
│  │  21.0.11    Corretto    ● 使用中    [卸载]              │  │
│  │  17.0.19    Adoptium    已安装     [切换] [卸载]         │  │
│  │  11.0.31    Zulu        已安装     [切换] [卸载]         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  已安装 3 个版本  ·  当前: 21.0.11 (Corretto)                 │
│                                                               │
│  ⚠ 尚未检测到 JAVA_HOME 配置，点击查看配置说明                 │  ← 未配置时显示
└───────────────────────────────────────────────────────────────┘
```

### 设置界面

从主界面齿轮图标进入：

```
┌───────────────────────────────────────────────────────────────┐
│  ← 设置                                                      │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  ── JDK 存储 ──                                               │
│                                                               │
│  安装目录:                                                    │
│  [C:\Users\21135\.nova\versions                   ] 📂        │
│                                                               │
│  ── 符号链接 ──                                               │
│                                                               │
│  ○ 默认路径  C:\Users\21135\.nova\current                     │
│  ○ 自定义    [D:\Java\current                      ] 📂       │
│                                                               │
│  当前状态: ✅ 符号链接正常 → 21.0.11                          │
│                                                               │
│  ── 环境变量配置参考 ──                                       │
│                                                               │
│  JAVA_HOME = C:\Users\21135\.nova\current                     │
│  PATH += %JAVA_HOME%\bin                                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  setx JAVA_HOME "C:\Users\21135\.nova\current"     │  📋  │
│  └─────────────────────────────────────────────────────┘      │
│                                                               │
│  ── 下载源 ──                                                 │
│                                                               │
│  默认源: [Corretto     ▼]                                     │
│                                                               │
│                       [ 保存设置 ]                             │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 安装弹窗（模态框）

```
┌────────────────────────────────────┐
│  安装 JDK                    ✕     │
│                                    │
│  ┌─ 远程安装 ─────────────────┐    │
│  │ 版本: [21          ▼]     │    │
│  │ 源:   [Corretto     ▼]    │    │
│  │     [  下载并安装  ]      │    │
│  └───────────────────────────┘    │
│                                    │
│  ┌─ 本地导入 ─────────────────┐    │
│  │ 路径: [C:\java\jdk-21] 📂 │    │
│  │     [    导入    ]         │    │
│  └───────────────────────────┘    │
│                                    │
│  ▓▓▓▓▓▓▓▓▓▓▓▓░░░ 67% 正在下载...  │
└────────────────────────────────────┘
```

## 目录结构

```
E:\Engineer\oprojects\nova\
├── Cargo.toml                    # Rust workspace root
├── package.json                  # 前端依赖
├── src-tauri/
│   ├── Cargo.toml                # Tauri Rust 后端
│   ├── tauri.conf.json           # Tauri 配置
│   ├── icons/                    # 应用图标
│   └── src/
│       ├── main.rs               # Tauri 入口
│       ├── lib.rs                # Tauri 命令注册
│       ├── config.rs             # 配置管理（含 symlink_path）
│       ├── symlink.rs            # 符号链接操作（symlink + junction 降级）
│       ├── version.rs            # 版本解析
│       ├── error.rs              # 错误类型
│       ├── download.rs           # 下载 + SHA-256 校验
│       ├── extract.rs            # zip 解压
│       ├── jdk.rs                # JDK 安装/卸载/切换逻辑
│       ├── setup.rs              # 首次引导逻辑（环境检测 + 初始化）
│       └── provider/
│           ├── mod.rs             # JdkProvider trait
│           ├── adoptium.rs
│           ├── zulu.rs
│           └── corretto.rs
├── src/                          # 前端源码
│   ├── index.html                # 主页面
│   ├── setup.html                # 引导页
│   ├── settings.html             # 设置页
│   ├── styles.css                # TailwindCSS 样式
│   └── app.js                    # 前端逻辑
└── tailwind.config.js
```

**用户数据目录** (`~/.nova/`):
```
~/.nova/
├── config.toml              # 配置文件（含 setup_done 标记）
├── current                  # 符号链接（或用户自定义路径处的 symlink）
├── versions/
│   ├── 21.0.11/
│   │   ├── bin/
│   │   ├── lib/
│   │   └── ...
│   └── 17.0.19/
└── cache/
    └── corretto-21.0.11.zip
```

## 配置文件

**`~/.nova/config.toml`**：
```toml
[jvm]
# 首次引导是否完成
setup_done = true

# JDK 安装目录，默认 ~/.nova/versions
# versions_dir = "D:\\Java\\versions"

# 符号链接路径，默认 ~/.nova/current
# symlink_path = "D:\\Java\\current"

# 默认下载源: "corretto" | "adoptium" | "zulu"
default_source = "corretto"
```

## Tauri 命令（前后端通信）

```rust
/// 检查是否需要引导（首次启动）
#[tauri::command]
fn is_setup_needed() -> Result<bool, String>;

/// 完成引导设置，创建目录结构和符号链接
#[tauri::command]
fn complete_setup(config: SetupConfig) -> Result<(), String>;

/// 检测系统 JAVA_HOME 是否指向当前符号链接路径
#[tauri::command]
fn check_java_home() -> Result<JavaHomeStatus, String>;

/// 列出已安装的 JDK 版本
#[tauri::command]
fn list_versions() -> Result<Vec<JdkEntry>, String>;

/// 获取当前正在使用的版本
#[tauri::command]
fn current_version() -> Result<Option<String>, String>;

/// 安装指定版本的 JDK
#[tauri::command]
async fn install_version(version: String, source: String) -> Result<(), String>;

/// 从本地路径导入 JDK
#[tauri::command]
fn import_jdk(path: String) -> Result<String, String>;

/// 切换到指定版本（更新符号链接）
#[tauri::command]
fn use_version(version: String) -> Result<(), String>;

/// 卸载指定版本
#[tauri::command]
fn uninstall_version(version: String) -> Result<(), String>;

/// 列出远程可用版本
#[tauri::command]
fn list_remote_versions(source: String) -> Result<Vec<String>, String>;

/// 更新设置（下载源、符号链接路径等）
#[tauri::command]
fn update_config(config: ConfigUpdate) -> Result<(), String>;

/// 获取当前配置
#[tauri::command]
fn get_config() -> Result<Config, String>;
```

**关键数据结构**：
```rust
/// 引导页配置
struct SetupConfig {
    versions_dir: Option<String>,   // 自定义 JDK 存储目录
    symlink_path: Option<String>,   // 自定义符号链接路径
}

/// JAVA_HOME 状态检测
struct JavaHomeStatus {
    java_home: Option<String>,      // 当前 JAVA_HOME 值
    points_to_symlink: bool,        // 是否指向符号链接路径
    symlink_path: String,           // 符号链接实际路径
}

/// JDK 版本条目
struct JdkEntry {
    version: String,
    provider: String,
    is_current: bool,
    install_path: String,
}
```

前端通过 `invoke("install_version", { version: "21", source: "corretto" })` 调用后端。

## 依赖

**Rust 后端** (`src-tauri/Cargo.toml`):
```toml
[dependencies]
tauri = { version = "2", features = ["devtools"] }
tauri-plugin-dialog = "2"    # 文件选择对话框
tauri-plugin-shell = "2"     # 可选：打开终端
reqwest = { version = "0.12", features = ["blocking", "json", "rustls-tls"], default-features = false }
tokio = { version = "1", features = ["rt-multi-thread", "fs"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
dirs = "6"
zip = "2"
sha2 = "0.10"
anyhow = "1"
thiserror = "2"
```

**前端** (`package.json`):
```json
{
  "devDependencies": {
    "tailwindcss": "^4",
    "@tailwindcss/cli": "^4"
  }
}
```

不使用 React/Vue 等框架，纯 HTML + TailwindCSS + 原生 JS，保持轻量。

## 实现步骤

### Phase 1：项目初始化 + 引导页 + 界面骨架
1. `npm create tauri-app@latest` 初始化项目（Vanilla JS 模板）
2. 配置 TailwindCSS
3. `error.rs` + `config.rs` + `version.rs`
4. `setup.rs` — 引导页后端逻辑
   - 检测是否首次启动
   - 创建 `~/.nova/` 目录结构
   - 创建初始符号链接（支持自定义路径）
   - 标记 `setup_done`
5. `symlink.rs` — 符号链接操作
   - symlink 创建/删除/更新
   - Windows Junction 降级逻辑
   - 自定义路径支持
6. 实现引导页 HTML（步骤 1-3：存储位置 → 符号链接 → 环境变量）
7. 实现主界面 HTML（工具栏 + 表格 + 状态栏 + JAVA_HOME 提醒条）
8. 深色主题样式

### Phase 2：Rust 后端业务逻辑
9. `provider/mod.rs` — JdkProvider trait
10. `provider/corretto.rs` — **Corretto API（默认源，最先实现）**
11. `download.rs` — HTTP 下载 + 校验
12. `extract.rs` — zip 解压
13. `jdk.rs` — 核心 CRUD 逻辑（切换版本时更新符号链接）

### Phase 3：前后端联调
14. 注册 Tauri 命令（`is_setup_needed`, `complete_setup`, `check_java_home`, `list_versions` 等）
15. 引导页 JS → 调用 `complete_setup`，检测 `check_java_home` 状态
16. 主界面 JS → 调用后端命令，渲染版本列表
17. 安装弹窗（远程 + 本地）
18. 切换/卸载操作（带确认提示）
19. 下载进度事件推送（`app.emit("download-progress", ...)`）

### Phase 4：设置页 + 扩展
20. 设置页 HTML（存储目录、符号链接路径、下载源、环境变量参考）
21. Adoptium + Zulu 源
22. 错误提示 toast
23. 空状态引导页
24. 应用图标 + 打包 `tauri build`

## 跨平台适配（预留）

| 平台 | 符号链接 | Webview | 环境变量配置 |
|------|---------|---------|-------------|
| Windows | symlink / Junction 降级 | WebView2（系统自带） | `setx` / 注册表 |
| macOS | `std::os::unix::fs::symlink` | WebKit（系统自带） | `~/.zshrc` / `~/.bashrc` |
| Linux | `std::os::unix::fs::symlink` | WebKitGTK（需安装） | `~/.bashrc` / `~/.profile` |

仅 `symlink.rs` 需要 `#[cfg]` 分支，其余代码完全平台无关。

## 验证方式

1. 首次启动 → 显示引导页 → 完成设置 → 目录结构创建正确
2. 引导页中自定义符号链接路径 → 符号链接在指定位置创建
3. 复制环境变量命令到终端执行 → `echo %JAVA_HOME%` 输出正确路径
4. `cargo tauri dev` — 开发模式启动，主界面渲染正常
5. 点击"安装新版本" → 输入 21 → 下载解压成功 → 列表刷新
6. 点击"切换" → 符号链接指向正确 → `%JAVA_HOME%\bin\java -version` 验证
7. 点击"卸载" → 版本目录删除 → 列表更新
8. 点击"本地导入" → 选择本地 JDK → 导入成功
9. 设置页修改符号链接路径 → 旧链接删除，新链接创建 → `JAVA_HOME` 参考命令更新
10. `cargo tauri build` — 生成 release exe，检查包体积
