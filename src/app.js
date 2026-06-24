const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

// ─── DOM refs ──────────────────────────────────────────────────

const $setupView = document.getElementById('setup-view');
const $mainView = document.getElementById('main-view');
const $settingsView = document.getElementById('settings-view');
const $versionList = document.getElementById('version-list');
const $emptyState = document.getElementById('empty-state');
const $statusText = document.getElementById('status-text');
const $currentVersion = document.getElementById('current-version-text');
const $javaHomeWarning = document.getElementById('java-home-warning');
const $installModal = document.getElementById('install-modal');
const $progressBar = document.getElementById('progress-bar');
const $progressText = document.getElementById('progress-text');
const $installProgress = document.getElementById('install-progress');
const $installError = document.getElementById('install-error');
const $toast = document.getElementById('toast');
const $remoteVersionList = document.getElementById('remote-version-list');
const $remoteEmptyState = document.getElementById('remote-empty-state');
const $remoteStatus = document.getElementById('remote-status');
const $remoteMajor = document.getElementById('remote-major');
const $downloadIndicator = document.getElementById('download-indicator');
const $downloadProgressRing = document.getElementById('download-progress-ring');
const $downloadProgressText = document.getElementById('download-progress-text');
const $downloadTaskCount = document.getElementById('download-task-count');
const $installModalContent = document.getElementById('install-modal-content');
const $modalResizeHandle = document.getElementById('modal-resize-handle');
const $moduleJdk = document.getElementById('module-jdk');
const $moduleMaven = document.getElementById('module-maven');
const $toolTitle = document.getElementById('tool-title');
const $toolDescription = document.getElementById('tool-description');
const $tableProviderHeading = document.getElementById('table-provider-heading');
const $installModalSubtitle = document.getElementById('install-modal-subtitle');
const $mavenRemoteNote = document.getElementById('maven-remote-note');
const $mavenEnvCommand = document.getElementById('settings-maven-env-cmd');
const $homeConfigButton = document.getElementById('btn-configure-java-home');
const $systemHomeConfigButton = document.getElementById('btn-configure-system-home');
const $homeWarningText = $javaHomeWarning?.querySelector('span');

// ─── State ─────────────────────────────────────────────────────

let _currentView = 'setup'; // 'setup' | 'main' | 'settings'
let _activeTool = 'jdk'; // 'jdk' | 'maven'
let _remoteListTimer = null;
let _installedNames = new Set();
let _remoteVersions = [];
let _showingDownloadsOnly = false;
const _downloadTasks = new Map();
let _lastRenderedDownloadState = '';
let _unlistenDownloadProgress = null;

// 弹框缩放状态
let _isResizing = false;
let _resizeStartX = 0;
let _resizeStartY = 0;
let _resizeStartWidth = 0;
let _resizeStartHeight = 0;

// ─── Init ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  bindEvents();
  // Clean up timer on page unload to prevent memory leaks
  window.addEventListener('beforeunload', () => {
    if (_remoteListTimer) {
      clearTimeout(_remoteListTimer);
      _remoteListTimer = null;
    }
  });
});

async function initApp() {
  try {
    const needed = await invoke('is_setup_needed');
    if (needed) {
      showView('setup');
    } else {
      showView('main');
    }
  } catch (e) {
    console.error('init error:', e);
    showToast('初始化失败: ' + e, 'error');
  }
}

// ─── View Switching ────────────────────────────────────────────

function showView(name) {
  $setupView.classList.add('hidden');
  $mainView.classList.add('hidden');
  $settingsView.classList.add('hidden');

  switch (name) {
    case 'setup':
      $setupView.classList.remove('hidden');
      initSetupDefaults();
      break;
    case 'main':
      $mainView.classList.remove('hidden');
      refreshVersions();
      checkActiveHome();
      break;
    case 'settings':
      $settingsView.classList.remove('hidden');
      loadSettings();
      break;
  }
  _currentView = name;
}

// ─── Setup View ────────────────────────────────────────────────

async function initSetupDefaults() {
  const paths = await getDefaultJvmPaths();
  document.getElementById('setup-versions-dir').value = paths.versions_dir;
  document.getElementById('default-symlink-path').textContent = paths.symlink_path;
  updateEnvCommands(paths.symlink_path);
}

async function getDefaultHome() {
  try {
    return await invoke('get_home_dir');
  } catch (_) {
    return 'C:\\Users\\User';
  }
}

async function getDefaultJvmPaths() {
  try {
    return await invoke('get_default_jvm_paths');
  } catch (_) {
    const home = await getDefaultHome();
    return {
      versions_dir: home + '\\.nova\\versions',
      symlink_path: home + '\\.nova\\current',
    };
  }
}

function updateEnvCommands(symlinkPath) {
  const cmdLines = document.getElementById('env-cmd').querySelectorAll('.copy-line');
  cmdLines[0].textContent = `setx JAVA_HOME "${symlinkPath}"`;
  cmdLines[0].dataset.copy = cmdLines[0].textContent;
  cmdLines[1].textContent = `setx PATH "%PATH%;%JAVA_HOME%\\bin"`;
  cmdLines[1].dataset.copy = cmdLines[1].textContent;

  const psLines = document.getElementById('env-powershell').querySelectorAll('.copy-line');
  psLines[0].textContent = `[System.Environment]::SetEnvironmentVariable("JAVA_HOME", "${symlinkPath}", "User")`;
  psLines[0].dataset.copy = psLines[0].textContent;
  psLines[1].textContent = `$oldPath = [System.Environment]::GetEnvironmentVariable("Path", "User"); [System.Environment]::SetEnvironmentVariable("Path", "$oldPath;${symlinkPath}\\bin", "User")`;
  psLines[1].dataset.copy = psLines[1].textContent;
}

// ─── Main View ─────────────────────────────────────────────────

function setActiveTool(tool) {
  if (_activeTool === tool) return;
  _activeTool = tool;
  _remoteVersions = [];
  _showingDownloadsOnly = false;
  updateModuleTabs();
  refreshVersions();
  if (!$installModal.classList.contains('hidden')) {
    closeInstallModal();
  }
}

