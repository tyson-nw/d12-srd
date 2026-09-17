'use strict';

var child_process = require('child_process');
var path = require('path');
var obsidian = require('obsidian');
var fs = require('fs');
var os = require('os');

const buildNotePrompt = (settings, notePath) => {
    if (!settings.enableNoteContext || !notePath)
        return undefined;
    const path$1 = settings.openAtCurrentNoteFolder ? path.posix.basename(notePath) : notePath;
    return `${settings.promptPrefix}${path$1}${settings.promptSuffix}`;
};
const promptArguments = (tool, prompt) => {
    if (prompt === undefined)
        return [];
    if (tool === 'gemini')
        return [`--prompt-interactive=${prompt}`];
    if (tool === 'copilot')
        return [`--interactive=${prompt}`];
    if (tool === 'opencode')
        return [`--prompt=${prompt}`];
    // End option parsing so user-entered prefixes cannot become CLI flags.
    return ['--', prompt];
};

// Data is quoted for the shell that actually consumes it, never for the host OS.
const quotePosix = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
// PowerShell treats several Unicode quotation marks as string delimiters.
// Encode data so none of those characters can become script syntax.
const quotePowerShell = (value) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`;
const getPlatformSummary = () => {
    if (!obsidian.Platform.isDesktopApp)
        return 'mobile';
    return obsidian.Platform.isMacOS ? 'desktop-macos' : obsidian.Platform.isWin ? 'desktop-windows' : 'desktop-linux';
};
const actionCommands = (action) => {
    var _a, _b;
    if (action.kind === 'tool')
        return [[action.executable, ...((_a = action.args) !== null && _a !== void 0 ? _a : [])]];
    if (action.action === 'pull')
        return [['git', 'pull']];
    return [['git', 'add', '.'], ['git', 'commit', '-m', ((_b = action.message) === null || _b === void 0 ? void 0 : _b.trim()) || 'update'], ['git', 'push']];
};
const posixScript = (cwd, action) => {
    const lines = [`cd -- ${quotePosix(cwd)} || exit 1`];
    if (action)
        lines.push(actionCommands(action).map(args => args.map(quotePosix).join(' ')).join(' && '));
    lines.push('exec "${SHELL:-/bin/sh}"');
    return lines.join('\n');
};
const tempScript = (content, filename = 'launch.command') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-in-terminal-'));
    const path$1 = path.join(dir, filename);
    try {
        fs.writeFileSync(path$1, content, { mode: 0o700 });
    }
    catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { path: path$1, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const buildMacLaunch = (app, cwd, action, options) => {
    const args = [(options === null || options === void 0 ? void 0 : options.reuseExistingMacApp) === false ? '-na' : '-a', app];
    if (!action)
        return { executable: 'open', args: [...args, cwd], cwd };
    const script = tempScript('#!/bin/bash -l\n' + posixScript(cwd, action) + '\n');
    return { executable: 'open', args: [...args, script.path], cwd, cleanup: script.cleanup };
};
// Start-Process accepts a command-line string, not an argv array. Apply Windows
// argv quoting before embedding that string as a literal in the encoded script.
const quoteWindowsArg = (value) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');
// Bypass PowerShell 5.1's lossy native argv serialization. Known npm shims
// are resolved to their package bin and run with node, without cmd.exe.
const nativePowerShell = (executable, args) => {
    const packages = {
        claude: '@anthropic-ai/claude-code', codex: '@openai/codex',
        gemini: '@google/gemini-cli', opencode: 'opencode-ai', copilot: '@github/copilot'
    };
    const packageName = packages[executable];
    const lines = [
        `$resolved = (Get-Command -Name ${quotePowerShell(executable)} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`,
        `$arguments = ${quotePowerShell(args.map(quoteWindowsArg).join(' '))}`,
        "if ([IO.Path]::GetExtension($resolved) -in @('.cmd', '.bat')) {"
    ];
    if (packageName) {
        lines.push(`$packageFile = Join-Path (Split-Path $resolved) ${quotePowerShell('node_modules/' + packageName + '/package.json')}`, "if (!(Test-Path -LiteralPath $packageFile)) { throw 'Cannot resolve this CLI shim. Install a native CLI executable or use WSL.' }", '$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json', `$bin = if ($package.bin -is [string]) { $package.bin } else { $package.bin.${executable} }`, "if (!$bin) { throw 'The CLI package has no matching executable.' }", '$entry = [IO.Path]::GetFullPath((Join-Path (Split-Path $packageFile) $bin))', 
        // Windows file paths cannot contain quotes; double trailing slashes are
        // irrelevant because the resolved entry is a file, not a directory.
        '$arguments = \'"\' + $entry + \'" \' + $arguments', "$localNode = Join-Path (Split-Path $resolved) 'node.exe'", "$resolved = if (Test-Path -LiteralPath $localNode) { $localNode } else { (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }");
    }
    else {
        lines.push("throw 'Batch command shims are unsupported. Use a native executable or WSL.'");
    }
    lines.push('}', '$info = New-Object System.Diagnostics.ProcessStartInfo', '$info.FileName = $resolved', '$info.Arguments = $arguments', '$info.WorkingDirectory = (Get-Location).Path', '$info.UseShellExecute = $false', '$process = [System.Diagnostics.Process]::Start($info)', '$process.WaitForExit()', '$toolExitCode = $process.ExitCode', '$process.Dispose()', 'if ($toolExitCode -ne 0) { return }');
    return lines.join('\n');
};
const powerShellScript = (cwd, action) => {
    const lines = [`$ErrorActionPreference = 'Stop'`, `Set-Location -LiteralPath ${quotePowerShell(cwd)}`];
    if (action)
        for (const [executable, ...args] of actionCommands(action))
            lines.push(nativePowerShell(executable, args));
    return lines.join('\n');
};
const resolveWslPath = (cwd) => {
    const normalized = cwd.replace(/\\/g, '/');
    const unc = normalized.match(/^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i);
    if (unc)
        return { distro: unc[1], path: unc[2] || '/' };
    const drive = normalized.match(/^([a-z]):\/(.*)$/i);
    if (drive)
        return { path: `/mnt/${drive[1].toLowerCase()}/${drive[2]}` };
    return null;
};
const buildWindowsLaunch = (app, cwd, action, options) => {
    var _a;
    let script;
    if (options === null || options === void 0 ? void 0 : options.useWslOnWindows) {
        const wsl = resolveWslPath(cwd);
        if (!wsl)
            return null;
        // wsl.exe's --exec receives bash and its arguments directly. A login shell
        // finds CLI tools installed only in the distribution's user environment.
        const args = [...(wsl.distro ? ['--distribution', wsl.distro] : []), '--cd', wsl.path, '--exec', 'bash', '-lc', posixScript(wsl.path, action)];
        script = `$ErrorActionPreference = 'Stop'\n` + nativePowerShell('wsl.exe', args);
    }
    else {
        script = powerShellScript(cwd, action);
    }
    const file = tempScript('\uFEFF' + script, 'launch.ps1');
    const encoded = encodePowerShell('& ' + quotePowerShell(file.path));
    const shellArgs = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const name = (_a = app.replace(/\\/g, '/').split('/').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    let executable = app;
    let args;
    if (name === 'powershell' || name === 'powershell.exe' || name === 'pwsh' || name === 'pwsh.exe') {
        args = shellArgs;
    }
    else if (name === 'wt' || name === 'wt.exe') {
        args = ['new-tab', 'powershell.exe', ...shellArgs];
    }
    else if (name === 'tabby' || name === 'tabby.exe') {
        args = ['run', 'powershell.exe', ...shellArgs];
    }
    else if (name === 'cmd' || name === 'cmd.exe') {
        args = ['/d', '/k', `powershell.exe -ExecutionPolicy Bypass -EncodedCommand ${encoded}`];
    }
    else if (!action && !(options === null || options === void 0 ? void 0 : options.useWslOnWindows)) {
        args = [];
    }
    else {
        executable = 'cmd.exe';
        args = ['/d', '/k', `powershell.exe -ExecutionPolicy Bypass -EncodedCommand ${encoded}`];
    }
    const start = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath ${quotePowerShell(executable)}` +
        (args.length ? ` -ArgumentList ${quotePowerShell(args.map(quoteWindowsArg).join(' '))}` : '') +
        ((options === null || options === void 0 ? void 0 : options.useWslOnWindows) ? '' : ` -WorkingDirectory ${quotePowerShell(cwd)}`);
    return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(start)], cwd: (options === null || options === void 0 ? void 0 : options.useWslOnWindows) ? os.tmpdir() : cwd, cleanup: file.cleanup };
};
const buildLaunchCommand = (terminalApp, cwd, action, options) => {
    const app = terminalApp.trim();
    if (!obsidian.Platform.isDesktopApp || !app)
        return null;
    if (obsidian.Platform.isMacOS)
        return buildMacLaunch(app, cwd, action, options);
    if (obsidian.Platform.isWin)
        return buildWindowsLaunch(app, cwd, action, options);
    // Explicitly set the directory even for a terminal-only launch: terminal
    // server processes may otherwise reuse an unrelated working directory.
    const args = [app.includes('gnome-terminal') ? '--' : '-e', 'bash', '-lc', posixScript(cwd, action)];
    return { executable: app, args, cwd };
};
const buildGitProbe = (cwd, useWsl) => {
    if (obsidian.Platform.isWin && useWsl) {
        const wsl = resolveWslPath(cwd);
        if (!wsl)
            return null;
        return { executable: 'wsl.exe', args: [...(wsl.distro ? ['--distribution', wsl.distro] : []), '--cd', wsl.path, '--exec', 'git', 'rev-parse', '--is-inside-work-tree'], cwd: os.tmpdir() };
    }
    return { executable: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd };
};

