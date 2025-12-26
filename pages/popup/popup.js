const manifest = chrome.runtime.getManifest();
class ScriptFlowPopup {
    constructor() {
        this.currentTab = 'scripts';
        this.scripts = [];
        this.currentUrl = '';
        this.currentVersion = manifest.version;
        this.init();
    }

    async init() {
        await this.loadCurrentUrl();
        await this.loadScripts();
        await this.loadSettings();
        this.setupEventListeners();
        this.SetUpUserScriptImport();
        this.renderScripts();
        this.UpdateVersionBadge();
    }

    UpdateVersionBadge() {
        try {
            // literally copy n paste but i couildnt care less
            const badge = document.querySelector('.settings-footer p');
            if (badge && this.currentVersion) {
                badge.textContent = `v${this.currentVersion}`;
            }
        } catch (e) {
            console.warn('Could not update version badge:', e);
        }
    }

    async loadCurrentUrl() {
        try {
            const [tab] = await chrome.tabs.query({
                active: true,
                currentWindow: true
            });
            if (tab) {
                this.currentUrl = tab.url;
                const urlSpan = document.querySelector('#currentUrl span');
                if (urlSpan) {
                    urlSpan.textContent = this.currentUrl;
                }
            }
        } catch (error) {
            console.error('Failed to get current URL:', error);
            const urlSpan = document.querySelector('#currentUrl span');
            if (urlSpan) {
                urlSpan.textContent = 'Unable to load URL';
            }
        }
    }