function updateModuleTabs() {
  [
    [$moduleJdk, 'jdk'],
    [$moduleMaven, 'maven'],
  ].forEach(([button, tool]) => {
    if (!button) return;
    const active = tool === _activeTool;
    button.classList.toggle('is-active', active);
  });

  const isMaven = _activeTool === 'maven';
  if ($toolTitle) $toolTitle.textContent = isMaven ? 'Maven 版本' : 'JDK 版本';
  if ($toolDescription) {
    $toolDescription.textContent = isMaven
      ? '管理 Maven 发行版、MAVEN_HOME 与 settings.xml'
      : '管理 JDK 发行版、JAVA_HOME 与下载源';
  }
  if ($tableProviderHeading) {
    $tableProviderHeading.textContent = isMaven ? '来源' : '发行版';
  }
  if ($homeConfigButton) {
    $homeConfigButton.textContent = isMaven ? '配置 MAVEN_HOME' : '配置 JAVA_HOME';
  }
  if ($systemHomeConfigButton) {
    $systemHomeConfigButton.textContent = isMaven ? '配置系统 MAVEN_HOME' : '配置系统 JAVA_HOME';
  }
  if ($homeWarningText) {
    $homeWarningText.textContent = isMaven
      ? 'MAVEN_HOME 尚未指向 Nova 管理路径'
      : 'JAVA_HOME 尚未指向 Nova 管理路径';
  }
}

async function refreshVersions() {
  try {
    updateModuleTabs();
    const versions = await invoke(_activeTool === 'maven' ? 'list_maven_versions' : 'list_versions');
    _installedNames = new Set(versions.map(v => v.version));
    renderVersionList(versions);
    renderRemoteVersionList(_remoteVersions);
    const current = versions.find(v => v.is_current);
    const toolLabel = _activeTool === 'maven' ? 'Maven' : 'JDK';
    $statusText.textContent = `${toolLabel} 已安装 ${versions.length} 个版本`;
    if (_activeTool === 'jdk') {
      const javaHomeStatus = await invoke('check_java_home').catch(() => null);
      $javaHomeWarning.classList.toggle('hidden', javaHomeStatus?.points_to_symlink !== false);
      const javaHome = javaHomeStatus?.java_home || javaHomeStatus?.symlink_path || '未配置';
      $currentVersion.textContent = current
        ? `当前 JDK: ${current.version} (${current.provider}) · JAVA_HOME: ${javaHome}`
        : `当前 JDK: 无 · JAVA_HOME: ${javaHome}`;
    } else {
      const mavenHomeStatus = await invoke('check_maven_home').catch(() => null);
      $javaHomeWarning.classList.toggle('hidden', mavenHomeStatus?.points_to_symlink !== false);
      const mavenHome = mavenHomeStatus?.maven_home || mavenHomeStatus?.symlink_path || current?.install_path || '未配置';
      $currentVersion.textContent = current
        ? `当前 Maven: ${current.version} · MAVEN_HOME: ${mavenHome}`
        : `当前 Maven: 无 · MAVEN_HOME: ${mavenHome}`;
    }
  } catch (e) {
    console.error('refresh error:', e);
    showToast('刷新失败: ' + e, 'error');
  }
}

function renderVersionList(versions) {
  $versionList.innerHTML = '';
  if (versions.length === 0) {
    document.getElementById('empty-state-title').textContent = `尚未安装任何 ${toolLabel()} 版本`;
    document.getElementById('empty-state-hint').textContent = '点击上方"安装新版本"开始';
    $emptyState.classList.remove('hidden');
    return;
  }
  $emptyState.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  versions.forEach(v => {
    const row = document.createElement('div');
    row.className = 'version-grid table-row';

    const versionCell = document.createElement('span');
    versionCell.className = 'mono';
    versionCell.textContent = v.version;

    const providerCell = document.createElement('span');
    providerCell.className = 'muted';
    providerCell.textContent = v.provider;

    const statusCell = document.createElement('span');
    statusCell.className = 'status-cell';
    if (v.is_current) {
      const dot = document.createElement('span');
      dot.className = 'status-dot ok';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 使用中'));
    } else {
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 已安装'));
    }

    const actionCell = document.createElement('span');
    actionCell.className = 'row-actions';

    if (!v.is_current) {
      const switchBtn = createButton('切换', 'btn-primary');
      switchBtn.addEventListener('click', () => switchVersion(v.version));
      actionCell.appendChild(switchBtn);
    }

    const uninstallBtn = createButton('卸载', 'btn-danger');
    uninstallBtn.addEventListener('click', () => uninstallVersion(v.version));
    actionCell.appendChild(uninstallBtn);

    row.append(versionCell, providerCell, statusCell, actionCell);
    fragment.appendChild(row);
  });
  $versionList.appendChild(fragment);
}

async function checkActiveHome() {
  try {
    const status = await invoke(_activeTool === 'maven' ? 'check_maven_home' : 'check_java_home');
    $javaHomeWarning.classList.toggle('hidden', status.points_to_symlink);
  } catch (_) {}
}

// Track latest load request to ignore stale responses
let _loadRequestSeq = 0;