const logger = {
    enabled: false,
    setEnabled(value) {
        this.enabled = value;
    },
    log(...args) {
        if (this.enabled) {
            console.debug('[open-in-terminal]', ...args);
        }
    }
};

const defaultTerminalApp = () => {
    if (!obsidian.Platform.isDesktopApp) {
        return '';
    }
    if (obsidian.Platform.isMacOS) {
        return 'Terminal';
    }
    if (obsidian.Platform.isWin) {
        return 'cmd.exe';
    }
    if (obsidian.Platform.isLinux) {
        return 'x-terminal-emulator';
    }
    return '';
};
const getCurrentDesktopPlatform = () => {
    if (!obsidian.Platform.isDesktopApp) {
        return null;
    }
    if (obsidian.Platform.isMacOS) {
        return 'macos';
    }
    if (obsidian.Platform.isWin) {
        return 'win';
    }
    if (obsidian.Platform.isLinux) {
        return 'linux';
    }
    return null;
};
const buildDefaultTerminalAppSetting = () => {
    const platform = getCurrentDesktopPlatform();
    const app = defaultTerminalApp();
    if (!platform) {
        return {};
    }
    return { [platform]: app };
};
const DEFAULT_SETTINGS = {
    terminalApp: buildDefaultTerminalAppSetting(),
    openAtCurrentNoteFolder: false,
    enableNoteContext: false,
    promptPrefix: 'Read ',
    promptSuffix: '. If there are todos, propose a plan to handle them one at a time.',
    reuseExistingMacApp: true,
    enableClaude: false,
    enableCodex: false,
    enableCopilot: false,
    enableCursor: false,
    enableGemini: false,
    enableOpencode: false,
    enableWslOnWindows: false,
    enableGitCommitPush: false,
    enableGitPull: false,
    defaultCommitMessage: 'update'
};
const isRecord = (value) => typeof value === 'object' && value !== null;
const normalizeTerminalAppSetting = (value, fallback) => {
    const platform = getCurrentDesktopPlatform();
    if (typeof value === 'string') {
        if (!platform) {
            return { ...fallback };
        }
        return { [platform]: value.trim() };
    }
    if (isRecord(value)) {
        const next = {};
        if (typeof value.win === 'string') {
            next.win = value.win.trim();
        }
        if (typeof value.macos === 'string') {
            next.macos = value.macos.trim();
        }
        if (typeof value.linux === 'string') {
            next.linux = value.linux.trim();
        }
        return next;
    }
    return { ...fallback };
};
const readBoolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const normalizeSettings = (stored) => {
    const source = isRecord(stored) ? stored : {};
    return {
        enableNoteContext: readBoolean(source.enableNoteContext, DEFAULT_SETTINGS.enableNoteContext),
        promptPrefix: typeof source.promptPrefix === 'string' ? source.promptPrefix : DEFAULT_SETTINGS.promptPrefix,
        promptSuffix: typeof source.promptSuffix === 'string' ? source.promptSuffix : DEFAULT_SETTINGS.promptSuffix,
        terminalApp: normalizeTerminalAppSetting(source.terminalApp, DEFAULT_SETTINGS.terminalApp),
        openAtCurrentNoteFolder: readBoolean(source.openAtCurrentNoteFolder, DEFAULT_SETTINGS.openAtCurrentNoteFolder),
        reuseExistingMacApp: readBoolean(source.reuseExistingMacApp, DEFAULT_SETTINGS.reuseExistingMacApp),
        enableClaude: readBoolean(source.enableClaude, DEFAULT_SETTINGS.enableClaude),
        enableCodex: readBoolean(source.enableCodex, DEFAULT_SETTINGS.enableCodex),
        enableCopilot: readBoolean(source.enableCopilot, DEFAULT_SETTINGS.enableCopilot),
        enableCursor: readBoolean(source.enableCursor, DEFAULT_SETTINGS.enableCursor),
        enableGemini: readBoolean(source.enableGemini, DEFAULT_SETTINGS.enableGemini),
        enableOpencode: readBoolean(source.enableOpencode, DEFAULT_SETTINGS.enableOpencode),
        enableWslOnWindows: readBoolean(source.enableWslOnWindows, DEFAULT_SETTINGS.enableWslOnWindows),
        enableGitCommitPush: readBoolean(source.enableGitCommitPush, DEFAULT_SETTINGS.enableGitCommitPush),
        enableGitPull: readBoolean(source.enableGitPull, DEFAULT_SETTINGS.enableGitPull),
        defaultCommitMessage: typeof source.defaultCommitMessage === 'string'
            ? source.defaultCommitMessage
            : DEFAULT_SETTINGS.defaultCommitMessage
    };
};
const getCurrentTerminalApp = (terminalApp) => {
    var _a;
    const platform = getCurrentDesktopPlatform();
    if (!platform) {
        return '';
    }
    return ((_a = terminalApp[platform]) === null || _a === void 0 ? void 0 : _a.trim()) || defaultTerminalApp();
};
const setCurrentTerminalApp = (terminalApp, value) => {
    const platform = getCurrentDesktopPlatform();
    if (!platform) {
        return { ...terminalApp };
    }
    return {
        ...terminalApp,
        [platform]: value.trim()
    };
};

