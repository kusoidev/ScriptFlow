// src: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
// just a simple wrapper for indexeddb makes it easier to use with promises
class IDBHelper {
    constructor(name, version) {
        this.dbName = name;
        this.version = version;
        this.db = null;
    }

    // this handles the db connection and creates stores if they dont exst
    async connect() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject("Failed to open DB");
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('workspaces')) {
                    db.createObjectStore('workspaces');
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings');
                }
                if (!db.objectStoreNames.contains('scripts')) {
                    db.createObjectStore('scripts', {
                        keyPath: 'id'
                    });
                }
            };
        });
    }

    async get(store, key) {
        await this.connect();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readonly');
            const request = tx.objectStore(store).get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async set(store, key, value) {
        await this.connect();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readwrite');
            const request = tx.objectStore(store).put(value, key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }
}

class ScriptManager {
    constructor() {
        this.idb = new IDBHelper('ScriptFlowDB', 3);
        this.fs = null;
        this.gitFS = null;
        this.init();
    }
    async init() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            this.handleMessage(request, sender, sendResponse);
            return true;
        });
        chrome.action.onClicked.addListener((tab) => {
            chrome.runtime.openOptionsPage();
        });
        chrome.runtime.onStartup.addListener(async () => {
            console.log('ScriptFlow: Syncing all scripts on startup...');
            await this.syncAllScripts();
        });

        chrome.runtime.onInstalled.addListener(async () => {
            console.log('ScriptFlow: First install, syncing all scripts...');
            await this.syncAllScripts();
        });
    }

    async getExecutionSettings() {
        try {
            const settings = await chrome.storage.sync.get([
                'memoryInspectorEnabled',
                'memoryInspectorPosition',
                'debugLogging'
            ]);
            return settings;
        } catch (error) {
            console.error('[ScriptFlow] Failed to load execution settings:', error);
            return {};
        }
    }
    async getFileContent(script, filePath) {
        if (!script) return null;

        const sourceType = script.sourceType || 'bundled';

        switch (sourceType) {
            case 'workspace':
                try {
                    const workspace = await this.idb.get('workspaces', 'root');
                    if (!workspace?.handle) {
                        console.warn('ScriptFlow: Workspace handle not found in DB for lazy loading.');
                        return null;
                    }
                    if (await workspace.handle.queryPermission({
                            mode: 'read'
                        }) !== 'granted') {
                        console.warn('ScriptFlow: Permission for workspace was lost. Cannot read file.');
                        return null;
                    }

                    const fileHandle = await this.getHandleByPath(workspace.handle, filePath);
                    if (fileHandle?.kind === 'file') {
                        const file = await fileHandle.getFile();
                        return file.text();
                    }
                    return null; //file not found here
                } catch (e) {
                    console.error(`ScriptFlow: Error reading from local workspace for ${filePath}`, e);
                    return null;
                }

            case 'git':
                if (typeof LightningFS === 'undefined') {
                    console.error("ScriptFlow: LightningFS is not loaded. Cannot read from Git repository.");
                    return null;
                }
                if (!this.fs) {
                    this.fs = new LightningFS('scriptflow_git_filesystem');
                    this.gitFS = this.fs.promises;
                }
                const gitPath = `/repo/${filePath}`;
                try {
                    return await this.gitFS.readFile(gitPath, 'utf8');
                } catch (e) {
                    return null;
                }

            case 'bundled':
            default:
                return script.files?.[filePath] || null;
        }
    }
    async getHandleByPath(rootHandle, path) {
        const parts = path.split('/').filter(p => p);
        let currentHandle = rootHandle;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            try {
                currentHandle = (i === parts.length - 1) ?
                    await currentHandle.getFileHandle(part) :
                    await currentHandle.getDirectoryHandle(part);
            } catch (e) {
                return null;
            }
        }
        return currentHandle;
    }

    async syncAllScripts() {
        const registeredScripts = await chrome.userScripts.getScripts();
        const registeredIds = new Set(registeredScripts.map(s => s.id));
        let storedScripts = await this.getStoredScripts();
        let scriptsChanged = false;
        storedScripts = storedScripts.map(script => {
            const cleanMatches = (script.matches || []).filter(p => p && p.trim().length > 0);
            if (cleanMatches.length !== (script.matches || []).length) {
                script.matches = cleanMatches;
                scriptsChanged = true;
            }
            return script;
        });
        if (scriptsChanged) {
            await chrome.storage.local.set({
                scripts: storedScripts
            });
        }
        const scriptsToRegister = [];
        const scriptsToUpdate = [];
        for (const script of storedScripts) {
            const finalCode = await this.buildFinalCode(script);

            let runAt = 'document_idle';
            if (script.runAt) {
                runAt = this.normalizeRunAt(script.runAt);
            } else if (script.code) {
                const metaMatch = script.code.match(/\/\*\s*@ScriptFlow\s*(\{[\s\S]*?\})\s*\*\//);
                if (metaMatch) {
                    try {
                        const parsed = JSON.parse(metaMatch[1]);
                        if (parsed['run-at']) {
                            runAt = this.normalizeRunAt(parsed['run-at']);
                        }
                    } catch (e) {}
                }
            }

            const scriptObject = {
                id: script.id,
                matches: this.urlMatchesToGlob(script.matches),
                js: [{
                    code: finalCode
                }],
                runAt: runAt,
                world: 'MAIN'
            };

            if (script.enabled) {
                if (registeredIds.has(script.id)) scriptsToUpdate.push(scriptObject);
                else scriptsToRegister.push(scriptObject);
            }
            registeredIds.delete(script.id);
        }
        const scriptsToUnregister = Array.from(registeredIds).map(id => ({
            id
        }));
        if (scriptsToUnregister.length > 0) {
            try {
                await chrome.userScripts.unregister({
                    ids: scriptsToUnregister.map(s => s.id)
                });
            } catch (e) {
                console.warn("ScriptFlow: Error unregistering.", e);
            }
        }
        if (scriptsToRegister.length > 0) await chrome.userScripts.register(scriptsToRegister);
        if (scriptsToUpdate.length > 0) await chrome.userScripts.update(scriptsToUpdate);
        console.log('ScriptFlow: Sync complete.');
    }

    async installScriptFromUrl(url) {
        console.log(`ScriptFlow: Fetching script from ${url}`);

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

            const code = await response.text();
            const metadata = this.parseMetadata(code);

            const scriptId = crypto.randomUUID();

            const newScript = {
                id: scriptId,
                name: metadata.name || 'New Script',
                namespace: metadata.namespace || '',
                description: metadata.description || '',
                version: metadata.version || '1.0.0',
                matches: metadata.match || [],
                exclude: metadata.exclude || [],
                runAt: metadata['run-at'] || 'document_end',
                code: code,
                enabled: true,
                createdAt: Date.now(),
                lastModified: Date.now(),
                sourceType: 'bundled',
                files: {
                    'main.js': code
                }
            };

            if (typeof newScript.matches === 'string') newScript.matches = [newScript.matches];
            if (!Array.isArray(newScript.matches)) newScript.matches = [];

            const scripts = await this.getStoredScripts();
            scripts.push(newScript);

            await chrome.storage.local.set({
                scripts
            });

            await this.syncAllScripts();

            return scriptId;
        } catch (error) {
            console.error('ScriptFlow installScriptFromUrl error:', error);
            throw new Error(`Failed to install script: ${error.message || String(error)}`);
        }
    }

    parseScriptFlowMetadata(code) {
        const metadata = { grant: ['none'], match: [] };
        const blockMatch = code.match(/\/\*\s*@ScriptFlow\s*\{([\s\S]*?)\}\s*\*\//);
        if (!blockMatch) return metadata;
        
        try {
            const jsonStr = blockMatch[1].trim();
            const cleanJson = jsonStr.replace(/,\s*([}\]])/g, '$1');
            const parsed = JSON.parse(cleanJson);
            this.grants = Array.isArray(parsed.grant) ? parsed.grant : ['none'];
            this.matches = Array.isArray(parsed.match) ? parsed.match : [];
            return { grant: this.grants, match: this.matches };
        } catch (e) {
            return metadata;
        }
    }

    parseMeta() {
        if (!this.editor) return;
        const code = this.editor.getValue();
        const metadata = this.parseScriptFlowMetadata(code);
    }

    renderGrants() {
        const container = document.getElementById('grantsContainer');
        if (!container) return;
        
        container.innerHTML = this.grants.map((grant, index) => 
            `<div class="grant-item">
                <span>${this.escape(grant)}</span>
                <button class="grant-remove" data-index="${index}" title="Remove">×</button>
            </div>`
        ).join('');
        
        container.querySelectorAll('.grant-remove').forEach(btn => {
            btn.addEventListener('click', e => {
                const index = parseInt(e.target.dataset.index);
                this.grants.splice(index, 1);
                this.renderGrants();
                this.updateScriptFlowBlock();
            });
        });
    }

    parseMetadata(code) {
        const metadata = {
            match: [],
            exclude: []
        };
        const metaBlock = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);

        if (metaBlock) {
            const lines = metaBlock[1].split('\n');
            lines.forEach(line => {
                const match = line.match(/^\/\/\s+@(\w+)\s+(.*)/);
                if (match) {
                    const key = match[1];
                    const value = match[2].trim();

                    if (key === 'match') {
                        metadata.match.push(value);
                    } else if (key === 'exclude') {
                        metadata.exclude.push(value);
                    } else if (key === 'require' || key === 'resource' || key === 'grant') {
                        if (!metadata[key]) metadata[key] = [];
                        metadata[key].push(value);
                    } else {
                        metadata[key] = value;
                    }
                }
            });
        }
        return metadata;
    }

    async getStoredScripts() {
        await this.idb.connect();
        return new Promise((resolve, reject) => {
            const tx = this.idb.db.transaction('scripts', 'readonly');
            const store = tx.objectStore('scripts');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async registerScripts(scripts) {
        if (chrome.userScripts) {
            // For now lets just trigger a full sync
            await this.syncAllScripts();
        }
    }

    async updateScriptRegistration(script) {
        if (!script.enabled) {
            try {
                await chrome.userScripts.unregister({
                    ids: [script.id]
                });
                console.log('ScriptFlow: Unregistered script', script.id);
            } catch (e) {
                // already unregistered so no need to do anything
            }
            return;
        }

        const finalCode = await this.buildFinalCode(script);
        let runAt = 'document_idle';

        if (script.runAt) {
            runAt = this.normalizeRunAt(script.runAt);
        } else if (script.code) {
            const metaMatch = script.code.match(/\/\*\s*<ScriptFlow>([\s\S]*?)<\/ScriptFlow>\s*\*\//);
            if (metaMatch) {
                try {
                    const parsed = JSON.parse(metaMatch[1]);
                    if (parsed['run-at']) runAt = this.normalizeRunAt(parsed['run-at']);
                } catch (e) {}
            }
        }

        const scriptObject = {
            id: script.id,
            matches: this.urlMatchesToGlob(script.matches),
            js: [{
                code: finalCode
            }],
            runAt: runAt,
            world: 'MAIN'
        };

        let existingScripts = [];
        try {
            existingScripts = await chrome.userScripts.getScripts({
                ids: [script.id]
            });
        } catch (e) {
            console.log('ScriptFlow: Could not check existing scripts', e);
        }

        if (existingScripts && existingScripts.length > 0) {
            try {
                await chrome.userScripts.update([scriptObject]);
                console.log('ScriptFlow: Updated script', script.id);
            } catch (e) {
                console.warn('ScriptFlow: Update failed, trying unregister+register', e);
                try {
                    await chrome.userScripts.unregister({
                        ids: [script.id]
                    });
                    await chrome.userScripts.register([scriptObject]);
                    console.log('ScriptFlow: Re-registered script', script.id);
                } catch (e2) {
                    console.error('ScriptFlow: Failed to re-register script', script.id, e2);
                }
            }
        } else {
            try {
                await chrome.userScripts.register([scriptObject]);
                console.log('ScriptFlow: Registered new script', script.id);
            } catch (e) {
                if (e.message.includes('Duplicate script ID')) {
                    console.warn('ScriptFlow: Duplicate detected, forcing update', script.id);
                    try {
                        await chrome.userScripts.update([scriptObject]);
                        console.log('ScriptFlow: Forced update successful', script.id);
                    } catch (e2) {
                        console.error('ScriptFlow: Forced update failed', script.id, e2);
                    }
                } else {
                    console.error('ScriptFlow: Failed to register script', script.id, e);
                }
            }
        }
    }

    urlMatchesToGlob(patterns) {
        const cleanPatterns = (patterns || []).filter(p => p && p.trim().length > 0);
        if (cleanPatterns.length === 0) return ["<all_urls>"];
        return cleanPatterns.map(raw => {
            const p = raw.trim();
            if (p.toLowerCase() === 'all' || p === '<all_urls>') return '<all_urls>';
            if (!p.includes('://')) return p.startsWith('*.') ? `*://${p}/*` : `*://*.${p}/*`;
            if (!p.endsWith('*')) return p.replace(/\/+$/, '') + '/*';
            return p;
        });
    }

    normalizeRunAt(runAt) {
        const normalized = {
            'document-start': 'document_start',
            'document-end': 'document_end',
            'document-idle': 'document_idle',
            'document_start': 'document_start',
            'document_end': 'document_end',
            'document_idle': 'document_idle'
        };
        return normalized[runAt] || 'document_idle';
    }

    // might aswell make it global/universal since buildGrantedApiScript is broken and doesnt do it properly
    injectUniversalGMApis() {
        return `
    (function() {
        if (window.SF_GM_INJECTED) return;
        window.SF_GM_INJECTED = true;

        const GM_STORAGE_PREFIX = 'SF_GM_';

        function GM_setValue(key, value) {
            try { localStorage.setItem(GM_STORAGE_PREFIX + key, JSON.stringify(value)); } catch (e) {}
        }

        function GM_getValue(key, def) {
            try {
                const v = localStorage.getItem(GM_STORAGE_PREFIX + key);
                return v === null ? def : JSON.parse(v);
            } catch (e) { return def; }
        }

        function GM_deleteValue(key) {
            localStorage.removeItem(GM_STORAGE_PREFIX + key);
        }

        function GM_listValues() {
            return Object.keys(localStorage)
                .filter(k => k.startsWith(GM_STORAGE_PREFIX))
                .map(k => k.slice(GM_STORAGE_PREFIX.length));
        }

        function GM_addStyle(css) {
            const style = document.createElement('style');
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
            return style;
        }

        function GM_addElement(tagNameOrEl, attributes, parent) {
            const el = typeof tagNameOrEl === 'string'
                ? document.createElement(tagNameOrEl || 'div')
                : tagNameOrEl;
            if (attributes && typeof attributes === 'object') {
                Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
            }
            (parent || document.body || document.documentElement).appendChild(el);
            return el;
        }

        function GM_getResourceText(name) {
            return null;
        }

        function GM_getResourceURL(name) {
            return null;
        }

        const _gmMenuCommands = [];
        function GM_registerMenuCommand(label, callback, accessKey) {
            const id = _gmMenuCommands.length + 1;
            _gmMenuCommands.push({ id, label, callback, accessKey });
            return id;
        }

        function GM_unregisterMenuCommand(id) {
            const idx = _gmMenuCommands.findIndex(c => c.id === id);
            if (idx >= 0) _gmMenuCommands.splice(idx, 1);
        }

        function GM_xmlhttpRequest(details) {
            const xhr = new XMLHttpRequest();
            xhr.open((details.method || 'GET').toUpperCase(), details.url, !details.synchronous);
            if (details.headers) {
                Object.entries(details.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
            }
            xhr.onload = function() {
                details.onload && details.onload({
                    readyState: xhr.readyState,
                    responseHeaders: xhr.getAllResponseHeaders(),
                    responseText: xhr.responseText,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    finalUrl: xhr.responseURL
                });
            };
            xhr.onerror = function(e) {
                details.onerror && details.onerror(e);
            };
            if (details.onprogress) xhr.onprogress = details.onprogress;
            if (details.ontimeout) xhr.ontimeout = details.ontimeout;
            if (details.timeout) xhr.timeout = details.timeout;
            xhr.send(details.data);
            return { abort: () => xhr.abort() };
        }

        function GM_download(arg1, arg2) {
            const opts = typeof arg1 === 'string' ? { url: arg1, name: arg2 } : arg1;
            if (!opts || !opts.url) return;
            const a = document.createElement('a');
            a.href = opts.url;
            a.download = opts.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (opts.onload) opts.onload();
        }

        function GM_openInTab(url, options) {
            return window.open(url, (options && options.active === false) ? '_blank' : '_blank');
        }

        function GM_setClipboard(data) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(data).catch(() => {});
            }
        }

        function GM_log() {
            console.log.apply(console, arguments);
        }

        function GM_notification(textOrOptions, title, image, onclick) {
            let text = textOrOptions;
            let opts = {};
            if (typeof textOrOptions === 'object') {
                opts = textOrOptions;
                text = textOrOptions.text || textOrOptions.body || '';
                title = textOrOptions.title || title;
                image = textOrOptions.image || textOrOptions.icon || image;
                onclick = textOrOptions.onclick || onclick;
            }
            const show = () => {
                const n = new Notification(title || 'ScriptFlow', { body: text, icon: image });
                if (onclick) n.onclick = onclick;
            };
            if (Notification.permission === 'granted') {
                show();
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(p => { if (p === 'granted') show(); });
            }
        }

        const GM_info = {
            scriptHandler: 'ScriptFlow',
            version: '2.0',
            script: {
                name: document.title || 'ScriptFlow Script',
                description: '',
                version: '1.0',
                namespace: 'ScriptFlow'
            }
        };

        window.GM_setValue = GM_setValue;
        window.GM_getValue = GM_getValue;
        window.GM_deleteValue = GM_deleteValue;
        window.GM_listValues = GM_listValues;
        window.GM_addStyle = GM_addStyle;
        window.GM_addElement = GM_addElement;
        window.GM_getResourceText = GM_getResourceText;
        window.GM_getResourceURL = GM_getResourceURL;
        window.GM_registerMenuCommand = GM_registerMenuCommand;
        window.GM_unregisterMenuCommand = GM_unregisterMenuCommand;
        window.GM_xmlhttpRequest = GM_xmlhttpRequest;
        window.GM_download = GM_download;
        window.GM_openInTab = GM_openInTab;
        window.GM_setClipboard = GM_setClipboard;
        window.GM_log = GM_log;
        window.GM_notification = GM_notification;
        window.GM_info = GM_info;

        window.GM = {
            setValue: GM_setValue,
            getValue: GM_getValue,
            deleteValue: GM_deleteValue,
            listValues: GM_listValues,
            addStyle: GM_addStyle,
            addElement: GM_addElement,
            getResourceText: GM_getResourceText,
            getResourceURL: GM_getResourceURL,
            registerMenuCommand: GM_registerMenuCommand,
            unregisterMenuCommand: GM_unregisterMenuCommand,
            xmlHttpRequest: GM_xmlhttpRequest,
            download: GM_download,
            openInTab: GM_openInTab,
            setClipboard: GM_setClipboard,
            log: GM_log,
            notification: GM_notification,
            info: GM_info
        };

        console.log('ScriptFlow: ALL main GM APIs injected. (i think)');
    })();
        `;
    }

    async buildFinalCode(script) {
        const {
            memoryInspectorEnabled = false, memoryInspectorPosition = 'top-right', debugLogging = false
        } = await this.getExecutionSettings();
        let metadata = {
            require: script.require || [],
            grant: script.grant || [],
            runAt: script.runAt || 'document_idle'
        };

        if (!script.type || script.type === 'single-file') {
            const code = script.code || '';
            const metaMatch = code.match(/\/\*\s*@ScriptFlow\s*(\{[\s\S]*?\})\s*\*\//);
            if (metaMatch) {
                try {
                    const parsed = JSON.parse(metaMatch[1]);
                    if (parsed.require) metadata.require = Array.isArray(parsed.require) ? parsed.require : [parsed.require];
                    if (parsed.grant) metadata.grant = Array.isArray(parsed.grant) ? parsed.grant : [parsed.grant];
                    if (parsed['run-at']) {
                        metadata.runAt = this.normalizeRunAt(parsed['run-at']);
                    }
                } catch (e) {
                    console.error('ScriptFlow: Failed to parse metadata from code:', e);
                }
            }
        } else {
            if (script.runAt) {
                metadata.runAt = this.normalizeRunAt(script.runAt);
            }
        }

        const gmApis = this.injectUniversalGMApis();
        let externalScriptsCode = '';
        if (metadata.require && metadata.require.length > 0) {
            const scriptPromises = metadata.require.map(async (url) => {
                try {
                    if (debugLogging) console.log(`[ScriptFlow] Loading external script: ${url}`);
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const code = await response.text();
                    const logStatement = debugLogging ? `console.log('[ScriptFlow] Loaded: ${url}');` : '';
                    return `// Loaded from: ${url}\n${code}\n${logStatement}`;
                } catch (err) {
                    console.error(`ScriptFlow: Failed to load required script ${url}:`, err);
                    return `console.error('[ScriptFlow] Failed to load: ${url}', '${err.message}');`;
                }
            });

            try {
                const scripts = await Promise.all(scriptPromises);
                externalScriptsCode = scripts.join('\n\n');
            } catch (err) {
                console.error('ScriptFlow: Error loading required scripts:', err);
            }
        }

        let userCode = '';
        let resources = {};
        const escapeForTemplateLiteral = (str) => str ? String(str).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$') : '';

        if (script.type === 'tracked-project') {
            const entryPoint = script.entryPoint || 'main.js';
            const entryPointCode = await this.getFileContent(script, entryPoint);

            if (entryPointCode === null) {
                return `console.error('%c[ScriptFlow] Execution failed: Entry point "${entryPoint}" not found for project "${script.name}".', 'color: #ef4444; font-weight: bold;');`;
            }

            const cssFiles = [];
            for (const [path, content] of Object.entries(script.files || {})) {
                if (path.endsWith('.css')) {
                    cssFiles.push(content);
                } else if (!path.endsWith('.js') && !path.endsWith('.json')) {
                    const contentStr = String(content);
                    if (contentStr.length < 50000) {
                        resources[path] = content;
                    }
                }
            }

            const cssInjection = cssFiles.map(css => `GM_addStyle(\`${escapeForTemplateLiteral(css)}\`);`).join('\n');
            const moduleSystem = this.buildLazyModuleSystem(script.id);

            const projectLoadLog = debugLogging ? `console.log('%cScriptFlow Project Loading...', 'background: #6366f1; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');` : '';
            const projectSuccessLog = debugLogging ? `console.log('%cScript executed successfully', 'color: #10b981; font-weight: bold;');` : '';

            userCode = `
				window.__SF_VFS = window.__SF_VFS || {};
				window.__SF_VFS['${entryPoint}'] = \`${escapeForTemplateLiteral(entryPointCode)}\`;
				${moduleSystem}
				${cssInjection}
				(async () => {
					${projectLoadLog}
					try {
						await window.__SF_require('${entryPoint}');
						${projectSuccessLog}
					} catch (e) {
						console.error('%cScript execution failed', 'color: #ef4444; font-weight: bold;', e);
					}
				})();
			`;

        } else if (script.type === 'multi-file') {
            const entryPoint = script.entryPoint || 'main.js';
            const modules = [];
            const cssFiles = [];

            const safeRemoveComments = (code) => {
                let result = '';
                let i = 0;
                let inString = false;
                let stringChar = null;
                let inRegex = false;
                let inBlockComment = false;
                let inLineComment = false;
                let inTemplate = false;
                let templateDepth = 0;

                while (i < code.length) {
                    const char = code[i];
                    const next = code[i + 1];
                    const prev = i > 0 ? code[i - 1] : '';

                    if (char === '\\' && (inString || inTemplate) && !inBlockComment && !inLineComment) {
                        result += char + (next || '');
                        i += 2;
                        continue;
                    }

                    if (!inString && !inTemplate && !inLineComment && char === '/' && next === '*') {
                        inBlockComment = true;
                        i += 2;
                        continue;
                    }

                    if (inBlockComment && char === '*' && next === '/') {
                        inBlockComment = false;
                        i += 2;
                        continue;
                    }

                    if (inBlockComment) {
                        i++;
                        continue;
                    }

                    if (!inString && !inTemplate && !inBlockComment && char === '/' && next === '/') {
                        inLineComment = true;
                        i += 2;
                        continue;
                    }

                    if (inLineComment && (char === '\n' || char === '\r')) {
                        inLineComment = false;
                        result += char;
                        i++;
                        continue;
                    }

                    if (inLineComment) {
                        i++;
                        continue;
                    }

                    if (!inString && !inBlockComment && !inLineComment && char === '`') {
                        if (!inTemplate) {
                            inTemplate = true;
                            templateDepth = 0;
                        } else if (templateDepth === 0) {
                            inTemplate = false;
                        }
                        result += char;
                        i++;
                        continue;
                    }

                    if (inTemplate && char === '$' && next === '{') {
                        templateDepth++;
                        result += char + next;
                        i += 2;
                        continue;
                    }

                    if (inTemplate && char === '}' && templateDepth > 0) {
                        templateDepth--;
                        result += char;
                        i++;
                        continue;
                    }

                    if (!inTemplate && (char === '"' || char === "'") && !inBlockComment && !inLineComment) {
                        if (!inString) {
                            inString = true;
                            stringChar = char;
                        } else if (char === stringChar) {
                            inString = false;
                            stringChar = null;
                        }
                        result += char;
                        i++;
                        continue;
                    }

                    result += char;
                    i++;
                }

                return result;
            };

            // fuck it im chatgpting this part
            const transformModuleCode = (path, src) => {
                if (path.endsWith('.json')) {
                    return `module.exports = JSON.parse(${JSON.stringify(String(src))});`;
                }

                let out = String(src);
                const exportAssignments = [];

                out = safeRemoveComments(out);

                // require.context
                out = out.replace(/require\.context\s*\(\s*(['\"])([^'"]+)\1\s*,\s*(true|false)\s*(?:,\s*([^)]+))?\s*\)/g,
                    (match, quote, directory, recursive, pattern) => {
                        return `__SF_createContext(${JSON.stringify(directory)}, ${recursive}, ${pattern || '/\\.js$/'}, __currentModule)`;
                    }
                );

                // require("...")
                out = out.replace(/\brequire\s*\(\s*(['\"])([^'"]+)\1\s*\)/g, (m, q, rel) => {
                    return '__SF_require(' + JSON.stringify(rel) + ', __currentModule)';
                });

                // import * as foo from "..."
                out = out.replace(/import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+(['\"])([^'"]+)\2;?/g, (m, ident, q, rel) => {
                    return `const ${ident} = __SF_require(${JSON.stringify(rel)}, __currentModule);`;
                });

                // import foo from "..." (default import)
                out = out.replace(/import\s+([A-Za-z0-9_$]+)\s+from\s+(['\"])([^'"]+)\2;?/g, (m, ident, q, rel) => {
                    return `const ${ident} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).default || __SF_require(${JSON.stringify(rel)}, __currentModule);`;
                });

                // import foo, { bar, baz } from "..." (combined default + named)
                out = out.replace(/import\s+([A-Za-z0-9_$]+)\s*,\s*{\s*([^}]+)}\s+from\s+(['\"])([^'"]+)\3;?/g, (m, defaultName, names, q, rel) => {
                    const parts = names.split(',').map(s => s.trim()).filter(Boolean);
                    const namedImports = parts.map(p => {
                        const asMatch = p.match(/^(.+?)\s+as\s+(.+)$/);
                        if (asMatch) {
                            return `const ${asMatch[2].trim()} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).${asMatch[1].trim()};`;
                        }
                        return `const ${p} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).${p};`;
                    }).join('\n');
                    return `const ${defaultName} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).default || __SF_require(${JSON.stringify(rel)}, __currentModule);\n${namedImports}`;
                });

                // import { foo, bar } from "..." (named imports)
                out = out.replace(/import\s+{\s*([^}]+)}\s+from\s+(['\"])([^'"]+)\2;?/g, (m, names, q, rel) => {
                    const parts = names.split(',').map(s => s.trim()).filter(Boolean);
                    return parts.map(p => {
                        const asMatch = p.match(/^(.+?)\s+as\s+(.+)$/);
                        if (asMatch) {
                            return `const ${asMatch[2].trim()} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).${asMatch[1].trim()};`;
                        }
                        return `const ${p} = (__SF_require(${JSON.stringify(rel)}, __currentModule) || {}).${p};`;
                    }).join('\n');
                });

                // import "..." (side-effect import)
                out = out.replace(/import\s+(['\"])([^'"]+)\1;?/g, (m, q, rel) => {
                    return `__SF_require(${JSON.stringify(rel)}, __currentModule);`;
                });

                // export default async function foo()
                out = out.replace(/export\s+default\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(/g, (m, name) => {
                    exportAssignments.push(`module.exports.default = ${name};`);
                    return `async function ${name}(`;
                });

                // export default function foo()
                out = out.replace(/export\s+default\s+function\s+([A-Za-z0-9_$]+)\s*\(/g, (m, name) => {
                    exportAssignments.push(`module.exports.default = ${name};`);
                    return `function ${name}(`;
                });

                // export default class Foo
                out = out.replace(/export\s+default\s+class\s+([A-Za-z0-9_$]+)\s*/g, (m, name) => {
                    exportAssignments.push(`module.exports.default = ${name};`);
                    return `class ${name} `;
                });

                // export default (anonymous function/class)
                out = out.replace(/export\s+default\s+(async\s+)?(function|class)(\s*\*)?(\s*\()/g, (m, asyncMod, type, generator, paren) => {
                    return `module.exports.default = ${asyncMod || ''}${type}${generator || ''}${paren}`;
                });

                // export default <expression>
                out = out.replace(/export\s+default\s+/g, () => `module.exports.default = `);

                // export async function foo()
                out = out.replace(/export\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(/g, (m, name) => {
                    exportAssignments.push(`module.exports.${name} = ${name};`);
                    return `async function ${name}(`;
                });

                // export function foo()
                out = out.replace(/export\s+function\s+([A-Za-z0-9_$]+)\s*\(/g, (m, name) => {
                    exportAssignments.push(`module.exports.${name} = ${name};`);
                    return `function ${name}(`;
                });

                // export class Foo
                out = out.replace(/export\s+class\s+([A-Za-z0-9_$]+)\s*/g, (m, name) => {
                    exportAssignments.push(`module.exports.${name} = ${name};`);
                    return `class ${name} `;
                });

                // export const/let/var foo =
                out = out.replace(/export\s+(const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g, (m, kind, name) => {
                    exportAssignments.push(`module.exports.${name} = ${name};`);
                    return `${kind} ${name} =`;
                });

                // export { foo, bar as baz } from "./x" (re-export with source)
                const reExportMatches = out.match(/export\s+{\s*([^}]+)}\s+from\s+(['\"])([^'"]+)\2;?/g) || [];
                reExportMatches.forEach(stmt => {
                    const match = stmt.match(/export\s+{\s*([^}]+)}\s+from\s+(['\"])([^'"]+)\2;?/);
                    if (match) {
                        const [, names, , source] = match;
                        const parts = names.split(',').map(s => s.trim());
                        const reExports = parts.map(p => {
                            const asMatch = p.match(/^(.+?)\s+as\s+(.+)$/);
                            if (asMatch) {
                                const [, original, alias] = asMatch;
                                return `module.exports.${alias.trim()} = (__SF_require(${JSON.stringify(source)}, __currentModule) || {}).${original.trim()};`;
                            }
                            return `module.exports.${p} = (__SF_require(${JSON.stringify(source)}, __currentModule) || {}).${p};`;
                        }).join('\n');
                        out = out.replace(stmt, reExports);
                    }
                });

                // export { foo, bar as baz } (local exports)
                const explicitExports = [];
                (out.match(/export\s*{\s*[^}]+};?/g) || []).forEach(stmt => {
                    const inner = stmt.replace(/export\s*{/, '').replace(/};?/, '').trim();
                    inner.split(',').map(s => s.trim()).forEach(pair => {
                        const m = pair.match(/^(.+?)\s+as\s+(.+)$/);
                        if (m) {
                            explicitExports.push({
                                from: m[1].trim(),
                                to: m[2].trim()
                            });
                        } else {
                            explicitExports.push({
                                from: pair,
                                to: pair
                            });
                        }
                    });
                    out = out.replace(stmt, '');
                });

                explicitExports.forEach(e => {
                    exportAssignments.push(`module.exports.${e.to} = typeof ${e.from} !== 'undefined' ? ${e.from} : undefined;`);
                });

                // export * from "./x" (re-export all)
                out = out.replace(/export\s+\*\s+from\s+(['\"])([^'"]+)\1;?/g, (m, q, rel) => {
                    const tmp = `__SF_require(${JSON.stringify(rel)}, __currentModule)`;
                    return `(function(m){ for (const k in m) if (k !== 'default') module.exports[k] = m[k]; })(${tmp});`;
                });

                // export * as ns from "./x" (namespace re-export)
                out = out.replace(/export\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+(['\"])([^'"]+)\2;?/g, (m, ns, q, rel) => {
                    return `module.exports.${ns} = __SF_require(${JSON.stringify(rel)}, __currentModule);`;
                });

                out = out.replace(/\bexport\s+/g, '');

                if (exportAssignments.length) {
                    out += `\n\n/* __sf export assignments */\n${exportAssignments.join('\n')}\n`;
                }

                return out;
            };

            const transformModule = (path, src) => {
                return transformModuleCode(path, src);
            };

            for (const [path, content] of Object.entries(script.files || {})) {
                if (path.endsWith('.css')) {
                    cssFiles.push(content);
                } else if (path.endsWith('.js') || path.endsWith('.json')) {
                    modules.push({
                        path,
                        code: transformModule(path, content)
                    });
                } else {
                    const contentStr = String(content);
                    if (contentStr.length < 50000) {
                        resources[path] = content;
                    }
                }
            }

            const modulesInit = modules.map(m => {
                return `__SF_modules[${JSON.stringify(m.path)}] = function(module, exports, __SF_require, __currentModule) {\n${m.code}\n};`;
            }).join('\n\n');

            const cssInjection = cssFiles.map(css => `GM_addStyle(\`${escapeForTemplateLiteral(css)}\`);`).join('\n');

            userCode = `
				(function() {
					const __SF_modules = {};
					const __SF_cache = {};

					function __resolvePath(from, to) {
						if (!to.startsWith('./') && !to.startsWith('../')) return to;
						const parts = from.split('/').slice(0, -1);
						to.split('/').forEach(p => {
							if (p === '..') parts.pop();
							else if (p !== '.') parts.push(p);
						});
						return parts.join('/');
					}

					function __tryResolve(candidate) {
						if (__SF_modules.hasOwnProperty(candidate)) return candidate;
						if (__SF_modules.hasOwnProperty(candidate + '.js')) return candidate + '.js';
						if (__SF_modules.hasOwnProperty(candidate + '.json')) return candidate + '.json';
						if (__SF_modules.hasOwnProperty(candidate + '/index.js')) return candidate + '/index.js';
						if (__SF_modules.hasOwnProperty(candidate + '/index.json')) return candidate + '/index.json';
						return null;
					}

					function __SF_createContext(directory, recursive, pattern, fromModule) {
						const fullPath = directory.startsWith('./') || directory.startsWith('../') 
							? __resolvePath(fromModule, directory)
							: directory;
						
						const matchingModules = Object.keys(__SF_modules).filter(modulePath => {
							if (recursive) {
								return modulePath.startsWith(fullPath + '/') || modulePath.startsWith(fullPath);
							} else {
								const relativePath = modulePath.replace(fullPath + '/', '');
								return modulePath.startsWith(fullPath + '/') && !relativePath.includes('/');
							}
						}).filter(modulePath => {
							if (pattern) {
								try {
									const regex = typeof pattern === 'string' ? eval(pattern) : pattern;
									return regex.test(modulePath);
								} catch (e) {
									return true;
								}
							}
							return true;
						});
						
						const context = function(request) {
							return __SF_require(request, fullPath + '/index.js');
						};
						
						context.keys = function() {
							return matchingModules.map(path => './' + path.replace(fullPath + '/', ''));
						};
						
						context.resolve = function(request) {
							const resolvedPath = __resolvePath(fullPath + '/index.js', request);
							return __tryResolve(resolvedPath) || resolvedPath;
						};
						
						context.id = fullPath;
						
						return context;
					}

					function __SF_require(requestPath, fromPath) {
						const resolved = __resolvePath(fromPath || '${entryPoint}', requestPath);
						const real = __tryResolve(resolved);
						if (!real) throw new Error('ScriptFlow: Module not found: ' + requestPath + ' (resolved: ' + resolved + ')');
						if (__SF_cache[real]) return __SF_cache[real];

						const module = { exports: {} };
						__SF_modules[real](module, module.exports, function(req){ return __SF_require(req, real); }, real);
						__SF_cache[real] = module.exports;
						return module.exports;
					}

					${modulesInit}
					${cssInjection}

					try {
						${debugLogging ? `console.log('%cScriptFlow Multi-File Loaded', 'background: #6366f1; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');` : ''}
						__SF_require('${entryPoint}', '');
						${debugLogging ? `console.log('%cScript executed successfully', 'color: #10b981; font-weight: bold;');` : ''}
					} catch (e) {
						console.error('%cScript execution failed', 'color: #ef4444; font-weight: bold;', e);
						throw e;
					}
				})();
        `;

        } else {
            // testing with single file, i plan on making it for multi-file soon
            let userCode = '';
            let resources = {};
            const escapeForTemplateLiteral = (str) => str ? String(str).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$') : '';

            const code = script.code || '';
            const hasUrlImport = /import\s+[\s\S]+from\s+['"]https?:\/\/[^'";]+['"];?/.test(code) || /import\s+['"]https?:\/\/[^'";]+['"];?/.test(code);

            if (hasUrlImport) {
                userCode = `
                    (function() {
                        'use strict';
                        const source = ${JSON.stringify(code)};
                        const blob = new Blob([source], { type: 'text/javascript' });
                        const url = URL.createObjectURL(blob);
                        const scriptEl = document.createElement('script');
                        scriptEl.type = 'module';
                        scriptEl.src = url;
                        scriptEl.addEventListener('error', (e) => {
                            console.error('[ScriptFlow] failed to load', e);
                        });
                        document.documentElement.appendChild(scriptEl);
                    })();
                `;
            } else {
                userCode = code;
            }
            const gmApis = this.injectUniversalGMApis();
            return gmApis + externalScriptsCode + userCode;
        }

        const apiCode = this.buildGrantedApiScript(metadata.grant, resources, memoryInspectorEnabled, memoryInspectorPosition, debugLogging);
        const memoryInspectionLogic = `
			const SF_createMemoryOverlay = () => {
				if (!GM_API.memoryInspectorEnabled) return null;
                const existing = document.getElementById('sf-memory-overlay');
                if (existing) return existing;
				
				const overlay = document.createElement('div');
				overlay.id = 'sf-memory-overlay';
				overlay.style.cssText = \`
					position: fixed;
					z-index: 2147483647;
					background: rgba(17, 24, 39, 0.95);
					color: #10b981;
					font-family: 'Monaco', 'Courier New', monospace;
					font-size: 12px;
					padding: 8px 12px;
					border-radius: 6px;
					box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
					pointer-events: auto;
					cursor: move;
					user-select: none;
					backdrop-filter: blur(8px);
					border: 1px solid rgba(16, 185, 129, 0.3);
					min-width: 180px;
				\`;
				
				const position = '${memoryInspectorPosition}';
				switch(position) {
					case 'top-left':
						overlay.style.top = '10px';
						overlay.style.left = '10px';
						break;
					case 'top-right':
						overlay.style.top = '10px';
						overlay.style.right = '10px';
						break;
					case 'bottom-left':
						overlay.style.bottom = '10px';
						overlay.style.left = '10px';
						break;
					case 'bottom-right':
						overlay.style.bottom = '10px';
						overlay.style.right = '10px';
						break;
				}
				
				overlay.innerHTML = \`
					<div style="font-weight: bold; margin-bottom: 4px; color: #6366f1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">
						ScriptFlow Memory Usage:
					</div>
					<div id="sf-memory-content" style="font-size: 13px; line-height: 1.6;">
						<div style="color: #94a3b8;">Initializing...</div>
					</div>
				\`;
				
				document.documentElement.appendChild(overlay);
				
				let isDragging = false;
				let dragOffset = { x: 0, y: 0 };
				
				overlay.addEventListener('mousedown', (e) => {
					isDragging = true;
					dragOffset.x = e.clientX - overlay.getBoundingClientRect().left;
					dragOffset.y = e.clientY - overlay.getBoundingClientRect().top;
					overlay.style.cursor = 'grabbing';
				});
				
				document.addEventListener('mousemove', (e) => {
					if (!isDragging) return;
					overlay.style.top = (e.clientY - dragOffset.y) + 'px';
					overlay.style.left = (e.clientX - dragOffset.x) + 'px';
					overlay.style.right = 'auto';
					overlay.style.bottom = 'auto';
				});
				
				document.addEventListener('mouseup', () => {
					isDragging = false;
					overlay.style.cursor = 'move';
				});
				
				return overlay;
			};

			const SF_updateMemoryDisplay = async (overlay) => {
				if (!overlay || !GM_API.memoryInspectorEnabled) return;
				
				if (!window.GM_getMemory) {
					const content = overlay.querySelector('#sf-memory-content');
					if (content) {
						content.innerHTML = '<div style="color: #ef4444;">GM_getMemory not available</div>';
					}
					return;
				}
				
				try {
					const memory = await window.GM_getMemory();
					const content = overlay.querySelector('#sf-memory-content');
					
					if (!content) return;
					
					if (memory.method === 'measureUserAgentSpecificMemory') {
						const scriptMB = memory.scriptMB || 0;
						const totalMB = memory.totalMB || 0;
						content.innerHTML = \`
							<div><span style="color: #94a3b8;">Script:</span> <span style="color: #10b981; font-weight: bold;">\${scriptMB.toFixed(2)} MB</span></div>
							<div><span style="color: #94a3b8;">Total:</span> <span style="color: #6366f1;">\${totalMB.toFixed(2)} MB</span></div>
						\`;
					} else if (memory.method === 'performance.memory') {
						const usedMB = memory.usedMB || 0;
						const totalMB = memory.totalMB || 0;
						const percent = totalMB > 0 ? ((usedMB / totalMB) * 100).toFixed(1) : 0;
						content.innerHTML = \`
							<div><span style="color: #94a3b8;">JS Heap:</span> <span style="color: #10b981; font-weight: bold;">\${usedMB.toFixed(2)} MB</span></div>
							<div><span style="color: #94a3b8;">Allocated:</span> <span style="color: #6366f1;">\${totalMB.toFixed(2)} MB</span></div>
							<div><span style="color: #94a3b8;">Usage:</span> <span style="color: #f59e0b;">\${percent}%</span></div>
							<div style="color: #64748b; font-size: 10px; margin-top: 4px;">Note: This Is Approx Memory Usage.</div>
						\`;
					} else if (memory.method === 'unavailable') {
						content.innerHTML = '<div style="color: #f59e0b;">Memory API not supported<br><span style="font-size: 10px;">Try Chrome/Edge</span></div>';
					} else {
						content.innerHTML = '<div style="color: #ef4444;">Unknown error</div>';
					}
				} catch (e) {
					const content = overlay.querySelector('#sf-memory-content');
					if (content) {
						content.innerHTML = '<div style="color: #ef4444;">Error measuring memory</div>';
					}
				}
			};

			let memoryOverlay = null;
			let memoryInterval = null;
			
			if (GM_API.memoryInspectorEnabled) {
				if (document.readyState === 'loading') {
					document.addEventListener('DOMContentLoaded', () => {
						memoryOverlay = SF_createMemoryOverlay();
						if (memoryOverlay) {
							SF_updateMemoryDisplay(memoryOverlay);
                            memoryInterval = setInterval(() => {
                                SF_updateMemoryDisplay(memoryOverlay);
                            }, 1000);
						}
					});
				} else {
					memoryOverlay = SF_createMemoryOverlay();
					if (memoryOverlay) {
						SF_updateMemoryDisplay(memoryOverlay);
                        memoryInterval = setInterval(() => {
                            SF_updateMemoryDisplay(memoryOverlay);
                        }, 1000);
					}
				}
			}
		`;
      return `
          ${apiCode}
          ${memoryInspectionLogic}

          (async function() {
            if (window['__SF_SCRIPT_${script.id}_RUNNING']) {
                return;
            }
            window['__SF_SCRIPT_${script.id}_RUNNING'] = true;
            'use strict';

            try { 
              ${userCode} 
            } catch (e) { 
              const isDev = ${debugLogging};
              if (isDev) {
                console.group('%cScriptFlow User Script Error', 'background: #ef4444; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 13px;');
                console.error('Script Name: ${script.name || 'Unknown'}');
                console.error('Error Type:', e.name || 'Error');
                console.error('Message:', e.message || String(e));
                console.error('Stack:', e.stack || 'No stack trace');
                console.groupEnd();
              } else {
                console.error('%c[ScriptFlow] User script error:', 'color: #ef4444; font-weight: bold;', e.message || String(e));
              }
            }
          })();
      `;
    }

    buildLazyModuleSystem(projectId) {
        return `
    const __SF_safeRemoveComments = (code) => {
        let result = '';
        let i = 0;
        let inString = false;
        let stringChar = null;
        let inBlockComment = false;
        let inLineComment = false;
        let inTemplate = false;
        let templateDepth = 0;
        
        while (i < code.length) {
            const char = code[i];
            const next = code[i + 1];
            
            if (char === '\\\\' && (inString || inTemplate) && !inBlockComment && !inLineComment) {
                result += char + (next || '');
                i += 2;
                continue;
            }
            
            if (!inString && !inTemplate && !inLineComment && char === '/' && next === '*') {
                inBlockComment = true;
                i += 2;
                continue;
            }
            
            if (inBlockComment && char === '*' && next === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            
            if (inBlockComment) {
                i++;
                continue;
            }
            
            if (!inString && !inTemplate && !inBlockComment && char === '/' && next === '/') {
                inLineComment = true;
                i += 2;
                continue;
            }
            
            if (inLineComment && (char === '\\n' || char === '\\r')) {
                inLineComment = false;
                result += char;
                i++;
                continue;
            }
            
            if (inLineComment) {
                i++;
                continue;
            }
            
            if (!inString && !inBlockComment && !inLineComment && char === '\`') {
                if (!inTemplate) {
                    inTemplate = true;
                    templateDepth = 0;
                } else if (templateDepth === 0) {
                    inTemplate = false;
                }
                result += char;
                i++;
                continue;
            }
            
            if (inTemplate && char === '$' && next === '{') {
                templateDepth++;
                result += char + next;
                i += 2;
                continue;
            }
            
            if (inTemplate && char === '}' && templateDepth > 0) {
                templateDepth--;
                result += char;
                i++;
                continue;
            }
            
            if (!inTemplate && (char === '"' || char === "'") && !inBlockComment && !inLineComment) {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = null;
                }
                result += char;
                i++;
                continue;
            }
            
            result += char;
            i++;
        }
        
        return result;
    };

    window.__SF_transform = function(code, path) {
        if (path.endsWith('.json')) {
            return 'module.exports = JSON.parse(' + JSON.stringify(String(code)) + ');';
        }

        let out = String(code);
        const exp = [];

        out = __SF_safeRemoveComments(out);

        // require.context("...", true/false, pattern)
        out = out.replace(/require\\\\.context\\\\s*\\\\(\\\\s*(['\"])([^'\"]+)\\\\1\\\\s*,\\\\s*(true|false)\\\\s*(?:,\\\\s*([^)]+))?\\\\s*\\\\)/g,
            (match, quote, directory, recursive, pattern) => {
                return \`__SF_createContext(\${JSON.stringify(directory)}, \${recursive}, \${pattern || '/\\\\\\\\.js$/'}, __currentModule)\`;
            }
        );

        // require("...")
        out = out.replace(/\\\\brequire\\\\s*\\\\(\\\\s*(['\"])([^'\"]+)\\\\1\\\\s*\\\\)/g, (m, q, rel) => {
            return '__SF_requireSync(' + JSON.stringify(rel) + ', __currentModule)';
        });

        // import * as foo from "..."
        out = out.replace(/import\\\\s+\\\\*\\\\s+as\\\\s+([A-Za-z0-9_$]+)\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/g,
            (m, id, q, rel) => {
                return \`const \${id} = __SF_requireSync(\${JSON.stringify(rel)}, __currentModule);\`;
            }
        );

        // import foo from "..." (default import)
        out = out.replace(/import\\\\s+([A-Za-z0-9_$]+)\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/g,
            (m, id, q, rel) => {
                return \`const \${id} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).default || __SF_requireSync(\${JSON.stringify(rel)}, __currentModule);\`;
            }
        );

        // import foo, { bar, baz } from "..." (combined default + named)
        out = out.replace(/import\\\\s+([A-Za-z0-9_$]+)\\\\s*,\\\\s*\\\\{\\\\s*([^}]+)\\\\}\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\3;?/g,
            (m, defaultName, names, q, rel) => {
                const parts = names.split(',').map(s => s.trim()).filter(Boolean);
                const namedImports = parts.map(p => {
                    const asMatch = p.match(/^(.+?)\\\\s+as\\\\s+(.+)$/);
                    if (asMatch) {
                        return \`const \${asMatch[2].trim()} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).\${asMatch[1].trim()};\`;
                    }
                    return \`const \${p} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).\${p};\`;
                }).join('\\\\n');
                return \`const \${defaultName} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).default || __SF_requireSync(\${JSON.stringify(rel)}, __currentModule);\\\\n\${namedImports}\`;
            }
        );

        // import { foo, bar } from "..."
        out = out.replace(/import\\\\s+\\\\{([^}]+)\\\\}\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/g, (m, names, q, rel) => {
            return names.split(',').map(p => {
                p = p.trim();
                const asMatch = p.match(/^(.+?)\\\\s+as\\\\s+(.+)$/);
                if (asMatch) {
                    return \`const \${asMatch[2].trim()} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).\${asMatch[1].trim()};\`;
                }
                return \`const \${p} = (__SF_requireSync(\${JSON.stringify(rel)}, __currentModule) || {}).\${p};\`;
            }).join('\\\\n');
        });

        // import "..." (side-effect)
        out = out.replace(/import\\\\s+(['\"])([^'\"]+)\\\\1;?/g,
            (m, q, rel) => \`__SF_requireSync(\${JSON.stringify(rel)}, __currentModule);\`
        );

        // export default async function foo()
        out = out.replace(/export\\\\s+default\\\\s+async\\\\s+function\\\\s+([A-Za-z0-9_$]+)\\\\s*\\\\(/g, (m, n) => {
            exp.push(\`module.exports.default = \${n};\`);
            return \`async function \${n}(\`;
        });

        // export default function foo()
        out = out.replace(/export\\\\s+default\\\\s+function\\\\s+([A-Za-z0-9_$]+)\\\\s*\\\\(/g, (m, n) => {
            exp.push(\`module.exports.default = \${n};\`);
            return \`function \${n}(\`;
        });

        // export default class Foo
        out = out.replace(/export\\\\s+default\\\\s+class\\\\s+([A-Za-z0-9_$]+)\\\\s*/g, (m, n) => {
            exp.push(\`module.exports.default = \${n};\`);
            return \`class \${n} \`;
        });

        // export default (anonymous)
        out = out.replace(/export\\\\s+default\\\\s+(async\\\\s+)?(function|class)(\\\\s*\\\\*)?(\\\\s*\\\\()/g, 
            (m, asyncMod, type, generator, paren) => 
                \`module.exports.default = \${asyncMod || ''}\${type}\${generator || ''}\${paren}\`
        );

        // export default <expression>
        out = out.replace(/export\\\\s+default\\\\s+/g, 'module.exports.default = ');

        // export async function foo()
        out = out.replace(/export\\\\s+async\\\\s+function\\\\s+([A-Za-z0-9_$]+)\\\\s*\\\\(/g, (m, n) => {
            exp.push(\`module.exports.\${n} = \${n};\`);
            return \`async function \${n}(\`;
        });

        // export function foo()
        out = out.replace(/export\\\\s+function\\\\s+([A-Za-z0-9_$]+)\\\\s*\\\\(/g, (m, n) => {
            exp.push(\`module.exports.\${n} = \${n};\`);
            return \`function \${n}(\`;
        });

        // export class Foo
        out = out.replace(/export\\\\s+class\\\\s+([A-Za-z0-9_$]+)\\\\s*/g, (m, n) => {
            exp.push(\`module.exports.\${n} = \${n};\`);
            return \`class \${n} \`;
        });

        // export const/let/var foo =
        out = out.replace(/export\\\\s+(const|let|var)\\\\s+([A-Za-z0-9_$]+)\\\\s*=/g, (m, k, n) => {
            exp.push(\`module.exports.\${n} = \${n};\`);
            return \`\${k} \${n} =\`;
        });

        // export { foo, bar } from "./x" (re-export with source)
        const reExportMatches = out.match(/export\\\\s+\\\\{\\\\s*([^}]+)\\\\}\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/g) || [];
        reExportMatches.forEach(stmt => {
            const match = stmt.match(/export\\\\s+\\\\{\\\\s*([^}]+)\\\\}\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/);
            if (match) {
                const [, names, , source] = match;
                const parts = names.split(',').map(s => s.trim());
                const reExports = parts.map(p => {
                    const asMatch = p.match(/^(.+?)\\\\s+as\\\\s+(.+)$/);
                    if (asMatch) {
                        const [, original, alias] = asMatch;
                        return \`module.exports.\${alias.trim()} = (__SF_requireSync(\${JSON.stringify(source)}, __currentModule) || {}).\${original.trim()};\`;
                    }
                    return \`module.exports.\${p} = (__SF_requireSync(\${JSON.stringify(source)}, __currentModule) || {}).\${p};\`;
                }).join('\\\\n');
                out = out.replace(stmt, reExports);
            }
        });

        // export { foo, bar as baz } (local)
        (out.match(/export\\\\s*\\\\{[^}]+\\\\};?/g) || []).forEach(stmt => {
            const inner = stmt.replace(/export\\\\s*\\\\{/, '').replace(/\\\\};?/, '').trim();
            inner.split(',').forEach(pair => {
                const m = pair.trim().match(/^(.+?)\\\\s+as\\\\s+(.+)$/);
                if (m) {
                    exp.push(\`module.exports.\${m[2].trim()} = typeof \${m[1].trim()} !== 'undefined' ? \${m[1].trim()} : undefined;\`);
                } else {
                    exp.push(\`module.exports.\${pair.trim()} = typeof \${pair.trim()} !== 'undefined' ? \${pair.trim()} : undefined;\`);
                }
            });
            out = out.replace(stmt, '');
        });

        // export * from "./x"
        out = out.replace(/export\\\\s+\\\\*\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\1;?/g, (m, q, rel) =>
            \`(function(m){ for (const k in m) if (k !== 'default') module.exports[k] = m[k]; })(__SF_requireSync(\${JSON.stringify(rel)}, __currentModule));\`
        );

        // export * as ns from "./x"
        out = out.replace(/export\\\\s+\\\\*\\\\s+as\\\\s+([A-Za-z0-9_$]+)\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\2;?/g, (m, ns, q, rel) =>
            \`module.exports.\${ns} = __SF_requireSync(\${JSON.stringify(rel)}, __currentModule);\`
        );

        out = out.replace(/\\\\bexport\\\\s+/g, '');

        return exp.length ? out + '\\\\n\\\\n' + exp.join('\\\\n') : out;
    };

    window.__SF_moduleCache = window.__SF_moduleCache || {};
    window.__SF_pendingModules = window.__SF_pendingModules || {};

    window.__SF_resolvePath = function(from, to) {
        if (!to.startsWith('./') && !to.startsWith('../')) return to;
        const parts = from.split('/').slice(0, -1);
        to.split('/').forEach(p => {
            if (p === '..') parts.pop();
            else if (p !== '.') parts.push(p);
        });
        return parts.join('/');
    };

    window.__SF_tryResolve = async function(path, projectId) {
        const candidates = [
            path,
            path + '.js',
            path + '.json',
            path + '/index.js',
            path + '/index.json'
        ];

        if (window.__SF_VFS) {
            for (const c of candidates) {
                if (window.__SF_VFS[c] !== undefined) {
                    return c;
                }
            }
        }

        for (const c of candidates) {
            try {
                const testCode = await chrome.runtime.sendMessage({
                    action: "getModuleFile",
                    projectId: projectId,
                    filePath: c
                });
                if (testCode !== null && testCode !== undefined) {
                    return c;
                }
            } catch (e) {}
        }

        return path;
    };

    window.__SF_requireSync = function(path, currentPath = '') {
        const resolvedPath = window.__SF_resolvePath(currentPath, path);
        const fileName = resolvedPath.split('/').pop();
        const candidates = [
            resolvedPath,
            resolvedPath + '.js',
            resolvedPath + '.json',
            resolvedPath + '/index.js',
            resolvedPath + '/index.json',
            fileName,
            fileName + '.js',
            fileName + '.json'
        ];

        for (const candidate of candidates) {
            if (window.__SF_moduleCache[candidate]) {
                return window.__SF_moduleCache[candidate].exports;
            }
        }

        throw new Error(\`ScriptFlow: Module '\${path}' (resolved: \${resolvedPath}) not loaded yet. Available: \${Object.keys(window.__SF_moduleCache).join(', ')}\`);
    };

    window.__SF_extractDeps = function(code) {
        const deps = [];
        const importRegex = /import\\\\s+(?:[A-Za-z0-9_$]+(?:\\\\s*,\\\\s*(?:\\\\*\\\\s+as\\\\s+[A-Za-z0-9_$]+|\\\\{[^}]+\\\\}))?|\\\\*\\\\s+as\\\\s+[A-Za-z0-9_$]+|\\\\{[^}]+\\\\})\\\\s+from\\\\s+(['\"])([^'\"]+)\\\\1|import\\\\s+(['\"])([^'\"]+)\\\\3/g;
        let match;
        while ((match = importRegex.exec(code)) !== null) {
            deps.push(match[2] || match[4]);
        }
        return deps;
    };

    window.__SF_require = async function(path, currentPath = '', projectId = "${projectId}") {
        const resolvedPath = window.__SF_resolvePath(currentPath, path);
        const realPath = await window.__SF_tryResolve(resolvedPath, projectId);

        if (window.__SF_moduleCache[realPath]) {
            return window.__SF_moduleCache[realPath].exports;
        }

        if (window.__SF_pendingModules[realPath]) {
            return await window.__SF_pendingModules[realPath];
        }

        const loadPromise = (async () => {
            try {
                let code = window.__SF_VFS && window.__SF_VFS[realPath];
                if (code === undefined) {
                    code = await chrome.runtime.sendMessage({
                        action: "getModuleFile",
                        projectId: projectId,
                        filePath: realPath
                    });
                }

                if (code === null || code === undefined) {
                    throw new Error(\`Module not found: \${path} (resolved: \${realPath})\`);
                }

                const deps = window.__SF_extractDeps(code);
                await Promise.all(deps.map(dep => window.__SF_require(dep, realPath, projectId)));

                const transformed = window.__SF_transform(code, realPath);
                const module = { exports: {} };
                window.__SF_moduleCache[realPath] = module;

                const require = (p) => {
                    const childPath = window.__SF_resolvePath(realPath, p);
                    const fileName = childPath.split('/').pop();
                    const candidates = [
                        childPath,
                        childPath + '.js',
                        childPath + '.json',
                        fileName,
                        fileName + '.js',
                        fileName + '.json'
                    ];

                    for (const candidate of candidates) {
                        if (window.__SF_moduleCache[candidate]) {
                            return window.__SF_moduleCache[candidate].exports;
                        }
                    }

                    throw new Error(\`Dependency '\${p}' of '\${realPath}' not loaded. Tried: \${candidates.join(', ')}\`);
                };

                const fn = new Function('module', 'exports', 'require', '__currentModule', '__SF_requireSync', transformed);
                fn(module, module.exports, require, realPath, window.__SF_requireSync);

                return module.exports;
            } catch (e) {
                delete window.__SF_moduleCache[realPath];
                console.error('ScriptFlow: Failed to load module:', realPath, e);
                throw e;
            } finally {
                delete window.__SF_pendingModules[realPath];
            }
        })();

        window.__SF_pendingModules[realPath] = loadPromise;
        return await loadPromise;
    };
`;
    }

    buildGrantedApiScript(grants = [], resources = {}, memoryInspectorEnabled = false, memoryInspectorPosition = 'top-right', debugLogging = false) {
        const effectiveGrants = Array.isArray(grants) ? grants : [];
        const masterApi = {
            GM_addStyle: `(c) => { const s = document.createElement('style'); s.innerHTML = GM_API.policy.createHTML(c); document.head.appendChild(s); return s; }`,
            GM_setValue: `(k, v) => localStorage.setItem('GM_' + k, JSON.stringify(v))`,
            GM_getValue: `(k, d) => { 
              try {
                const v = localStorage.getItem('GM_' + k); 
                if (v === null || v === '' || v === 'undefined') {
                  return d; 
                }
                return JSON.parse(v); 
              } catch(e) { 
                console.error('ScriptFlow: Failed to parse GM_getValue for key', k, 'with value:', v, e); 
                return d; 
              }
            }`,
            GM_deleteValue: `(k) => localStorage.removeItem('GM_' + k)`,
            GM_listValues: `() => Object.keys(localStorage).filter(k => k.startsWith('GM_')).map(k => k.slice(3))`,
            GM_getResourceText: `(n) => GM_API.resources[n] || null`,
            GM_openInTab: `(u) => window.open(u, '_blank')`,
            GM_setClipboard: `(t) => navigator.clipboard.writeText(t)`,
            GM_info: `{ scriptHandler: 'ScriptFlow', version: '1.0' }`,
            GM_setHTML: `(el, html) => { if (!el) return; el.innerHTML = GM_API.policy.createHTML(html); }`,
            GM_registerMenuCommand: `(label, callback, accessKey) => {
              try {
                if (!window.__SF_menuCommands) window.__SF_menuCommands = [];
                const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
                window.__SF_menuCommands.push({ id, label: String(label), callback });
                if (window.__SF_refreshMenu) window.__SF_refreshMenu();
                return id;
              } catch (e) {
                console.warn('[ScriptFlow] GM_registerMenuCommand error', e);
                return null;
              }
            }`,
            GM_download: `(arg1, arg2) => {
              const opts = typeof arg1 === 'string' ? { url: arg1, name: arg2 || 'download' } : (arg1 || {});
              const url = opts.url;
              const name = opts.name || 'download';
              if (!url) return;
              const doDownload = (blob) => {
                const a = document.createElement('a');
                const objectUrl = URL.createObjectURL(blob);
                a.href = objectUrl;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
              };
              if (opts.data) {
                doDownload(new Blob([opts.data]));
                return;
              }
              fetch(url, { headers: opts.headers || {} })
                .then(r => r.blob())
                .then(doDownload)
                .catch(e => console.warn('[ScriptFlow] GM_download error', e));
            }`,
            GM_xmlhttpRequest: `(details) => {
              return new Promise((resolve, reject) => {
                try {
                  const d = details || {};
                  const method = (d.method || 'GET').toUpperCase();
                  const url = d.url;
                  if (!url) throw new Error('GM_xmlhttpRequest: url is required');

                  const headers = d.headers || {};
                  const body = d.data !== undefined ? d.data : d.body;

                  fetch(url, { method, headers, body, credentials: d.anonymous ? 'omit' : 'include' })
                    .then(async (res) => {
                      const text = await res.text();
                      const response = {
                        responseText: text,
                        readyState: 4,
                        status: res.status,
                        statusText: res.statusText,
                        finalUrl: res.url,
                        headers: Object.fromEntries(res.headers.entries())
                      };
                      if (res.ok) {
                        d.onload && d.onload(response);
                        resolve(response);
                      } else {
                        d.onerror && d.onerror(response);
                        reject(response);
                      }
                    })
                    .catch((e) => {
                      const err = { error: e };
                      d.onerror && d.onerror(err);
                      reject(err);
                    });
                } catch (e) {
                  reject(e);
                }
              });
            }`,
            // src: https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
            // should work now
            GM_getMemory: `(options = {}) => new Promise(async (resolve, reject) => {
				const { matching = [], roots = [], maxNodes = 20000 } = options;
				const toMB = b => (b / 1048576);

				function roughSizeOfObject(object) {
					const seen = new WeakSet();
					const stack = [object];
					let bytes = 0;
					let nodes = 0;

					while (stack.length) {
					if (++nodes > maxNodes) {
						bytes += 0;
						break;
					}
					const value = stack.pop();
					if (value === null || value === undefined) continue;
					const t = typeof value;
					if (t === 'boolean') bytes += 4;
					else if (t === 'number') bytes += 8;
					else if (t === 'string') bytes += value.length * 2;
					else if (t === 'object') {
						if (seen.has(value)) continue;
						seen.add(value);
						if (Array.isArray(value)) {
						bytes += 8 + value.length * 8;
						for (let i = 0; i < value.length; i++) {
							try { stack.push(value[i]); } catch (e) {}
						}
						} else {
						try {
							for (const k in value) {
							bytes += (typeof k === 'string') ? k.length * 2 : 8;
							try { stack.push(value[k]); } catch (e) {}
							}
						} catch (e) {
							try {
							const s = JSON.stringify(value);
							bytes += s ? s.length * 2 : 0;
							} catch (err) { }
						}
						}
					} else if (t === 'function') {
						bytes += 64;
					} else {
						bytes += 4;
					}
					}
					return bytes;
				}

				function matchesAny(url, matchers) {
					if (!url) return false;
					for (const m of matchers) {
					if (m instanceof RegExp) {
						if (m.test(url)) return true;
					} else if (typeof m === 'string') {
						if (url.indexOf(m) !== -1) return true;
					}
					}
					return false;
				}

				try {
					if (window.performance && typeof window.performance.measureUserAgentSpecificMemory === 'function') {
					try {
						const memory = await window.performance.measureUserAgentSpecificMemory();
						const totalBytes = memory.bytes || 0;
						let scriptBytes = 0;
						
						if (Array.isArray(memory.breakdown) && matching && matching.length > 0) {
						scriptBytes = memory.breakdown
							.filter(b => Array.isArray(b.attribution) && b.attribution.some(a => matchesAny(a.url || '', matching)))
							.reduce((acc, b) => acc + (b.bytes || 0), 0);
						} else if (Array.isArray(memory.breakdown)) {
						const origin = window.location.origin || '';
						scriptBytes = memory.breakdown
							.filter(b => Array.isArray(b.attribution) && b.attribution.some(a => (a.url || '').startsWith(origin) || /chrome-extension:|moz-extension:|resource:/.test(a.url || '')))
							.reduce((acc, b) => acc + (b.bytes || 0), 0);
						}

						let manual = null;
						if (roots && roots.length > 0) {
						manual = {};
						for (const name of roots) {
							try {
							const obj = window[name];
							if (obj === undefined) {
								manual[name] = { bytes: 0, note: 'not found' };
							} else {
								const bytes = roughSizeOfObject(obj);
								manual[name] = { bytes, mb: toMB(bytes) };
							}
							} catch (e) {
							manual[name] = { bytes: 0, error: e.message };
							}
						}
						}

						return resolve({
						method: 'measureUserAgentSpecificMemory',
						totalBytes,
						scriptBytes,
						totalMB: toMB(totalBytes),
						scriptMB: toMB(scriptBytes),
						manual
						});
					} catch (e) {}
					}
				} catch (e) {}

				try {
					if (window.performance && window.performance.memory) {
					const mem = window.performance.memory;
					const used = mem.usedJSHeapSize || 0;
					const totalJS = mem.totalJSHeapSize || 0;
					const limit = mem.jsHeapSizeLimit || 0;

					let manual = null;
					if (roots && roots.length > 0) {
						manual = {};
						for (const name of roots) {
						try {
							const obj = window[name];
							if (obj === undefined) manual[name] = { bytes: 0, note: 'not found' };
							else {
							const bytes = roughSizeOfObject(obj);
							manual[name] = { bytes, mb: toMB(bytes) };
							}
						} catch (e) {
							manual[name] = { bytes: 0, error: e.message };
						}
						}
					}

					return resolve({
						method: 'performance.memory',
						usedJSHeapSize: used,
						totalJSHeapSize: totalJS,
						jsHeapSizeLimit: limit,
						usedMB: toMB(used),
						totalMB: toMB(totalJS),
						manual
					});
					}
				} catch (e) {}

				try {
					if (roots && roots.length > 0) {
					const manual = {};
					let total = 0;
					for (const name of roots) {
						try {
						const obj = window[name];
						if (obj === undefined) {
							manual[name] = { bytes: 0, note: 'not found' };
						} else {
							const bytes = roughSizeOfObject(obj);
							manual[name] = { bytes, mb: toMB(bytes) };
							total += bytes;
						}
						} catch (e) {
						manual[name] = { bytes: 0, error: e.message };
						}
					}
					return resolve({
						method: 'manual',
						manual,
						approximateScriptBytes: total,
						approximateScriptMB: toMB(total)
					});
					} else {
					return resolve({
						method: 'unavailable',
						error: 'No memory measurement API available in this browser',
						usedMB: 0,
						totalMB: 0
					});
					}
				} catch (e) {
					return reject(e);
				}
			})`
        };

        let apiParts = [];

        const policyCreation = `
			let policy = { createHTML: (s) => s, createScript: (s) => s };
			try {
				if (window.trustedTypes && window.trustedTypes.createPolicy) {
					policy = window.trustedTypes.createPolicy('scriptflow#api', {
						createHTML: input => input,
						createScript: input => input,
					});
				}
			} catch (e) { 
				if (e.message.includes('already exists')) {
					policy = window.trustedTypes.policies.get('scriptflow#api');
				} else {
					console.warn('ScriptFlow: Could not create Trusted Types policy.', e);
				}
			}
		`;

        const polyfillInnerHtml = `
			try {
				if (window.trustedTypes && Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')) {
					const originalSetter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;
					Object.defineProperty(Element.prototype, 'innerHTML', {
						set: function(value) {
							const trustedValue = policy.createHTML(String(value));
							originalSetter.call(this, trustedValue);
						}
					});
				}
			} catch (e) { console.warn('ScriptFlow: Could not polyfill innerHTML.', e); }
		`;

        const fetchBridge = `
			(function() {
				const pendingFetches = new Map();
				let fetchIdCounter = 0;
				
				window.addEventListener('message', function(event) {
					if (event.data && event.data.type === 'SF_FETCH_RESPONSE') {
						const { requestId, ok, status, statusText, headers, body, error } = event.data;
						const pending = pendingFetches.get(requestId);
						
						if (pending) {
							pendingFetches.delete(requestId);
							
							if (error) {
								pending.reject(new TypeError(error));
							} else {
								const responseBody = body !== undefined && body !== null ? String(body) : '';
								
								const response = {
									ok: ok,
									status: status,
									statusText: statusText,
									headers: new Map(Object.entries(headers || {})),
									url: pending.url,
									text: () => Promise.resolve(responseBody),
									json: () => {
										if (!responseBody || responseBody.trim() === '') {
											console.error('[ScriptFlow Fetch] Attempted to parse empty body as JSON');
											return Promise.reject(new SyntaxError("JSON.parse: unexpected end of data or empty body"));
										}
										try {
											const parsed = JSON.parse(responseBody);
											return Promise.resolve(parsed);
										} catch (e) {
											console.error('[ScriptFlow Fetch] JSON parse error:', e.message, 'Body:', responseBody.substring(0, 100));
											return Promise.reject(new SyntaxError('JSON.parse: ' + e.message + ' (body preview: "' + responseBody.substring(0, 50) + '...")'));
										}
									},
									blob: () => Promise.resolve(new Blob([responseBody])),
									arrayBuffer: () => {
										const buf = new ArrayBuffer(responseBody.length);
										const view = new Uint8Array(buf);
										for (let i = 0; i < responseBody.length; i++) {
											view[i] = responseBody.charCodeAt(i);
										}
										return Promise.resolve(buf);
									}
								};
								pending.resolve(response);
							}
						}
					}
				});
				
				const originalFetch = window.fetch;
				window.fetch = function(url, options = {}) {					
					return new Promise((resolve, reject) => {
						const requestId = ++fetchIdCounter;
						
						pendingFetches.set(requestId, {
							resolve: resolve,
							reject: reject,
							url: url
						});
						
						window.postMessage({
							type: 'SF_FETCH_REQUEST',
							requestId: requestId,
							url: typeof url === 'string' ? url : url.toString(),
							method: options.method || 'GET',
							headers: options.headers || {},
							credentials: options.credentials || 'include',
							body: options.body
						}, '*');
						
						setTimeout(() => {
							if (pendingFetches.has(requestId)) {
								pendingFetches.delete(requestId);
								reject(new TypeError('Fetch timeout after 30s'));
							}
						}, 30000);
					});
				};
				
				if (GM_API.debugLogging) console.log('%c[ScriptFlow] Fetch bridge active', 'color: #10b981; font-weight: bold;');
			})();
		`;

        const passiveEventFix = `
			(function() {
				const originalAddEventListener = EventTarget.prototype.addEventListener;
				const passiveEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'mousewheel'];
				
				EventTarget.prototype.addEventListener = function(type, listener, options) {
					if (passiveEvents.includes(type)) {
						if (typeof options === 'object' && options !== null) {
							if (!('passive' in options)) {
								options.passive = true;
							}
						} else if (typeof options === 'boolean') {
							options = { capture: options, passive: true };
						} else {
							options = { passive: true };
						}
					}
					return originalAddEventListener.call(this, type, listener, options);
				};
				
				if (GM_API.debugLogging) console.log('%c[ScriptFlow] Passive event listeners enabled', 'color: #10b981');
			})();
		`;

        if (memoryInspectorEnabled && !effectiveGrants.includes('GM_getMemory')) {
            effectiveGrants.push('GM_getMemory');
        }

        if (!effectiveGrants.includes('none')) {
            if (!effectiveGrants.includes('GM_setHTML')) {
                effectiveGrants.push('GM_setHTML');
            }
            effectiveGrants.forEach(g => {
                if (masterApi[g]) {
                    apiParts.push(`${g}: ${masterApi[g]}`);
                }
            });
        } else {
            if (memoryInspectorEnabled && masterApi['GM_getMemory']) {
                apiParts.push(`GM_getMemory: ${masterApi['GM_getMemory']}`);
            }
        }

        const resourceEntries = Object.entries(resources).map(([k, v]) => `'${k}': \`${String(v).replace(/`/g, '\\`')}\``).join(', ');

      return `
          ${policyCreation}
          const GM_API = { 
              unsafeWindow: window,
              GM_log: console.log.bind(console, '%c[SF]', 'background:#6d63ff;color:white;padding:2px 4px;border-radius:2px;'),
              memoryInspectorEnabled: ${memoryInspectorEnabled},
              memoryInspectorPosition: '${memoryInspectorPosition}',
              debugLogging: ${debugLogging}${apiParts.length > 0 ? ',' : ''}
              ${apiParts.join(',\n        ')}${apiParts.length > 0 ? ',' : ''}
              policy: policy,
              resources: { ${resourceEntries} }
          };
          window.GM = GM_API; 
          Object.assign(window, GM_API);
          ${polyfillInnerHtml}
          ${fetchBridge}
          ${passiveEventFix}
      `;
    }

    buildAsyncModuleSystem(script) {
        return `
        window.__SF_executeModule = (code, module, require, resolvedPath, dirname) => {
            const executableCode = \`(function(module, exports, require, __filename, __dirname) { \${code} })\`;
            try {
                let fn;
                if (window.trustedTypes && window.trustedTypes.createPolicy) {
                    const policy = window.trustedTypes.defaultPolicy || window.trustedTypes.createPolicy('scriptflow#module-loader', { createScript: input => input });
                    const trustedScript = policy.createScript(executableCode);
                    fn = eval(trustedScript);
                } else {
                    fn = eval(executableCode);
                }
                fn(module, module.exports, require, resolvedPath, dirname);
            } catch (e) {
                console.error('ScriptFlow: Error executing module:', resolvedPath, e);
                throw e;
            }
        };

        window.__SF_VFS = window.__SF_VFS || {};
        window.__SF_moduleCache = {};
        window.__SF_isFetching = new Map();

        window.__SF_resolvePath = function(from, to) {
            if (!to.startsWith('./') && !to.startsWith('../')) return to;
            const parts = from.split('/').slice(0, -1);
            to.split('/').forEach(p => { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
            return parts.join('/');
        };

        window.__SF_require = async function(path, currentPath = '') {
            const resolvedPath = window.__SF_resolvePath(currentPath, path);
            if (window.__SF_moduleCache[resolvedPath]) return window.__SF_moduleCache[resolvedPath].exports;
            if (window.__SF_isFetching.has(resolvedPath)) return await window.__SF_isFetching.get(resolvedPath);

            const fetchPromise = new Promise(async (resolve, reject) => {
                try {
                    const code = window.__SF_VFS[resolvedPath] ?? await chrome.runtime.sendMessage({ action: "getModuleFile", projectId: "${script.id}", filePath: resolvedPath });
                    if (code === null) throw new Error(\`Module not found: \${resolvedPath}\`);
                    
                    const module = { exports: {} };
                    const require = (p) => window.__SF_require(p, resolvedPath);
                    const dirname = resolvedPath.split('/').slice(0, -1).join('/');
                    
                    __SF_executeModule(code, module, require, resolvedPath, dirname);

                    window.__SF_moduleCache[resolvedPath] = module;
                    resolve(module.exports);
                } catch (e) {
                    reject(e);
                } finally {
                    window.__SF_isFetching.delete(resolvedPath);
                }
            });
            window.__SF_isFetching.set(resolvedPath, fetchPromise);
            return await fetchPromise;
        };`;
    }

    buildModuleSystem() {
        return `
        window.__SF_executeModule = (code, module, require, resolvedPath, dirname) => {
            const executableCode = \`(function(module, exports, require, __filename, __dirname) { \${code} })\`;
            try {
                let fn;
                if (window.trustedTypes && window.trustedTypes.createPolicy) {
                    const policy = window.trustedTypes.defaultPolicy || window.trustedTypes.createPolicy('scriptflow#module-loader', { createScript: input => input });
                    const trustedScript = policy.createScript(executableCode);
                    fn = eval(trustedScript);
                } else {
                    fn = eval(executableCode);
                }
                fn(module, module.exports, require, resolvedPath, dirname);
            } catch (e) {
                console.error('ScriptFlow: Error executing module:', resolvedPath, e);
                throw e;
            }
        };

        window.__SF_moduleCache = {};
        window.__SF_resolvePath = function(from, to) {
            if (!to.startsWith('./') && !to.startsWith('../')) return to;
            const parts = from.split('/').slice(0, -1);
            to.split('/').forEach(p => { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
            return parts.join('/');
        };
        window.__SF_require = function(path, currentPath = '') {
            const resolvedPath = window.__SF_resolvePath(currentPath, path);
            if (window.__SF_moduleCache[resolvedPath]) return window.__SF_moduleCache[resolvedPath].exports;
            if (!window.__SF_VFS || !window.__SF_VFS.hasOwnProperty(resolvedPath)) throw new Error('ScriptFlow: Module not found: ' + resolvedPath);
            const module = { exports: {} };
            const require = (p) => window.__SF_require(p, resolvedPath);
            const dirname = resolvedPath.split('/').slice(0, -1).join('/');
            const code = window.__SF_VFS[resolvedPath];

            __SF_executeModule(code, module, require, resolvedPath, dirname);
            
            window.__SF_moduleCache[resolvedPath] = module;
            return module.exports;
        };`;
    }

    async getStoredScripts() {
        return (await chrome.storage.local.get('scripts')).scripts || [];
    }

    handleMessage(request, sender, sendResponse) {
        (async () => {
            try {
                switch (request.action) {
                    case 'getScripts':
                        sendResponse({
                            scripts: await this.getStoredScripts()
                        });
                        break;

                    case 'getScript':
                        const script = (await this.getStoredScripts()).find(s => s.id === request.scriptId);
                        sendResponse({
                            script: script
                        });
                        break;

                    case 'saveScript':
                        const scriptToSave = request.script;
                        const scripts = await this.getStoredScripts();
                        const idx = scripts.findIndex(s => s.id === scriptToSave.id);
                        scriptToSave.lastModified = Date.now();

                        if (idx >= 0) {
                            scripts[idx] = scriptToSave;
                        } else {
                            scriptToSave.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
                            scripts.push(scriptToSave);
                        }

                        await chrome.storage.local.set({
                            scripts
                        });
                        await this.updateScriptRegistration(scriptToSave);
                        sendResponse({
                            success: true,
                            scriptId: scriptToSave.id
                        });
                        break;

                    case 'deleteScript': {
                        const scripts = await this.getStoredScripts();
                        const exists = scripts.some(s => s.id === request.scriptId);

                        if (!exists) {
                            console.warn('deleteScript: script not found in storage', request.scriptId);
                            sendResponse({
                                success: false,
                                error: 'not_found'
                            });
                            break;
                        }

                        const remainingScripts = scripts.filter(s => s.id !== request.scriptId);
                        await chrome.storage.local.set({
                            scripts: remainingScripts
                        });

                        try {
                            await chrome.userScripts.unregister({
                                ids: [request.scriptId]
                            });
                        } catch (e) {
                            console.warn('unregister failed, continuing anyway', e);
                        }

                        sendResponse({
                            success: true
                        });
                        break;
                    }

                    case 'toggleScript':
                        const allScripts = await this.getStoredScripts();
                        const scriptToToggle = allScripts.find(x => x.id === request.scriptId);
                        if (scriptToToggle) {
                            scriptToToggle.enabled = request.enabled;
                            await chrome.storage.local.set({
                                scripts: allScripts
                            });
                            await this.updateScriptRegistration(scriptToToggle);
                        }
                        sendResponse({
                            success: true
                        });
                        break;

                    case 'syncScripts':
                        await this.syncAllScripts();
                        sendResponse({
                            success: true
                        });
                        break;

                    case 'fetch':
                        try {
                            const fetchOptions = {
                                method: request.method || 'GET',
                                credentials: request.credentials || 'include'
                            };
                            if (request.headers) fetchOptions.headers = request.headers;
                            if (request.body) fetchOptions.body = request.body;

                            const response = await fetch(request.url, fetchOptions);
                            let text = '';
                            try {
                                text = await response.text();
                            } catch (textError) {
                                console.error('ScriptFlow: Error reading response text', textError);
                                text = '';
                            }

                            sendResponse({
                                ok: response.ok,
                                status: response.status,
                                statusText: response.statusText,
                                headers: Object.fromEntries(response.headers.entries()),
                                body: text
                            });
                        } catch (error) {
                            sendResponse({
                                ok: false,
                                status: 0,
                                statusText: error.message || 'Network Error',
                                error: error.message || 'Network Error',
                                body: '',
                                headers: {}
                            });
                        }
                        break;

                    case 'buildScriptCode':
                        const scriptToBuild = (await this.getStoredScripts()).find(s => s.id === request.scriptId);
                        if (scriptToBuild) {
                            const builtCode = await this.buildFinalCode(scriptToBuild);
                            sendResponse({
                                success: true,
                                code: builtCode
                            });
                        } else {
                            sendResponse({
                                success: false,
                                error: 'Script not found'
                            });
                        }
                        break;

                    case 'getModuleFile':
                        const project = (await this.getStoredScripts()).find(s => s.id === request.projectId);
                        const fileContent = await this.getFileContent(project, request.filePath);
                        sendResponse(fileContent);
                        break;

                    case 'updateScriptTime':
                        const {
                            scriptId, timeSpent
                        } = request;
                        const scriptsToUpdate = await this.getStoredScripts();
                        const scriptToUpdate = scriptsToUpdate.find(s => s.id === scriptId);

                        if (scriptToUpdate) {
                            scriptToUpdate.timeSpent = timeSpent;
                            await chrome.storage.local.set({
                                scripts: scriptsToUpdate
                            });
                            sendResponse({
                                success: true
                            });
                        } else {
                            sendResponse({
                                success: false,
                                error: 'Script not found'
                            });
                        }
                        break;
                    case 'installScriptRequest':
                        this.installScriptFromUrl(request.url)
                            .then((newScriptId) => {
                                sendResponse({
                                    success: true,
                                    scriptId: newScriptId
                                });
                                chrome.tabs.create({
                                    url: `pages/editor/editor.html?id=${newScriptId}`
                                });
                            })
                            .catch(err => {
                                console.error("Install failed:", err);
                                sendResponse({
                                    success: false,
                                    error: err.message
                                });
                            });
                        break;
                    case 'buildBundledUserscript':
                        const allScriptss = await this.getStoredScripts();
                        const scriptToBundle = allScriptss.find(s => s.id === request.scriptId);
                        if (scriptToBundle) {
                            let bundledCode = await this.buildFinalCode(scriptToBundle);
                            const name = scriptToBundle.name || 'Bundled Script';
                            const description = scriptToBundle.description || 'Multi-file project bundled by ScriptFlow';
                            const matches = Array.isArray(scriptToBundle.matches) ? scriptToBundle.matches : ['*://*/*'];
                            const runAt = scriptToBundle.runAt || 'document-idle';
                            const grants = Array.isArray(scriptToBundle.grant) ? scriptToBundle.grant : [];

                            const header = `// ==UserScript==
// @name         ${name}
// @description  ${description}
${matches.map(m => `// @match        ${m}`).join('\n')}
${grants.length ? grants.map(g => `// @grant        ${g}`).join('\n') : '// @grant        none'}
// @run-at       ${runAt}
// @version      1.0.0
// @author       ScriptFlow
// ==/UserScript==
                    `;

                            sendResponse({
                                success: true,
                                bundledCode: header + bundledCode
                            });
                        } else {
                            sendResponse({
                                success: false,
                                error: 'Script not found'
                            });
                        }
                        break;
                    case 'buildConsoleCode': {
                        try {
                            const userCode = String(request.code || '');
                            const callbackId = String(request.callbackId || '');
                            const grant = Array.isArray(request.grant) ? request.grant : ['*'];
                            const require = Array.isArray(request.require) ? request.require : [];

                            const meta = {
                                grant,
                                require,
                                'run-at': 'document-idle'
                            };

                            const lines = [];
                            lines.push(`/* @ScriptFlow ${JSON.stringify(meta)} */`);
                            lines.push(`(async () => {`);
                            lines.push(`  try {`);
                            lines.push(`    const __sf_userFn = async () => {`);
                            lines.push(userCode);
                            lines.push(`    };`);
                            lines.push(`    const __sf_result = await __sf_userFn();`);
                            lines.push(
                                `    if (window[${JSON.stringify(callbackId)}]) window[${JSON.stringify(callbackId)}]({` +
                                ` success: true, result: __sf_result !== undefined ? String(__sf_result) : 'undefined', type: typeof __sf_result` +
                                `});`
                            );
                            lines.push(`  } catch (e) {`);
                            lines.push(
                                `    if (window[${JSON.stringify(callbackId)}]) window[${JSON.stringify(callbackId)}]({` +
                                ` success: false, error: (e && e.message) ? e.message : String(e), stack: e && e.stack` +
                                `});`
                            );
                            lines.push(`  }`);
                            lines.push(`})();`);

                            const tempScript = {
                                id: 'sf-console',
                                type: 'single-file',
                                code: lines.join('\n'),
                            };

                            const builtCode = await this.buildFinalCode(tempScript);
                            sendResponse({
                                success: true,
                                code: builtCode
                            });
                        } catch (err) {
                            sendResponse({
                                success: false,
                                error: err?.message || String(err)
                            });
                        }
                        break;
                    }
                    default:
                        sendResponse({
                            success: false,
                            error: 'Unknown action'
                        });
                }
            } catch (error) {
                console.error('ScriptFlow: Message handler error', error);
                sendResponse({
                    success: false,
                    error: error.message
                });
            }
        })();
        return true;
    }
}

new ScriptManager();