async function loadRemoteVersions() {
  const thisSeq = ++_loadRequestSeq;

  if (_activeTool === 'maven') {
    $remoteStatus.textContent = '正在查询 Apache Maven 版本...';
    try {
      const versions = await invoke('list_remote_maven_versions');
      if (thisSeq !== _loadRequestSeq) return;
      _remoteVersions = versions.map(item => ({ ...item, source: 'apache' }));
      renderRemoteVersionList(_remoteVersions);
      $remoteStatus.textContent = `已加载 Apache Maven 的 ${versions.length} 个可下载版本`;
    } catch (e) {
      if (thisSeq !== _loadRequestSeq) return;
      _remoteVersions = [];
      renderRemoteVersionList(_remoteVersions);
      $remoteStatus.textContent = '加载失败';
      showToast('加载 Maven 版本失败: ' + e, 'error');
    }
    return;
  }

  const source = document.getElementById('install-source').value;
  const majorText = $remoteMajor.value.trim();
  const major = majorText === '' ? null : parseInt(majorText, 10);
  if (majorText !== '' && !Number.isFinite(major)) {
    $remoteStatus.textContent = '主版本号格式不正确';
    return;
  }

  $remoteStatus.textContent = `正在查询 ${sourceLabel(source)} ${major ?? '全部版本'}...`;
  try {
    const versions = await invoke('list_remote_versions', { source, major });
    if (thisSeq !== _loadRequestSeq) return;
    if (
      document.getElementById('install-source').value !== source ||
      $remoteMajor.value.trim() !== majorText
    ) {
      return;
    }

    _remoteVersions = versions.map(item => ({ ...item, source }));
    renderRemoteVersionList(_remoteVersions);
    $remoteStatus.textContent = major === null
      ? `已加载 ${sourceLabel(source)} 的 ${versions.length} 个可下载版本`
      : `已加载 ${sourceLabel(source)} ${major} 的 ${versions.length} 个可下载版本`;
  } catch (e) {
    if (thisSeq !== _loadRequestSeq) return;
    _remoteVersions = [];
    renderRemoteVersionList(_remoteVersions);
    $remoteStatus.textContent = '加载失败';
    showToast('加载可下载版本失败: ' + e, 'error');
  }
}

function renderRemoteVersionList(versions) {
  $remoteVersionList.innerHTML = '';
  if (_showingDownloadsOnly) {
    _lastRenderedDownloadState = versions.map(v => `${v.id}:${v.state}`).sort().join(',');
  }
  if (!versions.length) {
    $remoteEmptyState.classList.remove('hidden');
    return;
  }
  $remoteEmptyState.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  versions.forEach(item => {
    const installed = isRemoteInstalled(item.source, item.version);
    const task = _downloadTasks.get(downloadTaskId(item.source, item.version));
    const downloading = task?.state === 'downloading';
    const paused = task?.state === 'paused';
    const canceling = task?.state === 'canceling';
    const row = document.createElement('div');
    row.className = 'remote-grid table-row';

    const versionCell = document.createElement('span');
    versionCell.className = 'min-w-0';

    const versionText = document.createElement('span');
    versionText.className = 'mono';
    versionText.textContent = item.version;
    versionCell.appendChild(versionText);

    // Show download progress and speed for active downloads
    if (downloading || paused) {
      const progressText = document.createElement('span');
      progressText.className = 'tiny muted';
      progressText.dataset.taskProgress = task.id;
      progressText.textContent = `${task.percent}% · ${task.speed || '计算中...'}`;
      versionCell.appendChild(progressText);
    }

    const providerCell = document.createElement('span');
    providerCell.className = 'muted';
    providerCell.textContent = sourceLabel(item.source);

    const sizeCell = document.createElement('span');
    sizeCell.className = 'muted';
    sizeCell.textContent = item.size ? formatBytes(item.size) : '-';

    const statusCell = document.createElement('span');
    statusCell.className = 'status-cell';
    const dot = document.createElement('span');
    if (canceling) {
      dot.className = 'status-dot warn';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 取消中'));
    } else if (paused) {
      dot.className = 'status-dot warn';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 已暂停'));
    } else if (downloading) {
      dot.className = 'status-dot active';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 下载中'));
    } else if (installed) {
      dot.className = 'status-dot ok';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 已安装'));
    } else {
      dot.className = 'status-dot';
      statusCell.appendChild(dot);
      statusCell.appendChild(document.createTextNode(' 可下载'));
    }

    const actionCell = document.createElement('span');
    if (downloading || task?.state === 'paused' || task?.state === 'canceling') {
      actionCell.className = 'row-actions';
      const toggleBtn = createButton(task.state === 'paused' ? '继续' : '暂停', 'btn-secondary');
      toggleBtn.disabled = task.state === 'canceling';
      toggleBtn.dataset.downloadTaskId = task.id;
      toggleBtn.addEventListener('click', () => task.state === 'paused' ? resumeDownload(task.id) : pauseDownload(task.id));

      const cancelBtn = createButton('取消', 'btn-danger');
      cancelBtn.disabled = task.state === 'canceling';
      cancelBtn.dataset.downloadTaskId = task.id;
      cancelBtn.addEventListener('click', () => cancelDownload(task.id));
      actionCell.append(toggleBtn, cancelBtn);
    } else {
      const button = createButton(installed ? '已安装' : '下载', installed
        ? 'btn-secondary'
        : 'btn-primary');
      button.disabled = installed;
      button.dataset.downloadVersion = item.version;
      button.dataset.downloadTaskId = downloadTaskId(item.source, item.version);
      button.addEventListener('click', () => installRemote(item.version, item.source, item.url));
      actionCell.appendChild(button);
    }

    row.append(versionCell, providerCell, sizeCell, statusCell, actionCell);
    fragment.appendChild(row);
  });
  $remoteVersionList.appendChild(fragment);
}

function isRemoteInstalled(source, version) {
  return _installedNames.has(`${source}-${version}`) || _installedNames.has(version);
}

// ─── Settings View ─────────────────────────────────────────────