const optionalLaunchTargets = [
    {
        id: 'open-claude',
        commandName: 'Open in Claude Code',
        action: 'terminal',
        toolCommand: 'claude',
        settingKey: 'enableClaude',
        settingLabel: 'Claude Code'
    },
    {
        id: 'open-codex',
        commandName: 'Open in Codex cli',
        action: 'terminal',
        toolCommand: 'codex',
        settingKey: 'enableCodex',
        settingLabel: 'Codex cli'
    },
    {
        id: 'open-copilot',
        commandName: 'Open in GitHub Copilot',
        action: 'terminal',
        toolCommand: 'copilot',
        settingKey: 'enableCopilot',
        settingLabel: 'GitHub Copilot'
    },
    {
        id: 'open-cursor',
        commandName: 'Open in Cursor cli',
        action: 'terminal',
        toolCommand: 'agent',
        settingKey: 'enableCursor',
        settingLabel: 'Cursor cli'
    },
    {
        id: 'open-gemini',
        commandName: 'Open in Gemini cli',
        action: 'terminal',
        toolCommand: 'gemini',
        settingKey: 'enableGemini',
        settingLabel: 'Gemini cli'
    },
    {
        id: 'open-opencode',
        commandName: 'Open in OpenCode',
        action: 'terminal',
        toolCommand: 'opencode',
        settingKey: 'enableOpencode',
        settingLabel: 'OpenCode'
    },
    {
        id: 'git-commit-push',
        commandName: 'Git: commit and push',
        action: 'git',
        gitAction: 'commit-push',
        settingKey: 'enableGitCommitPush',
        settingLabel: 'Git: commit and push'
    },
    {
        id: 'git-pull',
        commandName: 'Git: pull',
        action: 'git',
        gitAction: 'pull',
        settingKey: 'enableGitPull',
        settingLabel: 'Git: pull'
    }
];
const launchTargets = [
    {
        id: 'open-terminal',
        commandName: 'Open in terminal',
        action: 'terminal'
    },
    ...optionalLaunchTargets
];
const isTargetEnabled = (settings, target) => {
    if (!target.settingKey) {
        return true;
    }
    return settings[target.settingKey];
};

class OpenInTerminalSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    updatePreview() {
        var _a, _b, _c;
        const settings = this.plugin.pluginSettings;
        const note = (_a = this.app.workspace.getActiveFile()) === null || _a === void 0 ? void 0 : _a.path;
        (_b = this.preview) === null || _b === void 0 ? void 0 : _b.setDesc((_c = buildNotePrompt(settings, note)) !== null && _c !== void 0 ? _c : (settings.enableNoteContext ? 'Open a note to preview its prompt.' : 'Note context is disabled.'));
    }
    getSettingDefinitions() {
        const settings = this.plugin.pluginSettings;
        const toggle = (name, desc, key) => ({
            name, desc, render: row => {
                row.addToggle(control => control.setValue(settings[key]).onChange(async (value) => {
                    settings[key] = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));
            }
        });
        const definitions = [{
                name: 'Terminal application',
                desc: 'Enter an app name or executable path, without command-line arguments. Leave blank to use the default for this device.',
                render: row => {
                    row.addText(control => control.setPlaceholder(defaultTerminalApp()).setValue(getCurrentTerminalApp(settings.terminalApp)).onChange(async (value) => {
                        settings.terminalApp = setCurrentTerminalApp(settings.terminalApp, value);
                        await this.plugin.saveSettings();
                    }));
                }
            }, toggle("Open at current note's folder", 'Use the active note folder; fall back to the vault root when no note is open.', 'openAtCurrentNoteFolder')];
        if (obsidian.Platform.isMacOS)
            definitions.push(toggle('Reuse existing terminal instance', 'Open a new window in the running app instead of a separate application instance.', 'reuseExistingMacApp'));
        if (obsidian.Platform.isWin)
            definitions.push(toggle('Use WSL for commands', 'Run CLI tools and Git inside WSL on Windows.', 'enableWslOnWindows'));
        definitions.push(toggle('Include current note in prompt', 'Start an interactive CLI session with the current note path and your instructions. The CLI may begin responding immediately.', 'enableNoteContext'));
        for (const [key, name] of [['promptPrefix', 'Prompt prefix'], ['promptSuffix', 'Prompt suffix']]) {
            definitions.push({ name, desc: 'Whitespace is preserved exactly.', render: row => {
                    row.addTextArea(control => control.setValue(settings[key]).onChange(async (value) => {
                        settings[key] = value;
                        await this.plugin.saveSettings();
                        this.updatePreview();
                    }));
                } });
        }
        definitions.push({ name: 'Prompt preview', render: row => { this.preview = row; this.updatePreview(); } });
        definitions.push({ name: 'Default commit message', desc: 'Used by Git: commit and push.', render: row => {
                row.addText(control => control.setValue(settings.defaultCommitMessage).onChange(async (value) => {
                    settings.defaultCommitMessage = value.trim() || 'update';
                    await this.plugin.saveSettings();
                }));
            } });
        for (const target of optionalLaunchTargets) {
            definitions.push({ name: `Enable ${target.settingLabel}`, desc: `Show “${target.commandName}” in the command palette.`, render: row => {
                    row.addToggle(control => control.setValue(settings[target.settingKey]).onChange(async (value) => {
                        settings[target.settingKey] = value;
                        await this.plugin.saveSettings();
                    }));
                } });
        }
        return definitions;
    }
    display() {
        this.containerEl.empty();
        for (const definition of this.getSettingDefinitions()) {
            const row = new obsidian.Setting(this.containerEl).setName(definition.name);
            if (definition.desc)
                row.setDesc(definition.desc);
            definition.render(row);
        }
    }
    hide() { this.preview = undefined; }
}