    async loadScripts() {
        try {
            const result = await chrome.storage.local.get(['scripts']);
            this.scripts = result.scripts || [];
        } catch (error) {
            console.error('Failed to load scripts:', error);
            this.scripts = [];
        }
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'updateInterval',
                'executionDelay',
                'debugLogging',
                'memoryInspectorEnabled',
                'memoryInspectorPosition'
            ]);

            const updateInterval = document.getElementById('updateInterval');
            const executionDelay = document.getElementById('executionDelay');
            const debugLogging = document.getElementById('debugLogging');
            const memoryInspector = document.getElementById('memoryInspector');
            const memoryPosition = document.getElementById('memoryInspectorPosition');

            if (updateInterval) updateInterval.value = result.updateInterval || 'weekly';
            if (executionDelay) executionDelay.value = result.executionDelay || 0;
            if (debugLogging) debugLogging.checked = result.debugLogging || false;
            if (memoryInspector) memoryInspector.checked = result.memoryInspectorEnabled || false;
            if (memoryPosition) memoryPosition.value = result.memoryInspectorPosition || 'top-right';
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    openWorkspace() {
        chrome.tabs.create({
            url: chrome.runtime.getURL('pages/editor/editor.html') + '?workspace=true'
        });
    }

    setupEventListeners() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.currentTarget.dataset.tab;
                if (tabName) {
                    this.switchTab(tabName);
                }
            });
        });

        const workspaceBtn = document.getElementById('openWorkspaceBtn');
        if (workspaceBtn) {
            workspaceBtn.addEventListener('click', () => {
                this.openWorkspace();
            });
        }

        const addScriptBtn = document.getElementById('addScriptBtn');
        if (addScriptBtn) {
            addScriptBtn.addEventListener('click', () => {
                this.openEditor();
            });
        }

        const executeBtn = document.getElementById('executeBtn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => {
                this.executeConsoleScript();
            });
        }

        this.setupSettingsListeners();
    }

    async SetUpUserScriptImport() {
        const dropZone = document.getElementById('tmDropZone');
        const fileInput = document.getElementById('tmFileInput');
        if (!dropZone || !fileInput || !window.JSZip) return;

        const openPicker = () => fileInput.click();

        dropZone.addEventListener('click', openPicker);

        ['dragenter', 'dragover'].forEach(ev => {
            dropZone.addEventListener(ev, e => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('drag-over');
            });
        });

        ['dragleave', 'drop'].forEach(ev => {
            dropZone.addEventListener(ev, e => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('drag-over');
            });
        });

        dropZone.addEventListener('drop', e => {
            const file = e.dataTransfer.files[0];
            if (file) this.ImportUserScriptZip(file);
        });

        fileInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) this.ImportUserScriptZip(file);
        });
    }

    async ImportUserScriptZip(file) {
        try {
            this.showNotification('Importing UserScript backup...', 'info');

            const zipData = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(zipData);

            const groups = new Map();

            zip.forEach((path, entry) => {
                if (entry.dir) return;
                const name = path.split('/').pop();
                const base = name.replace(/\.(user\.js|options\.json|storage\.json)$/i, '');
                if (!groups.has(base)) groups.set(base, {});
                const g = groups.get(base);
                if (name.endsWith('.user.js')) g.user = entry;
                else if (name.endsWith('.options.json')) g.options = entry;
                else if (name.endsWith('.storage.json')) g.storage = entry;
            });

            const imported = [];

            for (const [base, g] of groups.entries()) {
                if (!g.user) continue;

                const code = await g.user.async('string');
                const optionsJson = g.options ? await g.options.async('string') : '{}';
                const storageJson = g.storage ? await g.storage.async('string') : '{}';

                let options, storage;
                try {
                    options = JSON.parse(optionsJson);
                } catch {
                    options = {};
                }
                try {
                    storage = JSON.parse(storageJson);
                } catch {
                    storage = {};
                }

                const script = this.ConvertZipUserJsToScriptFlow(base, code, options, storage);
                if (script) {
                    // @ts-ignore
                    await chrome.runtime.sendMessage({
                        action: 'saveScript',
                        script
                    });
                    imported.push(script);
                }
            }

            if (imported.length === 0) {
                this.showNotification('No valid userscripts found in ZIP.', 'error');
                return;
            }

            await this.loadScripts();
            this.renderScripts();
            this.showNotification(`Imported ${imported.length} script(s) from UserScript.`, 'success');
        } catch (e) {
            console.error('TM ZIP import failed', e);
            this.showNotification('Failed to import UserScript backup.', 'error');
        }
    }

    ConvertZipUserJsToScriptFlow(baseName, code, options, storage) {
        const meta = (function parseUserscriptMeta(source) {
            const result = {
                name: '',
                description: '',
                match: [],
                exclude: [],
                require: [],
                grant: [],
                'run-at': ''
            };
            const blockMatch = source.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
            if (!blockMatch) return result;
            const lines = blockMatch[1].split(/\r?\n/);
            for (const line of lines) {
                const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.+)\s*$/);
                if (!m) continue;
                const key = m[1];
                const val = m[2].trim();
                switch (key) {
                    case 'name':
                        result.name = val;
                        break;
                    case 'description':
                        result.description = val;
                        break;
                    case 'match':
                    case 'exclude':
                    case 'require':
                    case 'grant':
                        if (!Array.isArray(result[key])) result[key] = [];
                        result[key].push(val);
                        break;
                    case 'run-at':
                        result['run-at'] = val;
                        break;
                }
            }
            return result;
        })(code);

        const overrides = options?.override || {};
        let matches = meta.match.length ? meta.match : Array.isArray(overrides.orig_matches) && overrides.orig_matches.length ? overrides.orig_matches : ['*://*/*'];

        const allUrlPatterns = new Set([
            '*://*/*',
            'http://*/*',
            'https://*/*'
        ]);

        const hasAllUrls = matches.some(m => allUrlPatterns.has(m.trim()));
        if (hasAllUrls) {
            matches = ['all'];
        }

        const runAtRaw = meta['run-at'] || overrides.orig_run_at || 'document-idle';

        const script = {
            id: crypto.randomUUID ? crypto.randomUUID() : ('tm-' + Date.now().toString(36)),
            name: meta.name || baseName,
            description: meta.description || 'Imported from UserScript ZIP',
            type: 'single-file',
            code,
            matches,
            exclude: meta.exclude,
            grant: meta.grant,
            require: meta.require,
            runAt: runAtRaw,
            enabled: options?.enabled ?? true,
            createdAt: storage?.ts || Date.now(),
            lastModified: storage?.ts || Date.now(),
            sourceType: 'bundled'
        };

        return script;
    }

    setupSettingsListeners() {
        const updateInterval = document.getElementById('updateInterval');
        const executionDelay = document.getElementById('executionDelay');
        const debugLogging = document.getElementById('debugLogging');
        const memoryInspector = document.getElementById('memoryInspector');
        const memoryPosition = document.getElementById('memoryInspectorPosition');

        if (updateInterval) {
            updateInterval.addEventListener('change', async () => {
                try {
                    await chrome.storage.sync.set({
                        updateInterval: updateInterval.value
                    });
                    this.showNotification('Settings saved', 'success');
                } catch (error) {
                    console.error('Failed to save update interval:', error);
                    this.showNotification('Failed to save settings', 'error');
                }
            });
        }

        if (executionDelay) {
            executionDelay.addEventListener('input', async () => {
                try {
                    await chrome.storage.sync.set({
                        executionDelay: parseInt(executionDelay.value) || 0
                    });
                } catch (error) {
                    console.error('Failed to save execution delay:', error);
                }
            });

            executionDelay.addEventListener('change', () => {
                this.showNotification('Settings saved', 'success');
            });
        }

        if (debugLogging) {
            debugLogging.addEventListener('change', async () => {
                try {
                    await chrome.storage.sync.set({
                        debugLogging: debugLogging.checked
                    });
                    this.showNotification('Settings saved', 'success');
                } catch (error) {
                    console.error('Failed to save debug logging:', error);
                    this.showNotification('Failed to save settings', 'error');
                }
            });
        }

        if (memoryInspector) {
            memoryInspector.addEventListener('change', async () => {
                try {
                    await chrome.storage.sync.set({
                        memoryInspectorEnabled: memoryInspector.checked
                    });

                    await chrome.runtime.sendMessage({
                        action: 'syncScripts'
                    });

                    this.showNotification('Settings saved - Reload pages to apply', 'success');
                } catch (error) {
                    console.error('Failed to save memory inspector setting:', error);
                    this.showNotification('Failed to save settings', 'error');
                }
            });
        }

        if (memoryPosition) {
            memoryPosition.addEventListener('change', async () => {
                try {
                    await chrome.storage.sync.set({
                        memoryInspectorPosition: memoryPosition.value
                    });

                    await chrome.runtime.sendMessage({
                        action: 'syncScripts'
                    });

                    this.showNotification('Settings saved - Reload pages to apply', 'success');
                } catch (error) {
                    console.error('Failed to save position:', error);
                    this.showNotification('Failed to save settings', 'error');
                }
            });
        }
    }

    switchTab(tabName) {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
        });
        const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
        if (activeTab) {
            activeTab.classList.add('active');
        }

        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        const activeContent = document.getElementById(`${tabName}-tab`);
        if (activeContent) {
            activeContent.classList.add('active');
        }

        this.currentTab = tabName;
    }

    formatTimeSpent(totalSeconds) {
        if (!totalSeconds || totalSeconds === 0) {
            return '0m';
        }

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}h`;
        } else {
            return `${hours}h ${minutes}m`;
        }
    }

    renderScripts() {
        const container = document.getElementById('scriptsList');
        if (!container) return;

        if (this.scripts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No scripts yet</h3>
                    <p>Click "Add New Script" to create your first userscript and start customizing websites.</p>
                </div>
            `;
            return;
        }

        const sortedScripts = [...this.scripts].sort((a, b) => {
            if (a.enabled && !b.enabled) return -1;
            if (!a.enabled && b.enabled) return 1;

            const timeA = a.timeSpent || 0;
            const timeB = b.timeSpent || 0;
            return timeB - timeA;
        });

        container.innerHTML = sortedScripts.map(script => `
            <div class="script-item">
                <div class="script-header">
                    <div class="script-name">
                        ${script.type === 'multi-file' || script.type === 'tracked-project' 
                            ? '<i class="fas fa-folder" style="color: #6366f1"></i>' 
                            : '<i class="fas fa-file-code"></i>'}
                        ${this.escapeHtml(script.name)}
                    </div>
                    <button class="script-toggle ${script.enabled ? 'enabled' : ''}" data-id="${script.id}"></button>
                </div>
                <div class="script-info">
                    ${script.type === 'multi-file' || script.type === 'tracked-project' 
                        ? `Type: Project (${Object.keys(script.files || {}).length} files)<br>Entry: ${script.entryPoint}<br>` 
                        : 'Type: Single File<br>'}
                    Matches: ${script.matches ? script.matches.join(', ') : 'None'}<br>
                    Run At: ${script.runAt || 'document_idle'}<br>
                    Last modified: ${new Date(script.lastModified || Date.now()).toLocaleDateString()}<br>
                    <span style="color: #818cf8; font-weight: 600;">⏱ Time Spent: ${this.formatTimeSpent(script.timeSpent || 0)}</span>
                </div>
                <div class="script-actions">
                    ${script.type === 'multi-file' || script.type === 'tracked-project'
                        ? `<button class="btn btn-secondary" data-action="edit" data-id="${script.id}">Edit Project</button>`
                        : `<button class="btn btn-secondary" data-action="edit" data-id="${script.id}">Edit</button>`}
                    <button class="btn btn-primary" data-action="run" data-id="${script.id}">Run</button>
                    <button class="btn btn-danger" data-action="delete" data-id="${script.id}">Delete</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.script-toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => this.toggleScript(e.target.dataset.id));
        });

        container.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.target.closest('[data-action]').dataset.action;
                const id = e.target.closest('[data-id]').dataset.id;
                this.handleScriptAction(action, id);
            });
        });
    }

    async toggleScript(scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        script.enabled = !script.enabled;

        try {

            const response = await chrome.runtime.sendMessage({
                action: 'toggleScript',
                scriptId: scriptId,
                enabled: script.enabled
            });

            if (response?.success) {

                await chrome.storage.local.set({
                    scripts: this.scripts
                });
                this.renderScripts();

                const [tab] = await chrome.tabs.query({
                    active: true,
                    currentWindow: true
                });
                if (tab && tab.id &&
                    !tab.url.startsWith('chrome://') &&
                    !tab.url.startsWith('edge://') &&
                    !tab.url.startsWith('about:')) {
                    await chrome.tabs.reload(tab.id);
                }

                this.showNotification(`Script ${script.enabled ? 'enabled' : 'disabled'}`, 'success');
            } else {
                throw new Error('Background script toggle failed');
            }
        } catch (error) {
            console.error('Failed to toggle script:', error);
            this.showNotification('Failed to toggle script', 'error');
            script.enabled = !script.enabled;
            this.renderScripts();
        }
    }

    async handleScriptAction(action, scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        switch (action) {
            case 'edit':
                this.openEditor(script);
                break;
            case 'run':
                await this.runScript(script);
                break;
            case 'delete':
                if (confirm(`Delete script "${script.name}"?`)) {
                    await this.deleteScript(scriptId);
                }
                break;
        }
    }

    async runScript(script) {
        try {
            const [tab] = await chrome.tabs.query({
                active: true,
                currentWindow: true
            });
            if (!tab || !tab.id) {
                this.showNotification('No active tab found', 'error');
                return;
            }

            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') ||
                tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
                this.showNotification('Cannot run scripts on browser pages', 'error');
                return;
            }

            const response = await chrome.runtime.sendMessage({
                action: 'buildScriptCode',
                scriptId: script.id
            });

            if (!response || !response.code) {
                this.showNotification('Failed to build script code', 'error');
                return;
            }

            const settings = await chrome.storage.sync.get(['memoryInspectorEnabled']);
            const memoryInspectorEnabled = settings.memoryInspectorEnabled || false;

            const codeToExecute = response.code;

            await chrome.scripting.executeScript({
                target: {
                    tabId: tab.id
                },
                func: (code, memoryInspectorEnabled) => {

                    const displayMemory = async () => {
                        if (!memoryInspectorEnabled || !window.GM_getMemory) return;

                        try {
                            const memory = await window.GM_getMemory();
                            const kb = (memory.bytes / 1024).toFixed(2);
                            const mb = (memory.bytes / (1024 * 1024)).toFixed(2);
                            console.log(
                                `%c[ScriptFlow Memory] Userscript Memory Usage: ${kb} KB / ${mb} MB`,
                                'background: #34d399; color: black; padding: 2px 4px; border-radius: 2px; font-weight: bold;'
                            );
                        } catch (e) {
                            console.warn('[ScriptFlow Memory] Could not measure memory:', e);
                        }
                    };

                    let policy;
                    try {
                        if (window.trustedTypes && window.trustedTypes.createPolicy) {
                            policy = window.trustedTypes.createPolicy('scriptflow-popup-injector', {
                                createScript: (input) => input
                            });
                        }
                    } catch (e) {
                        if (window.trustedTypes) {
                            policy = window.trustedTypes.defaultPolicy;
                        }
                    }

                    const script = document.createElement('script');
                    if (policy) {
                        script.textContent = policy.createScript(`(async () => { ${code}; await displayMemory(); })();`);
                    } else {
                        script.textContent = `(async () => { ${code}; await displayMemory(); })();`;
                    }
                    (document.head || document.documentElement).appendChild(script);
                    script.remove();

                },
                args: [codeToExecute, memoryInspectorEnabled],
                world: 'MAIN'
            });

            this.showNotification('Script executed successfully', 'success');
        } catch (error) {
            console.error('Failed to run script:', error);
            this.showNotification(`Failed to execute: ${error.message}`, 'error');
        }
    }

    async deleteScript(scriptId) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'deleteScript',
                scriptId,
            });

            if (!response || !response.success) {
                throw new Error(response?.error || 'Failed to unregister script');
            }

            await this.loadScripts();
            this.renderScripts();
            this.showNotification('Script deleted successfully', 'success');
        } catch (error) {
            console.error('Failed to delete script:', error);
            this.showNotification('Failed to delete script', 'error');
            await this.loadScripts();
            this.renderScripts();
        }
    }

    async executeConsoleScript() {
        const input = document.getElementById('consoleInput');
        const output = document.getElementById('consoleOutput');
        if (!input || !output) return;

        const userCode = input.value.trim();
        if (!userCode) {
            output.textContent = 'Error: No code to execute';
            return;
        }

        try {
            const [tab] = await chrome.tabs.query({
                active: true,
                currentWindow: true
            });
            if (!tab || !tab.id) {
                output.textContent = 'Error: No active tab found';
                return;
            }

            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
                output.textContent = 'Error: Cannot execute scripts on browser pages';
                return;
            }

            output.textContent = 'Building...';

            const settings = await chrome.storage.sync.get(['memoryInspectorEnabled']);
            const memoryInspectorEnabled = settings.memoryInspectorEnabled || false;

            const callbackId = 'SF_CONSOLE_' + Date.now() + '_' + Math.random().toString(36).slice(2);

            const built = await chrome.runtime.sendMessage({
                action: 'buildConsoleCode',
                code: userCode,
                callbackId,
                // optional: require/grant overrides
                // grant: ['*'],
                // require: [],
            });

            if (!built || !built.success || !built.code) {
                output.textContent = `Error: ${built?.error || 'Failed to build console code'}`;
                return;
            }

            output.textContent = 'Executing...';

            const results = await chrome.scripting.executeScript({
                target: {
                    tabId: tab.id
                },
                world: 'MAIN',
                func: (builtCode, callbackId, memoryInspectorEnabled) => {
                    return new Promise((resolve) => {
                        const finish = (payload) => resolve(payload);

                        window[callbackId] = (payload) => {
                            (async () => {
                                try {
                                    if (memoryInspectorEnabled && window.GM_getMemory) {
                                        const memory = await window.GM_getMemory();
                                        const kb = (memory.bytes / 1024).toFixed(2);
                                        const mb = (memory.bytes / (1024 * 1024)).toFixed(2);
                                        console.log(
                                            `%c[ScriptFlow Memory] Userscript Memory Usage: ${kb} KB / ${mb} MB`,
                                            'background: #34d399; color: black; padding: 2px 4px; border-radius: 2px; font-weight: bold;'
                                        );
                                    }
                                } catch (_) {
                                    // ignore
                                } finally {
                                    try {
                                        delete window[callbackId];
                                    } catch (_) {}
                                    finish(payload);
                                }
                            })();
                        };

                        let policy;
                        try {
                            if (window.trustedTypes && window.trustedTypes.createPolicy) {
                                policy = window.trustedTypes.createPolicy('scriptflow-console-exec', {
                                    createScript: (input) => input
                                });
                            }
                        } catch (e) {
                            if (window.trustedTypes) policy = window.trustedTypes.defaultPolicy;
                        }

                        const s = document.createElement('script');
                        s.textContent = policy ? policy.createScript(builtCode) : builtCode;
                        (document.head || document.documentElement).appendChild(s);
                        s.remove();

                        setTimeout(() => {
                            if (window[callbackId]) {
                                try {
                                    delete window[callbackId];
                                } catch (_) {}
                                finish({
                                    success: true,
                                    result: 'Code executed (no return captured or timed out)'
                                });
                            }
                        }, 2000);
                    });
                },
                args: [built.code, callbackId, memoryInspectorEnabled],
            });

            const payload = results?.[0]?.result;
            if (payload?.success) {
                if (payload.result === 'undefined') {
                    output.textContent = 'Executed successfully - Use return (...) to display a value';
                } else {
                    output.textContent = `Success\n\nResult: ${payload.result}`;
                }
            } else {
                output.textContent = `Error\n\n${payload?.error || 'Unknown error'}`;
            }
        } catch (error) {
            console.error('Console execution error:', error);
            output.textContent = `Error: ${error.message}`;
        }
    }

    openEditor(script = null) {
        const url = script ?
            chrome.runtime.getURL('pages/editor/editor.html') + `?id=${script.id}` :
            chrome.runtime.getURL('pages/editor/editor.html') + '?new=true';

        chrome.tabs.create({
            url
        });
    }

    showNotification(message, type = 'info') {
        const existing = document.querySelectorAll('.popup-notification');
        existing.forEach(n => n.remove());

        const notification = document.createElement('div');
        notification.className = 'popup-notification';
        notification.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            padding: 12px 16px;
            border-radius: 8px;
            color: white;
            font-size: 13px;
            font-weight: 600;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease;
            background: ${type === 'success' ? 'linear-gradient(135deg, #10b981, #059669)' :
				type === 'error' ? 'linear-gradient(135deg, #ef4444, #dc2626)' :
					'linear-gradient(135deg, #6366f1, #4f46e5)'};
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 2700);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', () => {
    new ScriptFlowPopup();
});