async function loadSettings() {
  try {
    const config = await invoke('get_config');
    const paths = await getDefaultJvmPaths();

    // Versions dir
    document.getElementById('settings-versions-dir').value =
      config.jvm.versions_dir || paths.versions_dir;

    // Symlink mode
    const isCustom = !!config.jvm.symlink_path;
    const defaultRadio = document.querySelector('input[name="settings-symlink-mode"][value="default"]');
    const customRadio = document.querySelector('input[name="settings-symlink-mode"][value="custom"]');

    if (isCustom) {
      customRadio.checked = true;
      document.getElementById('settings-symlink-path').value = config.jvm.symlink_path;
    } else {
      defaultRadio.checked = true;
    }

    document.getElementById('settings-default-symlink').textContent = paths.symlink_path;
    document.getElementById('settings-custom-symlink-row').classList.toggle('hidden', !isCustom);

    // Symlink status
    const symlinkPath = config.jvm.symlink_path || paths.symlink_path;
    const javaHomeStatus = await invoke('check_java_home');
    const statusEl = document.getElementById('settings-symlink-status');
    if (javaHomeStatus.points_to_symlink) {
      statusEl.textContent = '✅ 符号链接正常';
      statusEl.className = 'hint-ok';
    } else {
      statusEl.textContent = '⚠️ 符号链接未指向正确路径';
      statusEl.className = 'hint-ok';
    }

    // Env reference
    document.getElementById('settings-env-symlink').textContent = symlinkPath;
    document.getElementById('settings-env-cmd').textContent = `setx JAVA_HOME "${symlinkPath}"`;

    // Default source
    document.getElementById('settings-default-source').value = config.jvm.default_source || 'corretto';

    // Maven paths
    const mavenPaths = await invoke('get_default_maven_paths');
    document.getElementById('settings-maven-versions-dir').value =
      config.maven?.versions_dir || mavenPaths.versions_dir;
    const mavenIsCustom = !!config.maven?.symlink_path;
    document.querySelector('input[name="settings-maven-symlink-mode"][value="custom"]').checked = mavenIsCustom;
    document.querySelector('input[name="settings-maven-symlink-mode"][value="default"]').checked = !mavenIsCustom;
    document.getElementById('settings-maven-symlink-path').value = config.maven?.symlink_path || '';
    document.getElementById('settings-maven-default-symlink').textContent = mavenPaths.symlink_path;
    document.getElementById('settings-maven-custom-symlink-row').classList.toggle('hidden', !mavenIsCustom);
    updateMavenEnvCommand();

    const mavenSettings = await invoke('load_maven_settings');
    document.getElementById('settings-maven-settings-path').value =
      mavenSettings.settings_path || mavenPaths.settings_path;
    document.getElementById('settings-maven-local-repo').value =
      mavenSettings.local_repository || '';
    renderMirrorRows(mavenSettings.mirrors || []);
  } catch (e) {
    showToast('加载设置失败: ' + e, 'error');
  }
}

async function saveSettings(options = {}) {
  const { stay = false, quiet = false } = options;
  try {
    const config = await invoke('get_config');
    const paths = await getDefaultJvmPaths();
    const oldVersionsDir = config.jvm.versions_dir || paths.versions_dir;

    config.jvm.versions_dir = document.getElementById('settings-versions-dir').value || null;
    if (normalizePathText(config.jvm.versions_dir) === normalizePathText(paths.versions_dir)) {
      config.jvm.versions_dir = null;
    }

    const symlinkMode = document.querySelector('input[name="settings-symlink-mode"]:checked').value;
    if (symlinkMode === 'custom') {
      config.jvm.symlink_path = document.getElementById('settings-symlink-path').value || null;
    } else {
      config.jvm.symlink_path = null;
    }

    config.jvm.default_source = document.getElementById('settings-default-source').value;

    config.maven = config.maven || {};
    const mavenPaths = await invoke('get_default_maven_paths');
    const oldMavenVersionsDir = config.maven.versions_dir || mavenPaths.versions_dir;
    config.maven.versions_dir = document.getElementById('settings-maven-versions-dir').value || null;
    if (normalizePathText(config.maven.versions_dir) === normalizePathText(mavenPaths.versions_dir)) {
      config.maven.versions_dir = null;
    }

    const mavenSymlinkMode = document.querySelector('input[name="settings-maven-symlink-mode"]:checked').value;
    if (mavenSymlinkMode === 'custom') {
      config.maven.symlink_path = document.getElementById('settings-maven-symlink-path').value || null;
    } else {
      config.maven.symlink_path = null;
    }

    config.maven.settings_path = document.getElementById('settings-maven-settings-path').value || null;
    config.maven.local_repository = document.getElementById('settings-maven-local-repo').value || null;
    config.maven.mirrors = collectMirrorRows();

    const newVersionsDir = config.jvm.versions_dir || paths.versions_dir;
    const migrateVersions = normalizePathText(oldVersionsDir) !== normalizePathText(newVersionsDir)
      ? confirm('安装目录已变更，是否迁移所有已安装的 JDK 文件？')
      : false;
    const newMavenVersionsDir = config.maven.versions_dir || mavenPaths.versions_dir;
    const migrateMavenVersions = normalizePathText(oldMavenVersionsDir) !== normalizePathText(newMavenVersionsDir)
      ? confirm('Maven 安装目录已变更，是否迁移所有已安装的 Maven 文件？')
      : false;

    await invoke('update_tool_config', {
      newConfig: config,
      migrateJvmVersions: migrateVersions,
      migrateMavenVersions,
    });
    await invoke('save_maven_settings', {
      settings: {
        settings_path: config.maven.settings_path || mavenPaths.settings_path,
        local_repository: config.maven.local_repository,
        mirrors: config.maven.mirrors,
        raw_content: '',
      },
    });
    if (!quiet) {
      showToast('设置已保存', 'success');
    }
    if (stay) {
      await loadSettings();
    } else {
      showView('main');
    }
    return true;
  } catch (e) {
    showToast('保存失败: ' + e, 'error');
    return false;
  }
}