const TEMP_SCRIPT_CLEANUP_DELAY_MS = 30000;
class OpenInTerminalPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.registeredCommandIds = new Set();
        this.pluginSettings = { ...DEFAULT_SETTINGS };
    }
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new OpenInTerminalSettingTab(this.app, this));
        this.refreshCommands();
    }
    refreshCommands() {
        for (const target of launchTargets) {
            if (this.registeredCommandIds.has(target.id))
                continue;
            this.addCommand({
                id: target.id,
                name: target.commandName,
                checkCallback: (checking) => {
                    if (!isTargetEnabled(this.pluginSettings, target))
                        return false;
                    if (checking)
                        return true;
                    if (target.action === 'git') {
                        if (target.gitAction === 'commit-push')
                            void this.runGitCommitPush();
                        else
                            void this.runGitPull();
                    }
                    else {
                        this.runLaunchCommand(() => {
                            var _a;
                            const prompt = buildNotePrompt(this.pluginSettings, (_a = this.app.workspace.getActiveFile()) === null || _a === void 0 ? void 0 : _a.path);
                            const action = target.toolCommand
                                ? { kind: 'tool', executable: target.toolCommand, args: promptArguments(target.toolCommand, prompt) }
                                : undefined;
                            return this.composeLaunchCommand(action);
                        }, target.commandName);
                    }
                    return true;
                }
            });
            this.registeredCommandIds.add(target.id);
        }
    }
    composeLaunchCommand(action, useVaultRoot = false) {
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof obsidian.FileSystemAdapter)) {
            return null;
        }
        const vaultPath = adapter.getBasePath();
        const launchPath = useVaultRoot ? vaultPath : this.getLaunchPath(vaultPath);
        const terminalApp = getCurrentTerminalApp(this.pluginSettings.terminalApp);
        const launchCommand = buildLaunchCommand(terminalApp, launchPath, action, {
            useWslOnWindows: this.pluginSettings.enableWslOnWindows,
            reuseExistingMacApp: this.pluginSettings.reuseExistingMacApp
        });
        logger.log('Compose launch command', {
            platform: getPlatformSummary(),
            terminalApp,
            action,
            vaultPath,
            launchPath,
            launchCommand
        });
        return launchCommand;
    }
    getLaunchPath(vaultPath) {
        var _a;
        if (!this.pluginSettings.openAtCurrentNoteFolder) {
            return vaultPath;
        }
        const activeFile = this.app.workspace.getActiveFile();
        const folderPath = (_a = activeFile === null || activeFile === void 0 ? void 0 : activeFile.parent) === null || _a === void 0 ? void 0 : _a.path;
        return folderPath ? path.join(vaultPath, folderPath) : vaultPath;
    }
    runLaunchCommand(buildCommand, label) {
        let launchCommand;
        try {
            launchCommand = buildCommand();
        }
        catch (error) {
            console.error('[open-in-terminal] Failed to prepare launch', error);
            new obsidian.Notice(`Failed to prepare ${label}. Check the developer console for details.`);
            return;
        }
        if (!launchCommand) {
            new obsidian.Notice(`Unable to run ${label}. Check the open in terminal settings for the terminal application name.`);
            return;
        }
        this.executeShellCommand(launchCommand, label);
    }
    executeShellCommand(launchCommand, label) {
        var _a;
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof obsidian.FileSystemAdapter)) {
            new obsidian.Notice('File system adapter not available. This plugin works only on desktop.');
            return;
        }
        const vaultPath = adapter.getBasePath();
        const workingDirectory = (_a = launchCommand.cwd) !== null && _a !== void 0 ? _a : vaultPath;
        try {
            logger.log('Spawning command', {
                label,
                executable: launchCommand.executable,
                vaultPath,
                workingDirectory
            });
            const child = child_process.spawn(launchCommand.executable, launchCommand.args, {
                cwd: workingDirectory,
                shell: false,
                detached: true,
                stdio: 'ignore'
            });
            child.on('error', (error) => {
                console.error(`[open-in-terminal] Failed to run '${launchCommand.executable}':`, error);
                new obsidian.Notice(`Failed to run ${label}. Check the developer console for details.`);
            });
            child.on('exit', (code) => {
                if (code !== null && code !== 0) {
                    new obsidian.Notice(`Failed to run ${label} (exit ${code}). Check the terminal application setting.`);
                }
            });
            child.unref();
            logger.log('Spawned command successfully', { label });
        }
        catch (error) {
            console.error(`[open-in-terminal] Unexpected error for '${launchCommand.executable}':`, error);
            new obsidian.Notice(`Failed to run ${label}. Check the developer console for details.`);
        }
        finally {
            if (launchCommand.cleanup) {
                const cleanup = launchCommand.cleanup;
                window.setTimeout(() => {
                    try {
                        cleanup();
                    }
                    catch (error) {
                        console.warn('[open-in-terminal] Cleanup after command failed', error);
                    }
                }, TEMP_SCRIPT_CLEANUP_DELAY_MS);
            }
        }
    }
    async loadSettings() {
        this.pluginSettings = normalizeSettings(await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.pluginSettings);
        this.refreshCommands();
    }
    async runGitCommitPush() {
        const isGitRepo = await this.checkGitRepo();
        if (!isGitRepo) {
            new obsidian.Notice('Not a Git repository');
            return;
        }
        const gitCommand = { kind: 'git', action: 'commit-push', message: this.pluginSettings.defaultCommitMessage };
        this.runLaunchCommand(() => this.composeLaunchCommand(gitCommand, true), 'Git: commit and push');
    }
    async runGitPull() {
        const isGitRepo = await this.checkGitRepo();
        if (!isGitRepo) {
            new obsidian.Notice('Not a Git repository');
            return;
        }
        this.runLaunchCommand(() => this.composeLaunchCommand({ kind: 'git', action: 'pull' }, true), 'Git: pull');
    }
    async checkGitRepo() {
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof obsidian.FileSystemAdapter)) {
            return false;
        }
        const vaultPath = adapter.getBasePath();
        const probe = buildGitProbe(vaultPath, this.pluginSettings.enableWslOnWindows);
        if (!probe)
            return false;
        return new Promise((resolve) => {
            const child = child_process.spawn(probe.executable, probe.args, {
                cwd: probe.cwd,
                stdio: 'ignore'
            });
            child.on('close', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
        });
    }
}

module.exports = OpenInTerminalPlugin;
//# sourceMappingURL=main.js.map

/* nosourcemap */