function normalizePathText(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function updateMavenEnvCommand() {
  if (!$mavenEnvCommand) return;
  const mode = document.querySelector('input[name="settings-maven-symlink-mode"]:checked')?.value;
  const defaultPath = document.getElementById('settings-maven-default-symlink')?.textContent || '';
  const customPath = document.getElementById('settings-maven-symlink-path')?.value || '';
  const mavenHome = mode === 'custom' ? (customPath || defaultPath) : defaultPath;
  $mavenEnvCommand.textContent = `setx MAVEN_HOME "${mavenHome}"`;
}

// ─── Actions ───────────────────────────────────────────────────

async function switchVersion(version) {
  try {
    await invoke(_activeTool === 'maven' ? 'use_maven_version' : 'use_version', { version });
    showToast(`已切换到 ${toolLabel()} ${version}`, 'success');
    await refreshVersions();
  } catch (e) {
    showToast('切换失败: ' + e, 'error');
  }
}

async function uninstallVersion(version) {
  if (!confirm(`确定要卸载 ${toolLabel()} ${version} 吗？`)) return;
  try {
    await invoke(_activeTool === 'maven' ? 'uninstall_maven_version' : 'uninstall_version', { version });
    showToast(`已卸载 ${toolLabel()} ${version}`, 'success');
    await refreshVersions();
  } catch (e) {
    showToast('卸载失败: ' + e, 'error');
  }
}

async function installRemote(version, source, url = '') {
  const tool = _activeTool;
  const label = tool === 'maven' ? 'Maven' : 'JDK';
  if (!version || !source) {
    showToast(`请选择要安装的 ${label} 版本`, 'error');
    return;
  }

  const taskSource = tool === 'maven' ? 'apache' : source;
  const id = downloadTaskId(taskSource, version);
  if (_downloadTasks.get(id)?.state === 'downloading' || isRemoteInstalled(source, version)) {
    return;
  }

  _downloadTasks.set(id, {
    id,
    source: taskSource,
    version,
    url,
    percent: 0,
    status: '准备下载...',
    state: 'downloading',
    speed: '0 B/s',
    speedBytes: 0,
  });
  $installError.classList.add('hidden');
  $installProgress.classList.remove('hidden');
  updateDownloadUi();
  renderRemoteVersionList(currentRemoteRows());

  const command = tool === 'maven' ? 'install_maven_version' : 'install_version';
  const args = tool === 'maven' ? { version } : { version, source };
  invoke(command, args)
    .then(async (installedVersion) => {
      const task = _downloadTasks.get(id);
      if (task) {
        task.percent = 100;
        task.status = '安装完成';
        task.state = 'done';
      }
      showToast(`${label} ${installedVersion} 安装成功`, 'success');
      await refreshVersions();
      if (!$installModal.classList.contains('hidden')) {
        await loadRemoteVersions();
      }
      if (tool === _activeTool) {
        await checkActiveHome();
      }
      _downloadTasks.delete(id);
      updateDownloadUi();
      renderRemoteVersionList(currentRemoteRows());
    })
    .catch((e) => {
      const task = _downloadTasks.get(id);
      const cancelled = task?.state === 'canceling' || String(e).includes('download cancelled');
      if (cancelled) {
        _downloadTasks.delete(id);
        showToast(`已取消 ${label} ${version} 下载`, 'warning');
        updateDownloadUi();
        renderRemoteVersionList(currentRemoteRows());
        return;
      }
      if (task) {
        task.state = 'error';
        task.status = String(e);
      }
      $installError.textContent = e;
      $installError.classList.remove('hidden');
      $installProgress.classList.add('hidden');
      showToast('下载失败: ' + e, 'error');
      updateDownloadUi();
      renderRemoteVersionList(currentRemoteRows());
    });
}

async function pauseDownload(taskId) {
  await invoke('pause_download', { taskId });
  const task = _downloadTasks.get(taskId);
  if (task) {
    task.state = 'paused';
    task.status = '已暂停';
  }
  updateDownloadUi();
  renderRemoteVersionList(currentRemoteRows());
}

async function resumeDownload(taskId) {
  await invoke('resume_download', { taskId });
  const task = _downloadTasks.get(taskId);
  if (task) {
    task.state = 'downloading';
    task.status = '下载中';
  }
  updateDownloadUi();
  renderRemoteVersionList(currentRemoteRows());
}

async function cancelDownload(taskId) {
  const task = _downloadTasks.get(taskId);
  if (task) {
    task.state = 'canceling';
    task.status = '取消中';
  }
  updateDownloadUi();
  renderRemoteVersionList(currentRemoteRows());
  await invoke('cancel_download', { taskId });
}

async function importLocal() {
  const path = document.getElementById('import-path').value.trim();
  if (!path) { showToast('请选择本地路径', 'error'); return; }

  $installError.classList.add('hidden');
  try {
    const result = await invoke(_activeTool === 'maven' ? 'import_maven' : 'import_jdk', { path });
    showToast(`导入成功: ${toolLabel()} ${result}`, 'success');
    closeInstallModal();
    await refreshVersions();
    await checkActiveHome();
  } catch (e) {
    $installError.textContent = e;
    $installError.classList.remove('hidden');
  }
}

async function configureJavaHome() {
  try {
    const status = await invoke('configure_java_home');
    if (_activeTool === 'jdk') {
      $javaHomeWarning.classList.toggle('hidden', status.points_to_symlink);
    }
    if (_currentView === 'settings') {
      await loadSettings();
    }
    showToast('JAVA_HOME 已配置', 'success');
  } catch (e) {
    showToast('配置 JAVA_HOME 失败: ' + e, 'error');
  }
}

async function configureMavenHome() {
  try {
    if (_currentView === 'settings') {
      const saved = await saveSettings({ stay: true, quiet: true });
      if (!saved) return;
    }
    const status = await invoke('configure_maven_home');
    if (_activeTool === 'maven') {
      $javaHomeWarning.classList.toggle('hidden', status.points_to_symlink);
    }
    if (_currentView === 'settings') {
      await loadSettings();
    }
    showToast('MAVEN_HOME 已配置', 'success');
  } catch (e) {
    showToast('配置 MAVEN_HOME 失败: ' + e, 'error');
  }
}

async function configureSystemJavaHome() {
  try {
    if (!(await ensureSystemEnvPermission())) return;
    const status = await invoke('configure_system_java_home');
    if (_activeTool === 'jdk') {
      $javaHomeWarning.classList.toggle('hidden', status.points_to_symlink);
    }
    if (_currentView === 'settings') {
      await loadSettings();
    }
    showToast('系统 JAVA_HOME 已配置', 'success');
  } catch (e) {
    showToast('配置系统 JAVA_HOME 失败: ' + e, 'error');
  }
}

async function configureSystemMavenHome() {
  try {
    if (!(await ensureSystemEnvPermission())) return;
    if (_currentView === 'settings') {
      const saved = await saveSettings({ stay: true, quiet: true });
      if (!saved) return;
    }
    const status = await invoke('configure_system_maven_home');
    if (_activeTool === 'maven') {
      $javaHomeWarning.classList.toggle('hidden', status.points_to_symlink);
    }
    if (_currentView === 'settings') {
      await loadSettings();
    }
    showToast('系统 MAVEN_HOME 已配置', 'success');
  } catch (e) {
    showToast('配置系统 MAVEN_HOME 失败: ' + e, 'error');
  }
}

async function ensureSystemEnvPermission() {
  const canConfigure = await invoke('can_configure_system_env').catch(() => false);
  if (!canConfigure) {
    showToast('配置系统环境变量需要以管理员身份启动 Nova', 'warning');
    return false;
  }
  return true;
}

async function configureActiveHome() {
  if (_activeTool === 'maven') {
    await configureMavenHome();
  } else {
    await configureJavaHome();
  }
}

async function configureActiveSystemHome() {
  if (_activeTool === 'maven') {
    await configureSystemMavenHome();
  } else {
    await configureSystemJavaHome();
  }
}

async function completeSetup() {
  const versionsDir = document.getElementById('setup-versions-dir').value;
  const symlinkMode = document.querySelector('input[name="symlink-mode"]:checked').value;
  const customSymlink = document.getElementById('setup-symlink-path').value;

  try {
    const paths = await getDefaultJvmPaths();
    const config = {
      versions_dir: normalizePathText(versionsDir) === normalizePathText(paths.versions_dir) ? null : (versionsDir || null),
      symlink_path: symlinkMode === 'custom' ? (customSymlink || null) : null,
    };
    await invoke('complete_setup', { config });
    showToast('设置完成！', 'success');
    showView('main');
  } catch (e) {
    showToast('设置失败: ' + e, 'error');
  }
}

// ─── Event Bindings ────────────────────────────────────────────

function bindEvents() {
  // Setup
  on('btn-complete-setup', 'click', completeSetup);
  on('btn-browse-versions', 'click', () => browseFolder('setup-versions-dir'));
  on('btn-browse-symlink', 'click', () => browseFolder('setup-symlink-path'));

  document.querySelectorAll('input[name="symlink-mode"]').forEach(r => {
    r.addEventListener('change', (e) => {
      document.getElementById('custom-symlink-row').classList.toggle('hidden', e.target.value !== 'custom');
      updateSetupEnvCommands();
    });
  });

  // Env tab switcher (setup page)
  document.querySelectorAll('.env-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.env-tab').forEach(t => {
        t.classList.remove('is-active');
      });
      e.target.classList.add('is-active');
      document.querySelectorAll('.env-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`env-${e.target.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Copy env commands
  document.querySelectorAll('.copy-line').forEach(line => {
    line.addEventListener('click', () => {
      navigator.clipboard.writeText(line.dataset.copy).then(() => showToast('已复制到剪贴板', 'success'));
    });
  });

  // Main view
  on('module-jdk', 'click', () => setActiveTool('jdk'));
  on('module-maven', 'click', () => setActiveTool('maven'));
  on('btn-install', 'click', () => openInstallModal('install'));
  on('btn-import', 'click', () => openInstallModal('import'));
  on('btn-refresh', 'click', () => refreshVersions());
  on('btn-configure-java-home', 'click', configureActiveHome);
  on('btn-configure-system-home', 'click', configureActiveSystemHome);
  on('btn-warning-configure-java-home', 'click', (e) => {
    e.stopPropagation();
    configureActiveHome();
  });
  on('btn-load-remote', 'click', loadRemoteVersions);
  on('download-indicator', 'click', () => openInstallModal('downloads'));
  on('btn-settings', 'click', () => showView('settings'));
  on('btn-close-modal', 'click', closeInstallModal);
  on('btn-import-local', 'click', importLocal);
  on('btn-browse-dir', 'click', browseDirForImport);
  on('btn-browse-file', 'click', browseFileForImport);

  const installSourceSelect = document.getElementById('install-source');
  installSourceSelect?.addEventListener('change', async (e) => {
    await saveDefaultSource(e.target.value);
    await loadRemoteVersions();
  });
  $remoteMajor?.addEventListener('input', scheduleRemoteVersions);

  // Modal backdrop click to close
  $installModal.addEventListener('click', (e) => {
    if (e.target === $installModal) closeInstallModal();
  });

  // 弹框缩放 - handle mousedown
  $modalResizeHandle?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    _isResizing = true;
    _resizeStartX = e.clientX;
    _resizeStartY = e.clientY;
    _resizeStartWidth = $installModalContent.offsetWidth;
    _resizeStartHeight = $installModalContent.offsetHeight;
    document.body.style.userSelect = 'none'; // 防止拖拽时选中文字
  });

  // 弹框缩放 - mousemove 和 mouseup
  document.addEventListener('mousemove', (e) => {
    if (!_isResizing) return;

    const deltaX = e.clientX - _resizeStartX;
    const deltaY = e.clientY - _resizeStartY;

    const newWidth = Math.max(640, _resizeStartWidth + deltaX); // 最小宽度 640px
    const newHeight = Math.max(400, _resizeStartHeight + deltaY); // 最小高度 400px

    $installModalContent.style.width = newWidth + 'px';
    $installModalContent.style.height = newHeight + 'px';
    $installModalContent.style.maxWidth = 'none'; // 移除最大宽度限制
  });

  document.addEventListener('mouseup', () => {
    if (_isResizing) {
      _isResizing = false;
      document.body.style.userSelect = '';
    }
  });

  // JAVA_HOME warning -> open settings
  $javaHomeWarning?.addEventListener('click', () => showView('settings'));

  // Settings
  on('btn-settings-back', 'click', () => showView('main'));
  on('btn-save-settings', 'click', saveSettings);
  on('btn-settings-browse-versions', 'click', () => browseFolder('settings-versions-dir'));
  on('btn-settings-browse-symlink', 'click', () => browseFolder('settings-symlink-path'));
  on('btn-settings-browse-maven-versions', 'click', () => browseFolder('settings-maven-versions-dir'));
  on('btn-settings-browse-maven-symlink', 'click', () => browseFolder('settings-maven-symlink-path'));
  on('btn-settings-browse-maven-settings', 'click', browseMavenSettingsFile);
  on('btn-settings-browse-maven-local-repo', 'click', () => browseFolder('settings-maven-local-repo'));
  on('btn-add-maven-mirror', 'click', () => addMirrorRow());
  on('btn-copy-env', 'click', () => {
    const cmd = document.getElementById('settings-env-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('已复制到剪贴板', 'success'));
  });
  on('btn-copy-maven-env', 'click', () => {
    const cmd = document.getElementById('settings-maven-env-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('已复制到剪贴板', 'success'));
  });
  on('btn-settings-configure-java-home', 'click', configureJavaHome);
  on('btn-settings-configure-system-java-home', 'click', configureSystemJavaHome);
  on('btn-settings-configure-maven-home', 'click', configureMavenHome);
  on('btn-settings-configure-system-maven-home', 'click', configureSystemMavenHome);

  document.querySelectorAll('input[name="settings-symlink-mode"]').forEach(r => {
    r.addEventListener('change', (e) => {
      document.getElementById('settings-custom-symlink-row').classList.toggle('hidden', e.target.value !== 'custom');
    });
  });

  document.querySelectorAll('input[name="settings-maven-symlink-mode"]').forEach(r => {
    r.addEventListener('change', (e) => {
      document.getElementById('settings-maven-custom-symlink-row').classList.toggle('hidden', e.target.value !== 'custom');
      updateMavenEnvCommand();
    });
  });
  document.getElementById('settings-maven-symlink-path')?.addEventListener('input', updateMavenEnvCommand);
}

// ─── Helpers ───────────────────────────────────────────────────

function on(id, event, fn) {
  document.getElementById(id)?.addEventListener(event, fn);
}

function createButton(text, classes) {
  const btn = document.createElement('button');
  btn.className = `btn ${classes}`;
  btn.textContent = text;
  return btn;
}

function toolLabel() {
  return _activeTool === 'maven' ? 'Maven' : 'JDK';
}

function sourceLabel(source) {
  return {
    apache: 'Apache',
    corretto: 'Corretto',
    adoptium: 'Adoptium',
    zulu: 'Zulu',
    tsinghua: 'Tsinghua',
  }[source] || source;
}

async function browseFolder(inputId) {
  try {
    const selected = await open({ directory: true });
    if (selected) {
      document.getElementById(inputId).value = selected;
      if (inputId === 'setup-symlink-path') updateSetupEnvCommands();
      if (inputId === 'settings-maven-symlink-path') updateMavenEnvCommand();
    }
  } catch (_) {}
}

async function browseMavenSettingsFile() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Maven settings.xml', extensions: ['xml'] }],
    });
    if (selected) {
      document.getElementById('settings-maven-settings-path').value = selected;
    }
  } catch (_) {}
}

async function browseDirForImport() {
  try {
    const selected = await open({ directory: true });
    if (selected) {
      document.getElementById('import-path').value = selected;
    }
  } catch (_) {}
}

async function browseFileForImport() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (selected) {
      document.getElementById('import-path').value = selected;
    }
  } catch (_) {}
}

function renderMirrorRows(mirrors) {
  const list = document.getElementById('settings-maven-mirror-list');
  list.innerHTML = '';
  if (!mirrors.length) {
    addMirrorRow();
    return;
  }
  mirrors.forEach(addMirrorRow);
}

function addMirrorRow(mirror = {}) {
  const list = document.getElementById('settings-maven-mirror-list');
  const row = document.createElement('div');
  row.className = 'mirror-row';
  row.innerHTML = `
    <input data-mirror-id type="text" placeholder="id" value="${escapeAttr(mirror.id || '')}" class="input" />
    <input data-mirror-name type="text" placeholder="名称" value="${escapeAttr(mirror.name || '')}" class="input" />
    <input data-mirror-url type="text" placeholder="https://..." value="${escapeAttr(mirror.url || '')}" class="input" />
    <input data-mirror-of type="text" placeholder="*" value="${escapeAttr(mirror.mirror_of || '*')}" class="input" />
    <button type="button" class="btn btn-danger">删除</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function collectMirrorRows() {
  return Array.from(document.querySelectorAll('#settings-maven-mirror-list > div'))
    .map(row => ({
      id: row.querySelector('[data-mirror-id]').value.trim(),
      name: row.querySelector('[data-mirror-name]').value.trim(),
      url: row.querySelector('[data-mirror-url]').value.trim(),
      mirror_of: row.querySelector('[data-mirror-of]').value.trim() || '*',
    }))
    .filter(mirror => mirror.id || mirror.url)
    .map(mirror => ({
      ...mirror,
      id: mirror.id || 'mirror',
      name: mirror.name || mirror.id || 'Mirror',
    }));
}

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function updateSetupEnvCommands() {
  const mode = document.querySelector('input[name="symlink-mode"]:checked')?.value;
  const paths = await getDefaultJvmPaths();
  const symlinkPath = mode === 'custom'
    ? (document.getElementById('setup-symlink-path').value || paths.symlink_path)
    : paths.symlink_path;
  updateEnvCommands(symlinkPath);
}

// ─── Modal ─────────────────────────────────────────────────────

function openInstallModal(mode = 'all') {
  $installModal.classList.remove('hidden');
  _showingDownloadsOnly = mode === 'downloads';
  _lastRenderedDownloadState = '';
  $installProgress.classList.toggle('hidden', activeDownloadTasks().length === 0);
  $installError.classList.add('hidden');
  document.getElementById('import-path').value = '';
  document.getElementById('remote-install-section').classList.toggle('hidden', mode === 'import');
  document.getElementById('local-import-section').classList.toggle('hidden', mode !== 'import');
  const isMaven = _activeTool === 'maven';
  document.getElementById('remote-query-controls').classList.toggle('hidden', mode === 'downloads' || isMaven);
  document.getElementById('install-source').classList.toggle('hidden', isMaven);
  $remoteMajor.classList.toggle('hidden', isMaven);
  $mavenRemoteNote?.classList.toggle('hidden', !isMaven || mode !== 'install');
  document.getElementById('install-modal-title').textContent = mode === 'import'
    ? `本地导入 ${toolLabel()}`
    : mode === 'downloads'
    ? '正在下载'
    : `安装 ${toolLabel()}`;
  if ($installModalSubtitle) {
    $installModalSubtitle.textContent = mode === 'import'
      ? `选择本地 ${toolLabel()} 目录或 ZIP。`
      : isMaven
      ? '从 Apache Maven 官方归档安装 Maven。'
      : '选择 JDK 下载源和版本。';
  }

  if (mode === 'downloads') {
    renderRemoteVersionList(activeDownloadTasks());
    $remoteStatus.textContent = activeDownloadTasks().length ? '正在下载的任务' : '暂无正在下载的任务';
    updateDownloadUi();
    $installProgress.classList.add('hidden');
  } else if (mode !== 'import') {
    _remoteVersions = [];
    renderRemoteVersionList(_remoteVersions);
    $remoteStatus.textContent = _activeTool === 'maven' ? '查询 Apache Maven 版本' : '选择下载源和主版本';
    if (_activeTool === 'maven') {
      loadRemoteVersions();
    } else {
      loadDefaultInstallSource().then(loadRemoteVersions);
    }
  }
}

function closeInstallModal() {
  $installModal.classList.add('hidden');
  _showingDownloadsOnly = false;
  _lastRenderedDownloadState = '';
  // Clear remote list timer when modal closes
  if (_remoteListTimer) {
    clearTimeout(_remoteListTimer);
    _remoteListTimer = null;
  }
}

function setProgress(percent, text) {
  $progressBar.style.width = percent + '%';
  $progressText.textContent = text || `${percent}%`;
}

function scheduleRemoteVersions() {
  clearTimeout(_remoteListTimer);
  _remoteListTimer = setTimeout(loadRemoteVersions, 300);
}

function downloadTaskId(source, version) {
  if (source === 'apache') {
    return `maven:${version}`;
  }
  return `${source}:${version}`;
}

function activeDownloadTasks() {
  return Array.from(_downloadTasks.values())
    .filter(task => ['downloading', 'paused', 'canceling'].includes(task.state));
}

function currentRemoteRows() {
  return _showingDownloadsOnly ? activeDownloadTasks() : _remoteVersions;
}

function updateDownloadUi() {
  const tasks = activeDownloadTasks();
  const total = tasks.length
    ? Math.round(tasks.reduce((sum, task) => sum + task.percent, 0) / tasks.length)
    : 0;

  $downloadIndicator.classList.toggle('hidden', tasks.length === 0);
  $downloadProgressRing.style.background = `conic-gradient(var(--accent) ${total * 3.6}deg, var(--surface-3) 0deg)`;
  $downloadTaskCount.textContent = `${tasks.length} 个任务`;
  const downloadingCount = tasks.filter(task => task.state === 'downloading').length;

  // Show speed in indicator when there's exactly one active downloading task
  const singleTaskSpeed = tasks.length === 1 && downloadingCount === 1
    ? tasks[0].speed
    : null;

  $downloadProgressText.textContent = tasks.length > 0
    ? `${downloadingCount > 0 ? '下载中' : '已暂停'} · ${total}%${singleTaskSpeed ? ' · ' + singleTaskSpeed : ''}`
    : '0%';

  if (tasks.length > 0 && !_showingDownloadsOnly) {
    $installProgress.classList.remove('hidden');
    setProgress(total, `${tasks.length} 个任务 · ${total}%${singleTaskSpeed ? ' · ' + singleTaskSpeed : ''}`);
  } else {
    $installProgress.classList.add('hidden');
  }

  document.querySelectorAll('[data-download-version][data-download-task-id]').forEach(button => {
    const task = _downloadTasks.get(button.dataset.downloadTaskId);
    if (task?.state === 'downloading') {
      button.textContent = `${task.percent}% · ${task.speed || '...'}`;
      button.disabled = true;
    }
  });

  // Update inline progress text in version list rows
  document.querySelectorAll('[data-task-progress]').forEach(el => {
    const task = _downloadTasks.get(el.dataset.taskProgress);
    if (task && (task.state === 'downloading' || task.state === 'paused')) {
      el.textContent = `${task.percent}% · ${task.speed || '计算中...'}`;
    }
  });

  if (_showingDownloadsOnly) {
    const tasks = activeDownloadTasks();
    const stateKey = tasks.map(t => `${t.id}:${t.state}`).sort().join(',');
    if (stateKey !== _lastRenderedDownloadState) {
      _lastRenderedDownloadState = stateKey;
      renderRemoteVersionList(tasks);
    }
  }
}

async function loadDefaultInstallSource() {
  try {
    const config = await invoke('get_config');
    document.getElementById('install-source').value = config.jvm.default_source || 'corretto';
  } catch (_) {}
}

async function saveDefaultSource(source) {
  try {
    const config = await invoke('get_config');
    config.jvm.default_source = source;
    await invoke('update_config', { newConfig: config });
  } catch (e) {
    console.error('save default source error:', e);
  }
}

// ─── Toast ─────────────────────────────────────────────────────

// Toast 样式配置：支持 success/error/warning/info 四种类型
const TOAST_STYLES = {
  success: { className: 'toast-success', icon: '✓' },
  error: { className: 'toast-error', icon: '!' },
  warning: { className: 'toast-warning', icon: '!' },
  info: { className: 'toast-info', icon: 'i' },
};

// Toast 显示时间常量 (毫秒)
const TOAST_DURATION_MS = 3000;

let _toastTimer = null;
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}
function showToast(message, type = 'info') {
  const style = TOAST_STYLES[type] || TOAST_STYLES.info;
  $toast.textContent = '';
  const iconSpan = document.createElement('span');
  iconSpan.textContent = style.icon;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  $toast.append(iconSpan, msgSpan);
  $toast.className = `toast ${style.className}`;
  $toast.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => $toast.classList.add('hidden'), TOAST_DURATION_MS);
}

// ─── Download Progress ─────────────────────────────────────────

_unlistenDownloadProgress = listen('download-progress', (event) => {
  const { task_id: taskId, percent, status, speed, speed_bytes, total_size, downloaded } = event.payload;
  const task = _downloadTasks.get(taskId);
  if (!task) {
    setProgress(percent, status);
    return;
  }

  task.percent = percent;
  task.status = status;
  task.speed = speed;
  task.speedBytes = speed_bytes;
  task.totalSize = total_size || 0;
  task.downloaded = downloaded || 0;
  updateDownloadUi();
});
