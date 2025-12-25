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
const manifest = chrome.runtime.getManifest();
class ScriptFlowEditor {
    // sets up all the initial state and finds dom elements
    constructor() {
        this.pipWindow = null;
        this.script = null;
        this.scriptId = null;
        this.isSaving = false;
        this.searchState = null;
        this.matches = [];
        this.grants = [];
        this.editor = null;
        this.scripts = [];
        this.mode = 'extension';
        this.fileHandle = null;
        this.workspaceHandle = null;
        this.idb = new IDBHelper('ScriptFlowDB', 3);
        this.projectEntryPoint = null;
        
        // this might be dead weight, but for now ima keep it as i have a plan for it soon
        this.lastGitRepoUrl = null;
        this.lastGitBranch = null;

        this.fileCache = new Map();
        this.largeFileSize = 200 * 1024;
        this.largeLineCount = 5000;
        this.currentFile = null;
        this.currentPath = null;
        this.isLargeFile = false;

        this.saveBtn = document.getElementById('saveBtn');
        this.explorer = document.querySelector('.file-explorer-sidebar');
        this.metadata = document.querySelector('.sidebar');
        this.editorWrapper = document.getElementById('editor-wrapper');
        this.isPreviewing = false;

        this.git = window.git;
        this.http = window.GitHttp;
        this.fs = new LightningFS('scriptflow_git_filesystem');
        this.gitFS = this.fs.promises;
        this.gitDir = '/repo';
        this.multiFileGitDir = '/multifile_git';
        this.gitModal = document.getElementById('gitModal');
        this.gitLogs = document.getElementById('gitLogs');

        this.commandPalette = {
            overlay: document.getElementById('commandPaletteOverlay'),
            input: document.getElementById('commandPaletteInput'),
            list: document.getElementById('commandPaletteList')
        };

        this.isPaletteOpen = false;
        this.commands = [];
        this.searchMarkers = [];
        this.saveCounter = 0;
        this.savesUntilPrompt = 5;
        this.currentVersion = manifest.version;

        this.templates = {
            basic: `/*
@ScriptFlow
{
  "name": "New Script",
  "description": "A brief description of your script",
  "match": [
    "https://example.com/*"
  ]
}
*/

(function() {
    'use strict';
    
    console.log('ScriptFlow script loaded!');
    
})();`,

            dom: `/*
@ScriptFlow
{
  "name": "DOM Manipulation Template",
  "description": "Template for DOM manipulation tasks",
  "match": [
    "https://example.com/*"
  ],
  "grant": ["GM_addStyle"]
}
*/

(function() {
    'use strict';
    
    document.addEventListener('DOMContentLoaded', () => {
        document.title = 'Modified by ScriptFlow';
        GM_addStyle(\`.custom-highlight { background-color: yellow !important; }\`);
        document.querySelectorAll('p').forEach(el => el.classList.add('custom-highlight'));
    });
})();`,

            ajax: `/*
@ScriptFlow
{
  "name": "AJAX Interceptor Template",
  "description": "Template for intercepting AJAX requests",
  "match": [
    "https://example.com/*"
  ]
}
*/

(function() {
    'use strict';
    
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        console.log('Fetch Request Intercepted:', url, options);
        return originalFetch.apply(this, arguments)
            .then(response => {
                console.log('Fetch Response Intercepted:', response.status, response.url);
                return response;
            });
    };
})();`,

            css: `/*
@ScriptFlow
{
  "name": "CSS Injection Template",
  "description": "Template for injecting custom CSS",
  "match": [
    "https://example.com/*"
  ],
  "grant": ["GM_addStyle"]
}
*/

(function() {
    'use strict';
    
    GM_addStyle(\`
        .ads, .advertisement, .popup { display: none !important; }
        body { font-family: 'Segoe UI', sans-serif !important; }
    \`);
})();`,

            utility: `/*
@ScriptFlow
{
  "name": "Utility Functions Template",
  "description": "Template with useful utility functions",
  "match": [
    "https://example.com/*"
  ],
  "grant": ["GM_getValue", "GM_setValue"]
}
*/

(function() {
    'use strict';
    
    const Utils = {
        waitForElement: (selector, timeout = 5000) => new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                reject(new Error(\`Element '\${selector}' not found\`));
            }, timeout);
        }),
        storage: {
            get: (key, def = null) => GM_getValue(key, def),
            set: (key, val) => GM_setValue(key, val),
        }
    };
    
    Utils.waitForElement('body').then(el => console.log('Body is ready:', el));
})();`
        };


        // time tracking
        this.sessionStartTime = Date.now();
        this.timeTracker = null;
        this.setupTimeTracking();
        this.init();
    }

    setupTimeTracking() {
        this.sessionStartTime = Date.now();
        this.lastActivityTime = Date.now();
        this.isActive = true;
        this.activityTimeout = null;

        const updateActivity = () => {
            this.lastActivityTime = Date.now();
            if (!this.isActive) {
                this.isActive = true;
            }

            clearTimeout(this.activityTimeout);
            this.activityTimeout = setTimeout(() => {
                this.isActive = false;
            }, 30000);
        };

        if (this.editor) {
            this.editor.onDidChangeModelContent(() => updateActivity());
            this.editor.onDidChangeCursorPosition(() => updateActivity());
        }

        document.addEventListener('mousemove', updateActivity);
        document.addEventListener('keydown', updateActivity);
        document.addEventListener('click', updateActivity);
        document.addEventListener('scroll', updateActivity);

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.isActive = false;
            } else {
                updateActivity();
            }
        });

        this.timeTracker = setInterval(() => {
            if (!this.script || !this.scriptId) return;

            const now = Date.now();
            if (this.isActive && (now - this.lastActivityTime) <= 30000) {
                const elapsed = Math.floor((now - this.sessionStartTime) / 1000);
                const previousTime = this.script.timeSpent || 0;
                this.script.timeSpent = previousTime + Math.min(elapsed, 60);
                this.sessionStartTime = now;

                chrome.runtime.sendMessage({
                    action: 'updateScriptTime',
                    scriptId: this.scriptId,
                    timeSpent: this.script.timeSpent
                }).catch(err => console.error(err));
            } else {
                this.sessionStartTime = now;
            }
        }, 10000);

        window.addEventListener('beforeunload', () => {
            if (this.script && this.scriptId && this.isActive) {
                const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
                const previousTime = this.script.timeSpent || 0;
                this.script.timeSpent = previousTime + elapsed;

                chrome.runtime.sendMessage({
                    action: 'updateScriptTime',
                    scriptId: this.scriptId,
                    timeSpent: this.script.timeSpent
                });
            }
        });
    }

    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}h`;
        } else {
            return `${hours}h ${minutes}m`;
        }
    }

    populateRepoHistoryDropdown(history) {
        const select = document.getElementById('repoHistorySelect');
        if (!select) return;

        select.options.length = 1;
        select.selectedIndex = 0;

        if (history && history.length > 0) {
            history.forEach(url => {
                const option = document.createElement('option');
                option.value = url;

                try {
                    const urlObj = new URL(url);
                    const pathParts = urlObj.pathname.split('/').filter(p => p);
                    option.textContent = pathParts.slice(-2).join('/').replace(/\.git$/, '');
                } catch (e) {
                    option.textContent = url.length > 30 ? '...' + url.slice(-27) : url;
                }

                select.appendChild(option);
            });
            select.style.display = 'block';
        } else {
            select.style.display = 'none';
        }
    }

    async updateRepoHistory(url) {
        if (!url || !url.startsWith('https://')) return;

        try {
            const data = await chrome.storage.local.get('repoHistory');
            let history = data.repoHistory || [];

            history = history.filter(item => item !== url);

            history.unshift(url);

            history = history.slice(0, 10);

            await chrome.storage.local.set({
                repoHistory: history
            });
            this.populateRepoHistoryDropdown(history);
        } catch (err) {
            console.error("Error updating repo history:", err);
        }
    }

    getGitDir() {
        if (this.mode === 'multi-file-edit') {
            return this.multiFileGitDir;
        }
        return this.gitDir;
    }

    updateFileTreeHighlights() {
        const tree = document.getElementById('fileTree');
        if (!tree) return;

        const oldEntry = tree.querySelector('.tree-item.entry-point');
        if (oldEntry) oldEntry.classList.remove('entry-point');

        if (this.projectEntryPoint) {
            const newEntry = tree.querySelector(`.tree-item[data-path="${this.projectEntryPoint}"]`);
            if (newEntry) {
                newEntry.classList.add('entry-point');
            }
        }
    }

    setupSourceControl() {
        this.sourceControl = {
            changedFiles: [],
            stagedFiles: new Set(),
            commitMessage: '',
            showDiff: false,
            selectedFile: null
        };
    }

    async syncMultiFileToGit() {
        if (!this.script || !this.script.files) {
            console.warn('syncMultiFileToGit: No script or files to sync');
            return;
        }

        if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
            this.script.files[this.currentPath] = this.editor.getValue();
        }

        try {
            const gitDir = this.multiFileGitDir;

            try {
                await this.gitFS.stat(gitDir);
            } catch (e) {
                await this.gitFS.mkdir(gitDir);
                await this.git.init({
                    fs: this.fs,
                    dir: gitDir
                });
            }

            if (this.script.githubRepo?.url) {
                try {
                    const remotes = await this.git.listRemotes({
                        fs: this.fs,
                        dir: gitDir
                    });

                    const hasOrigin = remotes.some(r => r.remote === 'origin');

                    if (!hasOrigin) {
                        await this.git.addRemote({
                            fs: this.fs,
                            dir: gitDir,
                            remote: 'origin',
                            url: this.script.githubRepo.url
                        });
                    } else {
                        const origin = remotes.find(r => r.remote === 'origin');
                        if (origin.url !== this.script.githubRepo.url) {
                            await this.git.deleteRemote({
                                fs: this.fs,
                                dir: gitDir,
                                remote: 'origin'
                            });
                            await this.git.addRemote({
                                fs: this.fs,
                                dir: gitDir,
                                remote: 'origin',
                                url: this.script.githubRepo.url
                            });
                        }
                    }
                } catch (remoteErr) {
                    console.warn('Remote configuration:', remoteErr);
                }
            }

            const entries = await this.gitFS.readdir(gitDir);
            for (const entry of entries) {
                if (entry === '.git') continue;
                await this.deleteRecursive(`${gitDir}/${entry}`);
            }

            console.log(`[syncMultiFileToGit] Writing ${Object.keys(this.script.files).length} files`);

            for (const [path, content] of Object.entries(this.script.files)) {
                const fullPath = `${gitDir}/${path}`;
                const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));

                await this.gitFS.mkdir(dir, {
                    recursive: true
                }).catch(() => {});

                if (typeof content === 'string' && content.startsWith('data:image/')) {
                    const base64Data = content.split(',')[1];
                    const binaryData = atob(base64Data);
                    const bytes = new Uint8Array(binaryData.length);
                    for (let i = 0; i < binaryData.length; i++) {
                        bytes[i] = binaryData.charCodeAt(i);
                    }
                    await this.gitFS.writeFile(fullPath, bytes);
                } else {
                    await this.gitFS.writeFile(fullPath, content, 'utf8');
                }
            }

            console.log('[syncMultiFileToGit] Sync complete');
        } catch (err) {
            console.error('Error syncing multi-file to git:', err);
            throw err;
        }
    }

    async syncGitToMultiFile() {
        if (!this.script) return;

        try {
            const files = {};
            const gitDir = this.multiFileGitDir;

            async function readDir(fs, dirPath, basePath = '') {
                const entries = await fs.readdir(dirPath);

                for (const entry of entries) {
                    if (entry === '.git') continue;

                    const fullPath = `${dirPath}/${entry}`;
                    const relativePath = basePath ? `${basePath}/${entry}` : entry;

                    const stat = await fs.stat(fullPath);

                    if (stat.isDirectory()) {
                        await readDir(fs, fullPath, relativePath);
                    } else {
                        const content = await fs.readFile(fullPath, 'utf8');
                        files[relativePath] = content;
                    }
                }
            }

            await readDir(this.gitFS, gitDir);

            this.script.files = files;

            this.buildTreeFromObject(this.script.files, new Set());

            if (this.currentPath && files[this.currentPath]) {
                this.editor.setValue(files[this.currentPath]);
            }

            await chrome.runtime.sendMessage({
                action: 'saveScript',
                script: this.script
            });

        } catch (err) {
            console.error('Error syncing git to multi-file:', err);
            throw err;
        }
    }

    async pushMultiFile() {
        if (!this.script || !this.script.files) {
            this.setStatus('No project loaded');
            return;
        }

        if (!this.script.githubRepo?.url) {
            const url = prompt('Enter GitHub repository URL:', 'https://github.com/username/repo.git');
            if (!url) return;

            let branch = prompt('Enter branch name:', 'main');
            if (!branch) branch = 'main';

            this.script.githubRepo = {
                url,
                branch
            };

            document.getElementById('repoUrl').value = url;
            document.getElementById('branch').value = branch;
        }

        const url = this.script.githubRepo.url;
        const branch = this.script.githubRepo.branch || 'main';

        this.gitModal.classList.add('visible');
        this.logGit('Pushing multi-file project to GitHub...');

        try {
            await this.syncMultiFileToGit();

            this.logGit('Staging changes...');
            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: this.gitDir
            });

            let hasChanges = false;
            for (const row of status) {
                const path = row[0];
                const workdir = row[2];

                if (workdir === 0) {
                    await this.git.remove({
                        fs: this.fs,
                        dir: this.gitDir,
                        filepath: path
                    });
                    this.logGit(` - Staged deletion: ${path}`);
                    hasChanges = true;
                } else if (workdir === 2 || workdir === 3) {
                    await this.git.add({
                        fs: this.fs,
                        dir: this.gitDir,
                        filepath: path
                    });
                    this.logGit(` - Staged change: ${path}`);
                    hasChanges = true;
                }
            }

            if (!hasChanges) {
                this.logGit('No changes to commit');
                this.gitModal.classList.remove('visible');
                return;
            }

            this.logGit('Committing...');
            const sha = await this.git.commit({
                fs: this.fs,
                dir: this.gitDir,
                message: `Update from ScriptFlow: ${this.script.name}`,
                author: {
                    name: 'ScriptFlow',
                    email: 'bot@scriptflow.app'
                }
            });

            this.logGit(`Committed: ${sha.substring(0, 7)}`);

            try {
                await this.git.branch({
                    fs: this.fs,
                    dir: this.gitDir,
                    ref: branch,
                    checkout: true
                });
            } catch (e) {}

            this.logGit('Pushing...');
            const result = await this.git.push({
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                onAuth: () => this.getAuth(),
                force: true,
                ref: branch
            });

            if (this.editorSettings.useCorsProxy) {
                result.corsProxy = 'https://cors.isomorphic-git.org';
            }

            if (result?.ok) {
                this.logGit('Push successful!');
                this.saveCounter = 0;
                await this.updateRepoHistory(url);

                await chrome.runtime.sendMessage({
                    action: 'saveScript',
                    script: this.script
                });

                this.setStatus(`Pushed to ${url}`, true, 'success');
                this.gitModal.classList.remove('visible');

                await this.refreshSourceControl();
            } else {
                const error = result.errors ? result.errors.join(', ') : 'Unknown error';
                throw new Error(error);
            }

        } catch (err) {
            this.logGit(`PUSH FAILED: ${err.message}`);
            console.error(err);
        }
    }

    async pullMultiFile() {
        if (!this.script?.githubRepo?.url) {
            this.setStatus('No GitHub repository configured');
            return;
        }

        const url = this.script.githubRepo.url;
        const branch = this.script.githubRepo.branch || 'main';

        this.gitModal.classList.add('visible');
        this.logGit('Pulling changes from GitHub...');

        try {
            try {
                await this.gitFS.stat(this.gitDir);
            } catch (e) {
                this.logGit('Cloning repository...');
                await this.syncMultiFileToGit();

                await this.git.clone({
                    fs: this.fs,
                    http: this.http,
                    dir: this.gitDir,
                    url: url,
                    ref: branch,
                    singleBranch: true,
                    depth: 1,
                    onAuth: () => this.getAuth()
                });
                this.lastGitRepoUrl = url;
                this.lastGitBranch = branch;
                chrome.storage.local.set({
                    lastGitRepoUrl: repoUrl,
                    lastGitBranch: branch
                });
            }

            this.logGit('Fetching...');
            await this.git.fetch({
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                ref: branch,
                singleBranch: true,
                depth: 1,
                onAuth: () => this.getAuth()
            });

            if (this.editorSettings.useCorsProxy) {
                await this.git.fetch({
                    fs: this.fs,
                    http: this.http,
                    dir: this.gitDir,
                    ref: branch,
                    singleBranch: true,
                    depth: 1,
                    corsProxy: 'https://cors.isomorphic-git.org',
                    onAuth: () => this.getAuth()
                });
            }

            const remoteRef = `origin/${branch}`;
            const oid = await this.git.resolveRef({
                fs: this.fs,
                dir: this.gitDir,
                ref: remoteRef
            });

            await this.git.checkout({
                fs: this.fs,
                dir: this.gitDir,
                ref: oid,
                force: true
            });

            this.logGit(`Checked out ${remoteRef}`);

            await this.syncGitToMultiFile();

            this.logGit('Pull complete!');
            this.setStatus('Pull successful', true, 'success');
            this.gitModal.classList.remove('visible');

            await this.refreshSourceControl();

        } catch (err) {
            this.logGit(`PULL FAILED: ${err.message}`);
            console.error(err);
        }
    }

    async refreshSourceControl() {
        const scPanel = document.getElementById('sourceControlPanel');
        if (!scPanel) return;

        const repoUrl = document.getElementById('repoUrl')?.value?.trim();
        const hasRepoUrl = repoUrl && repoUrl.startsWith('https');

        if (this.mode !== 'git' &&
            this.mode !== 'multi-file-edit' &&
            !(this.mode === 'workspace' && hasRepoUrl)) {
            scPanel.innerHTML = `<div style="padding: 10px; color: var(--muted); font-style: italic; font-size: 14px;">
                Source control is only available when a Git repository is cloned or a workspace/project with GitHub repo is configured.
                <br/><br/>
                You can clone a repository using the <strong>Github</strong> button in the header.
            </div>`;
            return;
        }

        if (this.mode === 'multi-file-edit' && (!this.script?.githubRepo || !this.script.githubRepo.url)) {
            scPanel.innerHTML = `<div style="padding: 10px; color: var(--muted); font-style: italic; font-size: 14px;">
                No GitHub repository configured for this project.
                <br/><br/>
                Click <strong>Github</strong> in the header to set up source control.
            </div>`;
            return;
        }

        if (this.mode === 'workspace' && !hasRepoUrl) {
            scPanel.innerHTML = `<div style="padding: 10px; color: var(--muted); font-style: italic; font-size: 14px;">
                No GitHub repository configured for this workspace.
                <br/><br/>
                Click <strong>Github</strong> in the header and set a Repository URL to enable source control.
            </div>`;
            return;
        }

        try {
            if (this.mode === 'workspace' && this.workspaceHandle) {
                await this.syncWorkspaceToGit();
            } else if (this.mode === 'multi-file-edit') {
                await this.syncMultiFileToGit();
            }

            const gitDir = this.getGitDir();
            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: gitDir
            });

            this.sourceControl.changedFiles = status
                .filter(([filepath, head, workdir, stage]) => {
                    return workdir !== head || stage !== head;
                })
                .map(([filepath, head, workdir, stage]) => {
                    let status = 'modified';
                    if (head === 0) status = 'untracked';
                    else if (workdir === 0) status = 'deleted';
                    else if (stage === 2) status = 'added';
                    return {
                        path: filepath,
                        status: status,
                        isStaged: this.sourceControl.stagedFiles.has(filepath)
                    };
                });

            this.renderSourceControl();
        } catch (err) {
            console.error('Error refreshing source control:', err);
        }
    }

    async syncWorkspaceToGit() {
        if (!this.workspaceHandle) {
            return;
        }

        try {
            const gitDir = this.getGitDir();
            const repoUrl = document.getElementById('repoUrl')?.value?.trim();
            let branch = document.getElementById('branch')?.value?.trim() || 'main';

            if (!repoUrl || !repoUrl.startsWith('https')) {
                console.warn('syncWorkspaceToGit: No valid repo URL, using local-only git dir');
            }

            let needsReinit = false;
            try {
                await this.gitFS.stat(gitDir);
                
                try {
                    await this.gitFS.stat(`${gitDir}/.git`);
                    
                    const remotes = await this.git.listRemotes({
                        fs: this.fs,
                        dir: gitDir
                    });
                    
                    const origin = remotes.find(r => r.remote === 'origin');
                    
                    // if remote doesnt match current URL then reinit
                    if (origin && repoUrl && origin.url !== repoUrl) {
                        console.log(`Remote URL mismatch: ${origin.url} vs ${repoUrl} - reinitializing`);
                        needsReinit = true;
                    }
                } catch (e) {
                    needsReinit = true;
                }
            } catch (e) {
                needsReinit = true;
            }

            if (needsReinit) {
                this.logGit('Reinitializing Git repository for new remote...');
                
                try {
                    await this.deleteRecursive(gitDir);
                } catch (e) {
                    // ignore
                }
            }

            let hasGit = false;
            try {
                await this.gitFS.stat(`${gitDir}/.git`);
                hasGit = true;
            } catch (e) {
                hasGit = false;
            }

            if (repoUrl) {
                if (!hasGit) {
                    this.logGit(`Cloning ${repoUrl}...`);
                    await this.git.clone({
                        fs: this.fs,
                        http: this.http,
                        dir: gitDir,
                        url: repoUrl,
                        ref: branch,
                        singleBranch: true,
                        depth: 1,
                        onAuth: () => this.getAuth()
                    });
                    this.lastGitRepoUrl = repoUrl;
                    this.lastGitBranch = branch;
                    chrome.storage.local.set({
                        lastGitRepoUrl: repoUrl,
                        lastGitBranch: branch
                    });
                } else {
                    try {
                        const remotes = await this.git.listRemotes({
                            fs: this.fs,
                            dir: gitDir
                        });
                        const hasOrigin = remotes.some(r => r.remote === 'origin');

                        if (!hasOrigin) {
                            await this.git.addRemote({
                                fs: this.fs,
                                dir: gitDir,
                                remote: 'origin',
                                url: repoUrl
                            });
                        }
                    } catch (remoteErr) {
                        console.warn('syncWorkspaceToGit: Remote configuration:', remoteErr);
                    }

                    try {
                        await this.git.fetch({
                            fs: this.fs,
                            http: this.http,
                            dir: gitDir,
                            ref: branch,
                            singleBranch: true,
                            onAuth: () => this.getAuth()
                        });

                        const remoteRef = `origin/${branch}`;
                        const oid = await this.git.resolveRef({
                            fs: this.fs,
                            dir: gitDir,
                            ref: remoteRef
                        });

                        await this.git.checkout({
                            fs: this.fs,
                            dir: gitDir,
                            ref: oid,
                            force: true
                        });
                    } catch (fetchErr) {
                        console.warn('syncWorkspaceToGit: Fetch/checkout error:', fetchErr);
                    }
                }
            } else if (!hasGit) {

                try {
                    await this.gitFS.mkdir(gitDir, { recursive: true });
                } catch (e) {
                    // ignore
                }
                await this.git.init({
                    fs: this.fs,
                    dir: gitDir
                });
            }

            const entries = await this.gitFS.readdir(gitDir);
            for (const entry of entries) {
                if (entry === '.git') continue;
                await this.deleteRecursive(`${gitDir}/${entry}`);
            }

            await this.copyToFS(this.workspaceHandle, gitDir, false);
            
        } catch (err) {
            console.error('Error syncing workspace to git:', err);
            throw err;
        }
        this.logGit(`Done.`);
    }

    renderSourceControl() {
        const scPanel = document.getElementById('sourceControlPanel');
        if (!scPanel) return;

        const changedFiles = this.sourceControl.changedFiles.filter(f => !f.isStaged);
        const stagedFiles = this.sourceControl.changedFiles.filter(f => f.isStaged);

        scPanel.innerHTML = `
			<div class="sc-section">
				<div class="sc-header">
					<span>Changes (${changedFiles.length})</span>
					${changedFiles.length > 0 ? `<button class="btn-icon" id="stageAllBtn" title="Stage All">+</button>` : ''}
				</div>
				<div class="sc-file-list">
					${changedFiles.map(file => `
						<div class="sc-file-item" data-path="${file.path}">
							<span class="sc-status sc-status-${file.status}">${file.status[0].toUpperCase()}</span>
							<span class="sc-filename" title="${file.path}">${file.path}</span>
							<button class="btn-icon sc-stage-btn" data-path="${file.path}" title="Stage">+</button>
							<button class="btn-icon sc-diff-btn" data-path="${file.path}" title="View Diff">👁</button>
						</div>
					`).join('')}
				</div>
			</div>

			<div class="sc-section">
				<div class="sc-header">
					<span>Staged Changes (${stagedFiles.length})</span>
					${stagedFiles.length > 0 ? `<button class="btn-icon" id="unstageAllBtn" title="Unstage All">-</button>` : ''}
				</div>
				<div class="sc-file-list">
					${stagedFiles.map(file => `
						<div class="sc-file-item staged" data-path="${file.path}">
							<span class="sc-status sc-status-${file.status}">${file.status[0].toUpperCase()}</span>
							<span class="sc-filename" title="${file.path}">${file.path}</span>
							<button class="btn-icon sc-unstage-btn" data-path="${file.path}" title="Unstage">-</button>
							<button class="btn-icon sc-diff-btn" data-path="${file.path}" title="View Diff">👁</button>
						</div>
					`).join('')}
				</div>
			</div>

			<div class="sc-commit-section">
				<textarea id="commitMessageInput" 
						class="sc-commit-input" 
						placeholder="Commit message (Ctrl+Enter to commit)"
						rows="3">${this.sourceControl.commitMessage}</textarea>
				<div class="sc-commit-actions">
					<button class="btn btn-success" id="commitBtn" ${stagedFiles.length === 0 ? 'disabled' : ''}>
						Commit
					</button>
					<button class="btn" id="commitPushBtn" ${stagedFiles.length === 0 ? 'disabled' : ''}>
						Commit & Push
					</button>
				</div>
			</div>
		`;

        this.attachSourceControlEvents();
    }

    attachSourceControlEvents() {
        const scPanel = document.getElementById('sourceControlPanel');
        if (!scPanel) return;

        scPanel.querySelectorAll('.sc-stage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const path = btn.dataset.path;

                this.sourceControl.stagedFiles.add(path);

                const file = this.sourceControl.changedFiles.find(f => f.path === path);
                if (file) {
                    file.isStaged = true;
                }

                this.renderSourceControl();
            });
        });

        scPanel.querySelectorAll('.sc-unstage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const path = btn.dataset.path;

                this.sourceControl.stagedFiles.delete(path);

                const file = this.sourceControl.changedFiles.find(f => f.path === path);
                if (file) {
                    file.isStaged = false;
                }

                this.renderSourceControl();
            });
        });

        scPanel.querySelectorAll('.sc-diff-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const path = btn.dataset.path;
                await this.showDiff(path);
            });
        });

        const stageAllBtn = document.getElementById('stageAllBtn');
        if (stageAllBtn) {
            stageAllBtn.addEventListener('click', () => {
                this.sourceControl.changedFiles.forEach(f => {
                    if (!f.isStaged) {
                        f.isStaged = true;
                        this.sourceControl.stagedFiles.add(f.path);
                    }
                });
                this.renderSourceControl();
            });
        }

        const unstageAllBtn = document.getElementById('unstageAllBtn');
        if (unstageAllBtn) {
            unstageAllBtn.addEventListener('click', () => {
                this.sourceControl.stagedFiles.clear();
                this.sourceControl.changedFiles.forEach(f => {
                    f.isStaged = false;
                });
                this.renderSourceControl();
            });
        }

        const commitInput = document.getElementById('commitMessageInput');
        if (commitInput) {
            commitInput.addEventListener('input', (e) => {
                this.sourceControl.commitMessage = e.target.value;
            });

            commitInput.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'Enter') {
                    this.commitChanges();
                }
            });
        }

        const commitBtn = document.getElementById('commitBtn');
        if (commitBtn) {
            commitBtn.addEventListener('click', () => this.commitChanges());
        }

        const commitPushBtn = document.getElementById('commitPushBtn');
        if (commitPushBtn) {
            commitPushBtn.addEventListener('click', () => this.commitChanges(true));
        }
    }

    async showDiff(filepath) {
        try {
            const gitDir = this.getGitDir();
            const fullPath = `${gitDir}/${filepath}`;

            const currentContent = await this.fs.promises.readFile(fullPath, 'utf8');

            const commitOid = await this.git.resolveRef({
                fs: this.fs,
                dir: gitDir,
                ref: 'HEAD'
            });

            let headContent = '';
            try {
                const {
                    blob
                } = await this.git.readBlob({
                    fs: this.fs,
                    dir: gitDir,
                    oid: commitOid,
                    filepath: filepath
                });
                headContent = new TextDecoder().decode(blob);
            } catch (e) {
                headContent = '';
            }

            const originalModel = monaco.editor.createModel(
                headContent,
                undefined,
                monaco.Uri.file(`${filepath}.original`)
            );
            const modifiedModel = monaco.editor.createModel(
                currentContent,
                undefined,
                monaco.Uri.file(`${filepath}.modified`)
            );

            this.openDiffEditor(originalModel, modifiedModel, filepath);

        } catch (err) {
            console.error('Error showing diff:', err);
            this.setStatus(`Error showing diff: ${err.message}`);
        }
    }

    openDiffEditor(originalModel, modifiedModel, filepath) {
        const diffOverlay = document.createElement('div');
        diffOverlay.id = 'diffOverlay';
        diffOverlay.style.cssText = `
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(11, 18, 32, 0.5);
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			z-index: 10000;
			display: flex;
			align-items: center;
			justify-content: center;
			opacity: 0;
			transition: opacity 0.2s ease-out;
		`;

        const diffContainer = document.createElement('div');
        diffContainer.id = 'diffEditorContainer';
        diffContainer.style.cssText = `
			width: 90vw;
			height: 90vh;
			background: var(--bg);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			box-shadow: 0 10px 40px rgba(0,0,0,0.5);
			display: flex;
			flex-direction: column;
			overflow: hidden;
			transform: scale(0.95);
			transition: transform 0.2s ease-out;
		`;

        const header = document.createElement('div');
        header.style.cssText = `
			padding: 16px;
			border-bottom: 1px solid var(--border);
			display: flex;
			justify-content: space-between;
			align-items: center;
			flex-shrink: 0;
		`;
        header.innerHTML = `
			<div>
				<h3 style="margin: 0; font-size: 16px;">Diff: ${this.escape(filepath)}</h3>
				<p style="margin: 4px 0 0 0; color: var(--muted); font-size: 13px;">HEAD ↔ Working Tree</p>
			</div>
			<button class="btn btn-secondary" id="closeDiffBtn">Close</button>
		`;

        const editorDiv = document.createElement('div');
        editorDiv.style.cssText = 'flex: 1; min-height: 0;';

        diffContainer.appendChild(header);
        diffContainer.appendChild(editorDiv);
        diffOverlay.appendChild(diffContainer);
        document.body.appendChild(diffOverlay);

        setTimeout(() => {
            diffOverlay.style.opacity = '1';
            diffContainer.style.transform = 'scale(1)';
        }, 10);

        const diffEditor = monaco.editor.createDiffEditor(editorDiv, {
            theme: 'dracula',
            readOnly: true,
            automaticLayout: true,
            scrollbar: {
                vertical: 'hidden',
                horizontal: 'hidden',
                useShadows: false
            }
        });

        diffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });

        document.getElementById('closeDiffBtn').addEventListener('click', () => {
            diffOverlay.style.opacity = '0';
            diffContainer.style.transform = 'scale(0.95)';

            setTimeout(() => {
                diffEditor.dispose();
                originalModel.dispose();
                modifiedModel.dispose();
                diffOverlay.remove();
            }, 200);
        });
    }

    // i beg JUST be fixed
    async ResetLocalGitRepo() {
        const gitDir = this.gitDir;

        try {
            await this.gitFS.rmdir(gitDir, {
                recursive: true
            });
        } catch (e) {
            console.warn('resetLocalGitRepo: rmdir failed', e);
        }

        await this.gitFS.mkdir(gitDir).catch(() => {});

        await this.git.init({
            fs: this.fs,
            dir: gitDir,
            defaultBranch: 'main',
        });

        this.logGit('Local /repo reset and re‑initialized.');
    }

    async commitChanges(pushAfter = false) {
        const scPanel = document.getElementById('sourceControlPanel');
        if (!scPanel) return;

        const repoUrlInput = document.getElementById('repoUrl');
        const branchInput = document.getElementById('branch');

        const repoUrl = repoUrlInput?.value?.trim();
        let branch = branchInput?.value?.trim() || 'main';

        if (!repoUrl || !repoUrl.startsWith('https')) {
            this.setStatus('No valid GitHub repository URL configured.', true, 'error');
            return;
        }

        this.lastGitRepoUrl = repoUrl;
        this.lastGitBranch = branch;
        chrome.storage.local.set({
            lastGitRepoUrl: repoUrl,
            lastGitBranch: branch
        });

        const gitDir = this.getGitDir();

        this.gitModal.classList.add('visible');
        this.logGit('Preparing commit...');

        try {
            if (this.mode === 'workspace' && this.workspaceHandle) {
                await this.syncWorkspaceToGit();
            } else if (this.mode === 'multi-file-edit') {
                await this.syncMultiFileToGit();
            }

            try {
                await this.gitFS.stat(`${gitDir}/.git`);
            } catch (e) {
                await this.git.init({
                    fs: this.fs,
                    dir: gitDir
                });
            }

            try {
                const remotes = await this.git.listRemotes({
                    fs: this.fs,
                    dir: gitDir
                });
                const hasOrigin = remotes.some(r => r.remote === 'origin');
                if (!hasOrigin) {
                    await this.git.addRemote({
                        fs: this.fs,
                        dir: gitDir,
                        remote: 'origin',
                        url: repoUrl,
                    });
                } else {
                    const origin = remotes.find(r => r.remote === 'origin');
                    if (origin.url !== repoUrl) {
                        await this.git.deleteRemote({
                            fs: this.fs,
                            dir: gitDir,
                            remote: 'origin'
                        });
                        await this.git.addRemote({
                            fs: this.fs,
                            dir: gitDir,
                            remote: 'origin',
                            url: repoUrl,
                        });
                    }
                }
            } catch (remoteErr) {
                this.logGit('Remote configuration warning: ' + remoteErr.message);
            }

            this.logGit('Staging files...');
            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: gitDir
            });

            let hasChanges = false;
            for (const row of status) {
                const filepath = row[0];
                const head = row[1];
                const workdir = row[2];

                if (this.sourceControl.stagedFiles.size > 0 &&
                    !this.sourceControl.stagedFiles.has(filepath)) {
                    continue;
                }

                if (head === 0 && workdir === 0) continue;

                if (workdir === 0) {
                    await this.git.remove({
                        fs: this.fs,
                        dir: gitDir,
                        filepath
                    });
                    this.logGit(` - Staged deletion: ${filepath}`);
                    hasChanges = true;
                } else if (workdir === 2 || workdir === 3) {
                    await this.git.add({
                        fs: this.fs,
                        dir: gitDir,
                        filepath
                    });
                    this.logGit(` - Staged change: ${filepath}`);
                    hasChanges = true;
                }
            }

            if (!hasChanges) {
                this.logGit('No changes to commit.');
                this.gitModal.classList.remove('visible');
                return;
            }

            const commitMsg = this.sourceControl.commitMessage?.trim() || 'Update from ScriptFlow';
            this.logGit('Committing...');
            const sha = await this.git.commit({
                fs: this.fs,
                dir: gitDir,
                message: commitMsg,
                author: {
                    name: 'ScriptFlow',
                    email: 'bot@scriptflow.app',
                },
                ref: branch
            });
            this.logGit(`Committed ${sha.substring(0, 7)}`);
            this.showNotification({
                title: 'Success',
                message: `Committed ${sha.substring(0, 7)}`,
                type: 'success',
                duration: 4000,
            });

            if (!pushAfter) {
                this.gitModal.classList.remove('visible');
                await this.refreshSourceControl?.();
                return;
            }

            this.logGit(`Ensuring branch '${branch}' exists...`);
            try {
                const branches = await this.git.listBranches({
                    fs: this.fs,
                    dir: gitDir
                });
                if (!branches.includes(branch)) {
                    const headOid = await this.git.resolveRef({
                        fs: this.fs,
                        dir: gitDir,
                        ref: 'HEAD'
                    });
                    await this.git.writeRef({
                        fs: this.fs,
                        dir: gitDir,
                        ref: `refs/heads/${branch}`,
                        value: headOid,
                        force: false,
                    });
                }
                await this.git.checkout({
                    fs: this.fs,
                    dir: gitDir,
                    ref: branch
                });
            } catch (branchErr) {
                this.logGit('Branch setup warning: ' + branchErr.message);
            }

            this.logGit(`Pushing to origin/${branch}...`);
            const pushOptions = {
                fs: this.fs,
                http: this.http,
                dir: gitDir,
                remote: 'origin',
                ref: branch,
                force: true,
                onAuth: () => this.getAuth(),
            };
            if (this.editorSettings?.useCorsProxy) {
                pushOptions.corsProxy = 'https://cors.isomorphic-git.org';
            }

            let autoFixed = false;
            let result;

            try {
                result = await this.git.push(pushOptions);
                // ignore, just a bunch of debugging code to see what went wrong
                const remoteMain = await this.git.resolveRef({
                    fs: this.fs,
                    dir: gitDir,
                    ref: 'origin/main',
                }).catch(() => null);

                const localMain = await this.git.resolveRef({
                    fs: this.fs,
                    dir: gitDir,
                    ref: 'main',
                }).catch(() => null);

                this.logGit(`Local main:  ${localMain}`);
                this.logGit(`Remote main: ${remoteMain}`);
                this.logGit(`Push result: ${JSON.stringify(result, null, 2)}`);
            } catch (err) {
                const isNonFastForward = /non-fast-forward|fast-forward/i.test(err?.message || '');
                const isRejectedRef = /rejected.*refs\/heads\/.+failed/i.test(err?.message || '');
                if (isNonFastForward || isRejectedRef) {
                    autoFixed = true;
                    this.logGit('Push rejected (non-fast-forward). Auto-syncing with remote...');

                    try {
                        await this.git.fetch({
                            fs: this.fs,
                            http: this.http,
                            dir: gitDir,
                            remote: 'origin',
                            ref: branch,
                            singleBranch: true,
                            depth: 1,
                            onAuth: () => this.getAuth(),
                        });

                        const remoteRef = `origin/${branch}`;
                        const remoteOid = await this.git.resolveRef({
                            fs: this.fs,
                            dir: gitDir,
                            ref: remoteRef,
                        });

                        const localOid = await this.git.resolveRef({
                            fs: this.fs,
                            dir: gitDir,
                            ref: branch,
                        });

                        if (remoteOid !== localOid) {
                            this.logGit('Merging remote changes into local branch...');
                            await this.git.merge({
                                fs: this.fs,
                                dir: gitDir,
                                ours: branch,
                                theirs: remoteRef,
                                fastForwardOnly: false,
                                author: {
                                    name: 'ScriptFlow',
                                    email: 'bot@scriptflow.app',
                                },
                            });
                        }

                        // recommit if working tree changed
                        const postStatus = await this.git.statusMatrix({
                            fs: this.fs,
                            dir: gitDir
                        });
                        let hasNewChanges = false;
                        for (const row of postStatus) {
                            const head = row[1];
                            const workdir = row[2];
                            const stage = row[3];
                            if (workdir !== head || stage !== head) {
                                hasNewChanges = true;
                                break;
                            }
                        }

                        if (hasNewChanges) {
                            this.logGit('Re-committing after merge...');
                            const fixSha = await this.git.commit({
                                fs: this.fs,
                                dir: gitDir,
                                message: commitMsg,
                                author: {
                                    name: 'ScriptFlow',
                                    email: 'bot@scriptflow.app',
                                },
                            });
                            this.logGit(`Re-committed ${fixSha.substring(0, 7)}`);
                        }

                        this.logGit('Retrying push...');
                        result = await this.git.push({
                            ...pushOptions,
                            force: false
                        });
                    } catch (syncErr) {
                        throw syncErr;
                    }
                } else {
                    throw err;
                }
            }

            if (!result?.ok) {
                const errorText = result?.errors ? result.errors.join(', ') : 'No response';
                throw new Error(`Push failed: ${errorText}`);
            }

            this.logGit('Push successful!');
            this.saveCounter = 0;

            this.setStatus(
                autoFixed ? 'Committed and pushed after auto-fix.' : 'Committed and pushed!',
                true,
                'success'
            );

            this.showNotification({
                title: autoFixed ? 'Push Fixed Automatically' : 'Push Successful',
                message: autoFixed ?
                    'Your push initially failed, but ScriptFlow synced with the remote and retried successfully.' : 'Your changes were committed and pushed to GitHub.',
                type: 'success',
                duration: 6000,
            });

            await this.updateRepoHistory(repoUrl);
            await this.refreshSourceControl?.();
            this.gitModal.classList.remove('visible');
        } catch (err) {
            this.logGit('ERROR ' + (err.message || 'Unknown error'));
            console.error(err);
            this.setStatus('Commit/Push failed: ' + (err.message || 'Unknown error'), true, 'error');

            this.showNotification({
                title: 'Push Failed',
                message: err.message || 'Unknown Git error',
                type: 'error',
                duration: 8000,
            });

            await this.refreshSourceControl?.();
            this.gitModal.classList.remove('visible');
        }
    }

    setupEditorSettings() {
        this.editorSettings = {
            theme: localStorage.getItem('sf_editor_theme') || 'dracula',
            fontSize: parseInt(localStorage.getItem('sf_editor_fontSize')) || 14,
            minimap: localStorage.getItem('sf_editor_minimap') !== 'false',
            wordWrap: localStorage.getItem('sf_editor_wordWrap') !== 'off',
            tabSize: parseInt(localStorage.getItem('sf_editor_tabSize')) || 4,
            lineNumbers: localStorage.getItem('sf_editor_lineNumbers') || 'on',
            runAt: localStorage.getItem('sf_editor_runAt') || 'document_idle',
            useCorsProxy: localStorage.getItem('sf_editor_useCorsProxy') === 'true'
        };
    }

    applyEditorSettings() {
        if (!this.editor) return;

        this.editor.updateOptions({
            theme: this.editorSettings.theme,
            fontSize: this.editorSettings.fontSize,
            minimap: {
                enabled: this.editorSettings.minimap
            },
            wordWrap: this.editorSettings.wordWrap ? 'on' : 'off',
            tabSize: this.editorSettings.tabSize,
            lineNumbers: this.editorSettings.lineNumbers
        });
    }

    openEditorSettings() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;

        modal.classList.add('visible');

        document.getElementById('setting_theme').value = this.editorSettings.theme;
        document.getElementById('setting_fontSize').value = this.editorSettings.fontSize;
        document.getElementById('setting_minimap').checked = this.editorSettings.minimap;
        document.getElementById('setting_wordWrap').checked = this.editorSettings.wordWrap;
        document.getElementById('setting_tabSize').value = this.editorSettings.tabSize;
        document.getElementById('setting_lineNumbers').value = this.editorSettings.lineNumbers;
        document.getElementById('setting_runAt').value = this.editorSettings.runAt;
        document.getElementById('setting_useCorsProxy').checked = this.editorSettings.useCorsProxy;
    }

    saveEditorSettings() {
        this.editorSettings.theme = document.getElementById('setting_theme').value;
        this.editorSettings.fontSize = parseInt(document.getElementById('setting_fontSize').value);
        this.editorSettings.minimap = document.getElementById('setting_minimap').checked;
        this.editorSettings.wordWrap = document.getElementById('setting_wordWrap').checked;
        this.editorSettings.tabSize = parseInt(document.getElementById('setting_tabSize').value);
        this.editorSettings.lineNumbers = document.getElementById('setting_lineNumbers').value;
        this.editorSettings.runAt = document.getElementById('setting_runAt').value;
        this.editorSettings.useCorsProxy = document.getElementById('setting_useCorsProxy').checked;

        localStorage.setItem('sf_editor_theme', this.editorSettings.theme);
        localStorage.setItem('sf_editor_fontSize', this.editorSettings.fontSize);
        localStorage.setItem('sf_editor_minimap', this.editorSettings.minimap);
        localStorage.setItem('sf_editor_wordWrap', this.editorSettings.wordWrap);
        localStorage.setItem('sf_editor_tabSize', this.editorSettings.tabSize);
        localStorage.setItem('sf_editor_lineNumbers', this.editorSettings.lineNumbers);
        localStorage.setItem('sf_editor_runAt', this.editorSettings.runAt);
        localStorage.setItem('sf_editor_useCorsProxy', this.editorSettings.useCorsProxy);

        const sidebarRunAt = document.getElementById('scriptRunAt');
        if (sidebarRunAt) {
            sidebarRunAt.value = this.editorSettings.runAt;
        }

        if (this.script && this.scriptId) {
            this.script.runAt = this.editorSettings.runAt;
            chrome.runtime.sendMessage({
                action: 'saveScript',
                script: this.script
            }).then(() => {
                this.setStatus('Settings and script runAt saved', true, 'success');
            }).catch(err => {
                console.error('Failed to save runAt to script:', err);
                this.setStatus('Settings saved (warning: runAt not saved to script)', true, 'warning');
            });
        } else {
            this.setStatus('Settings saved', true, 'success');
        }

        this.applyEditorSettings();
        document.getElementById('settingsModal').classList.remove('visible');
    }

    setupSnippets() {
        if (!monaco?.languages?.registerCompletionItemProvider) return;

        const snippets = [{
                label: 'gm_getValue',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: 'GM_getValue("${1:key}", ${2:defaultValue})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Get a stored value'
            },
            {
                label: 'gm_setValue',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: 'GM_setValue("${1:key}", ${2:value})',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Store a value'
            },
            {
                label: 'gm_addStyle',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: 'GM_addStyle(`\n\t${1:/* CSS rules */}\n`)',
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Inject custom CSS'
            },
            {
                label: 'sf_module',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: [
                    '// ${1:Module description}',
                    '',
                    'export function ${2:functionName}(${3:params}) {',
                    '\t${4:// Implementation}',
                    '}',
                    '',
                    'export default ${2:functionName};'
                ].join('\n'),
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'ES Module template'
            },
            {
                label: 'sf_component',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: [
                    'class ${1:ComponentName} {',
                    '\tconstructor(${2:options}) {',
                    '\t\tthis.element = document.createElement("div");',
                    '\t\tthis.element.className = "${3:component-class}";',
                    '\t\tthis.render();',
                    '\t}',
                    '',
                    '\trender() {',
                    '\t\tthis.element.innerHTML = `${4:<div>Content</div>}`;',
                    '\t}',
                    '',
                    '\tmount(parent) {',
                    '\t\tparent.appendChild(this.element);',
                    '\t}',
                    '}',
                    '',
                    'export default ${1:ComponentName};'
                ].join('\n'),
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Component class template'
            },
            {
                label: 'gm_xmlhttp',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: [
                    'GM_xmlhttpRequest({',
                    '\tmethod: "${1|GET,POST,PUT,DELETE|}",',
                    '\turl: "${2:https://api.example.com}",',
                    '\theaders: {',
                    '\t\t"Content-Type": "application/json"',
                    '\t},',
                    '\tdata: JSON.stringify(${3:{}}),',
                    '\tonload: (response) => {',
                    '\t\tconsole.log(response.responseText);',
                    '\t\t${4:// Handle response}',
                    '\t},',
                    '\tonerror: (error) => {',
                    '\t\tconsole.error(error);',
                    '\t}',
                    '});'
                ].join('\n'),
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'GM AJAX request'
            },
            {
                label: 'sf_waitElement',
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: [
                    'function waitForElement(selector, timeout = 5000) {',
                    '\treturn new Promise((resolve, reject) => {',
                    '\t\tconst el = document.querySelector(selector);',
                    '\t\tif (el) return resolve(el);',
                    '\t\t',
                    '\t\tconst observer = new MutationObserver(() => {',
                    '\t\t\tconst el = document.querySelector(selector);',
                    '\t\t\tif (el) {',
                    '\t\t\t\tobserver.disconnect();',
                    '\t\t\t\tresolve(el);',
                    '\t\t\t}',
                    '\t\t});',
                    '\t\t',
                    '\t\tobserver.observe(document.body, {',
                    '\t\t\tchildList: true,',
                    '\t\t\tsubtree: true',
                    '\t\t});',
                    '\t\t',
                    '\t\tsetTimeout(() => {',
                    '\t\t\tobserver.disconnect();',
                    '\t\t\treject(new Error(`Element not found: ${selector}`));',
                    '\t\t}, timeout);',
                    '\t});',
                    '}',
                    '',
                    'waitForElement("${1:selector}").then(el => {',
                    '\t${2:// Use element}',
                    '});'
                ].join('\n'),
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: 'Wait for element to appear in DOM'
            }
        ];

        monaco.languages.registerCompletionItemProvider('javascript', {
            provideCompletionItems: (model, position) => {
                return {
                    suggestions: snippets
                };
            }
        });
    }

    // this takes the flat file object from the extension script and makes a nested html tree
    buildTreeFromObject(files, expandedPaths = new Set()) {
        const treeRoot = {};
        const fileTreeEl = document.getElementById('fileTree');
        fileTreeEl.innerHTML = '';

        for (const path in files) {
            let currentLevel = treeRoot;
            const parts = path.split('/');
            parts.forEach((part, index) => {
                if (!currentLevel[part]) {
                    currentLevel[part] = {};
                }
                if (index === parts.length - 1) {
                    currentLevel[part].__isFile = true;
                }
                currentLevel = currentLevel[part];
            });
        }

        const createTreeElement = (name, path, isFolder, parentEl) => {
            const li = document.createElement('li');
            const item = document.createElement('div');
            item.className = 'tree-item';
            item.dataset.path = path;
            item.dataset.kind = isFolder ? 'directory' : 'file';

            const arrow = document.createElement('span');
            arrow.className = 'arrow';
            item.appendChild(arrow);

            const icon = document.createElement('span');
            icon.className = 'icon ' + (isFolder ? 'folder' : 'file');
            item.appendChild(icon);

            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = name;
            item.appendChild(nameEl);

            li.appendChild(item);

            parentEl.appendChild(li);

            if (isFolder) {
                item.classList.add('is-folder');
                const shouldExpand = expandedPaths.has(path);
                item.setAttribute('data-state', shouldExpand ? 'expanded' : 'collapsed');
                const nested = document.createElement('ul');
                nested.className = 'nested-tree';
                li.appendChild(nested);
                item.addEventListener('click', (e) => {
                    const state = item.getAttribute('data-state');
                    if (state === 'collapsed') {
                        item.setAttribute('data-state', 'expanded');
                    } else {
                        item.setAttribute('data-state', 'collapsed');
                    }
                });
                return nested;
            } else {
                item.classList.add('is-file');
                item.addEventListener('click', (e) => {
                    document.querySelectorAll('#fileTree .tree-item.active').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    this.loadVirtualFileForEditing(path);
                });
                return null;
            }
        };

        const buildHtml = (node, path, parentEl) => {
            Object.keys(node).sort((a, b) => {
                const aIsFile = node[a].__isFile;
                const bIsFile = node[b].__isFile;
                if (!aIsFile && bIsFile) return -1;
                if (aIsFile && !bIsFile) return 1;
                return a.localeCompare(b);
            }).forEach(key => {
                if (key === '__isFile') return;
                const newPath = path ? `${path}/${key}` : key;
                const isFolder = !node[key].__isFile;
                const newParent = createTreeElement(key, newPath, isFolder, parentEl);
                if (isFolder) {
                    buildHtml(node[key], newPath, newParent);
                }
            });
        };

        buildHtml(treeRoot, '', fileTreeEl);
    }

    // loads a file from the script object into monaco
    loadVirtualFileForEditing(path) {
        if (!this.script || !this.script.files) return;

        if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
            this.script.files[this.currentPath] = this.editor.getValue();
        }

        this.currentPath = path;
        const content = this.script.files[path];

        if (content !== undefined) {
            if (typeof content === 'string' && content.startsWith('data:image/')) {
                this.displayImageInEditor(content, path.split('/').pop(), true);
                this.setStatus(`Viewing image: ${path}`);
            } else {
                this.editor.setValue(content);
                this.setEditorMode(path);
                this.editor.updateOptions({
                    readOnly: false
                });
                this.setStatus(`Editing: ${path}`);
            }
        } else {
            this.editor.setValue(`// File not found in project: ${path}`);
            this.editor.updateOptions({
                readOnly: true
            });
            this.setStatus(`Error: File not found`);
        }
    }

    // this loads a full script project from the extension backend
    async loadProject(id) {
        const response = await chrome.runtime.sendMessage({
            action: 'getScript',
            scriptId: id
        });
        const script = response.script;

        if (!script) {
            this.setStatus(`Error: Script ID "${id}" not found`);
            this.editor.setValue(`// Script with ID "${id}" could not be found.`);
            this.editor.updateOptions({
                readOnly: true
            });
            return;
        }

        this.script = script;
        this.scriptId = id;
        window.history.replaceState({}, '', `editor.html?id=${this.scriptId}`);

        document.getElementById('scriptEnabled').checked = this.script.enabled !== false;

        const runAtSelect = document.getElementById('scriptRunAt');
        if (runAtSelect) {
            const runAtValue = script.runAt || this.editorSettings.runAt || 'document_idle';
            runAtSelect.value = runAtValue;
            this.editorSettings.runAt = runAtValue;
            localStorage.setItem('sf_editor_runAt', runAtValue);
        }

        if (script.type === 'multi-file' || script.type === 'tracked-project') {
            this.mode = 'multi-file-edit';
            this.saveBtn.textContent = 'Save Project';

            document.getElementById('scriptName').value = script.name || '';
            document.getElementById('scriptDescription').value = script.description || '';
            this.matches = script.matches || [];
            this.grants = script.grant || [];
            this.renderMatches();

            this.projectEntryPoint = script.entryPoint || null;

            if (script.githubRepo) {
                document.getElementById('repoUrl').value = script.githubRepo.url || '';
                document.getElementById('branch').value = script.githubRepo.branch || 'main';

                await this.syncMultiFileToGit();

                const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                if (scTab) scTab.style.display = 'block';
            }

            if (script.type === 'tracked-project') {
                if (script.sourceType === 'git') {
                    this.mode = 'git';
                    document.getElementById('repoUrl').value = script.sourceDetails?.url || '';
                    document.getElementById('branch').value = script.sourceDetails?.branch || 'main';
                    try {
                        await this.gitFS.stat(this.gitDir);
                        await this.buildGitTree();
                    } catch (e) {
                        this.logGit("Error: Git repo VFS missing. Please re-clone.");
                        this.editor.setValue("/* ERROR: Git repo data missing. Please re-clone the repository. */");
                        this.toggleExplorer(false);
                    }
                } else if (script.sourceType === 'workspace') {
                    this.mode = 'workspace';
                    const workspace = await this.idb.get('workspaces', 'root');
                    if (workspace?.handle && workspace.handle.name === script.sourceDetails?.name) {
                        this.workspaceHandle = workspace.handle;
                        await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'));
                    } else {
                        this.editor.setValue("/* ERROR: Local workspace handle mismatch or missing. Please reload the workspace. */");
                        this.toggleExplorer(false);
                    }
                }
                this.metadata.style.opacity = 0.3;
            } else {
                this.buildTreeFromObject(script.files || {}, new Set());
                this.metadata.style.opacity = 1;
            }

            this.toggleExplorer(true);

            if (this.projectEntryPoint && document.getElementById('fileTree').children.length > 0) {
                if (script.type === 'tracked-project') {
                    if (script.sourceType === 'git') await this.loadVirtual(this.projectEntryPoint);
                    else if (script.sourceType === 'workspace') {
                        try {
                            const handle = await this.getHandleFromPath(this.projectEntryPoint, true);
                            if (handle) await this.loadFile(handle, this.projectEntryPoint);
                            else throw new Error('Entry point handle not found');
                        } catch (e) {
                            this.editor.setValue(`/* ERROR: Could not load entry point: ${this.projectEntryPoint} */`);
                        }
                    }
                } else {
                    this.loadVirtualFileForEditing(this.projectEntryPoint);
                }
                setTimeout(() => {
                    const entryEl = document.querySelector(`.tree-item[data-path="${this.projectEntryPoint}"]`);
                    if (entryEl) entryEl.classList.add('active');
                }, 100);
            } else if (document.getElementById('fileTree').children.length > 0) {
                this.editor.setValue("/* Select a file from the explorer. */");
                this.editor.updateOptions({
                    readOnly: true
                });
            } else if (!this.editor.getValue().startsWith('/* ERROR:')) {
                this.editor.setValue("/* This project appears empty or the source is missing. */");
                this.editor.updateOptions({
                    readOnly: true
                });
            }

            this.updateFileTreeHighlights();
            this.updateMultiFileButtons();

            if (script.githubRepo?.url) {
                const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                if (scTab) scTab.style.display = 'block';
                await this.refreshSourceControl();
            }
        } else {
            this.mode = 'extension';
            this.saveBtn.textContent = 'Save Script';

            const oldModel = this.editor.getModel();
            const newModel = monaco.editor.createModel(
                script.code || '',
                'javascript',
                monaco.Uri.parse(`file:///userscript-${id}.js`)
            );
            this.editor.setModel(newModel);

            if (oldModel) {
                oldModel.dispose();
            }

            this.parseMeta();
            this.toggleExplorer(false);
        }

        this.updateStats();
        this.setStatus(`Loaded: ${this.script.name}`);
        if (this.isPreviewing) this.updatePreview();
        setTimeout(() => {
            if (this.editor) this.editor.focus();
        }, 100);
    }

    async loadRepoHistory() {
        try {
            const data = await chrome.storage.local.get('repoHistory');
            this.populateRepoHistoryDropdown(data.repoHistory || []);

            const select = document.getElementById('repoHistorySelect');
            const urlInput = document.getElementById('repoUrl');
            if (select && urlInput) {
                select.addEventListener('change', () => {
                    if (select.value) {
                        urlInput.value = select.value;
                        select.selectedIndex = 0;
                    }
                });
            }
        } catch (err) {
            console.error("Error loading repo history:", err);
        }
    }

    setupGlobalKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'f')) {
                e.preventDefault();
                e.stopPropagation();
            }

            const isInputFocused = document.activeElement?.tagName === 'INPUT' ||
                document.activeElement?.tagName === 'TEXTAREA';

            const isCommandPaletteOpen = this.isPaletteOpen;
            const isSearchOpen = this.searchState !== null;

            if ((isCommandPaletteOpen || isSearchOpen) && e.key !== 'Escape') {
                return;
            }

            if (isInputFocused && !this.editor?.hasTextFocus()) {
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                e.stopPropagation();
                this.save();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
                this.openSearch({
                    mode: 'replace'
                });
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                this.openSearch({
                    mode: 'search'
                });
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
                e.preventDefault();
                e.stopPropagation();
                this.format();
            } else if ((e.ctrlKey || e.metaKey) && e.key === '[') {
                e.preventDefault();
                e.stopPropagation();
                this.openCommandPalette();
            }
        }, true);
    }

    setupDebouncedValidation() {
        if (!monaco?.languages?.typescript) return;
        monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    }

    UpdateVersionBadge() {
        try {
            const badge = document.querySelector('.version-badge');
            if (badge && this.currentVersion) {
                badge.textContent = `v${this.currentVersion}`;
            }
        } catch (e) {
            console.warn('Could not update version badge:', e);
        }
    }

    // basic quality of life for me and other users
    async CheckForUpdates() {
        const URL = "https://asahi-so-cute-kusoi-lalala.koyeb.app/version";

        try {
            const res = await fetch(URL, {
                cache: 'no-store'
            });
            if (!res.ok) return;

            const data = await res.json();
            const latest = data.latest_version;
            const updateUrl = data.update_url;

            if (this.IsNewerVersion(latest, this.currentVersion)) {
                this.showNotification({
                    title: 'Update Available',
                    message: `New ScripFlow version ${latest} is available, (you are on ${this.currentVersion}).`,
                    type: 'info',
                    duration: 0,
                    buttons: [{
                            text: 'Later',
                            class: 'secondary',
                            callback: () => {
                                // nothing just close
                            }
                        },
                        {
                            text: 'Update',
                            class: 'primary',
                            callback: () => {
                                window.open(updateUrl, '_blank');
                            }
                        }
                    ]
                });
            }
        } catch (err) {
            console.warn('Version check failed:', err);
        }
    }

    IsNewerVersion(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        const len = Math.max(r.length, l.length);
        for (let i = 0; i < len; i++) {
            const rv = r[i] || 0;
            const lv = l[i] || 0;
            if (rv > lv) return true;
            if (rv < lv) return false;
        }
        return false;
    }

    async LoadLastGitConfig() {
        try {
            const data = await chrome.storage.local.get(['lastGitRepoUrl', 'lastGitBranch']);
            this.lastGitRepoUrl = data.lastGitRepoUrl || null;
            this.lastGitBranch = data.lastGitBranch || 'main';
        } catch (e) {
            console.warn('Failed to load lastGitRepoUrl', e);
        }
    }

    // main entry point this kicks everything off
    async init() {
        await this.LoadLastGitConfig();
        await this.initEditor();
        await this.loadRepoHistory();
        await this.CheckForUpdates();
        //this.ResetLocalGitRepo();

        this.UpdateVersionBadge();
        this.setupSourceControl();
        this.setupEditorSettings();
        this.setupSnippets();

        this.setupDebouncedValidation();

        this.loadCustomBackground();
        this.applyCustomBackground();

        this.setupCommands();
        this.setupEvents();
        this.setupGlobalKeyboardShortcuts();
        this.setupDragDrop();
        this.updateStats();
        await this.loadSavedToken();

        this.applyEditorSettings();

        const params = new URLSearchParams(window.location.search);
        const isNewScript = params.get('new') === 'true';
        //this.scriptId = params.get('id');
        if (params.get('id')) {
            this.scriptId = params.get('id');
            await this.loadScript(this.scriptId);
        }
        if (this.scriptId) {
            await this.loadProject(this.scriptId);
        } else if (isNewScript) {
            this.loadTemplate('basic');
            this.parseMeta();
        } else {
            const params = new URLSearchParams(window.location.search);
            const isWorkspace = params.get('workspace') === 'true';

            const localLoaded = await this.loadSavedWorkspace();
            if (!localLoaded) {
                const gitLoaded = await this.loadSavedGitWorkspace();
                if (!gitLoaded) {
                    if (isWorkspace) {
                        this.editor.setValue("/* Click 'Load Workspace' to connect to your folder. */");
                        this.editor.updateOptions({
                            readOnly: true
                        });
                        this.setStatus('Ready to load workspace.');
                    } else {
                        this.loadTemplate('basic');
                        this.parseMeta();
                    }
                }
            }
        }

        this.runOnboardingTour();
    }

    // shows the nice little tour for new users
    runOnboardingTour() {
        if (localStorage.getItem('scriptflow-tour-complete') === 'true') {
            return;
        }

        const tourSteps = [{
                element: '.header h1',
                title: 'Welcome to ScriptFlow Editor! 🎉',
                content: 'This is a powerful code editor for your browser. Let\'s take a quick tour of the key features.',
                position: 'bottom'
            },
            {
                element: '#loadWorkspaceBtn',
                title: 'Load a Local Workspace',
                content: 'Click here to open a folder from your computer. You can edit any file, just like in a desktop IDE.',
                position: 'bottom'
            },
            {
                element: '#gitSyncBtn',
                title: 'Sync with GitHub',
                content: 'You can also clone a GitHub repository, edit files, and push your changes right from the editor.',
                position: 'bottom'
            },
            {
                element: '#explorerToggleBtn',
                title: 'File Explorer',
                content: 'When a workspace is loaded, you can toggle the file explorer here to see your project\'s file tree.',
                position: 'bottom'
            },
            {
                element: '#editor-wrapper',
                title: 'The Command Palette',
                content: 'Press <strong>Ctrl+[</strong> to open the Command Palette. It gives you quick keyboard access to almost every feature!',
                position: 'top'
            }
        ];

        this.startTour(tourSteps);
    }

    startTour(steps) {
        let currentStep = 0;
        const tourOverlay = document.createElement('div');
        tourOverlay.className = 'tour-overlay';

        const tourTooltip = document.createElement('div');
        tourTooltip.className = 'tour-tooltip';

        const highlightElement = (element) => {
            document.querySelectorAll('.tour-highlight').forEach(el => el.classList.remove('tour-highlight'));
            document.querySelectorAll('.tour-context-active').forEach(el => el.classList.remove('tour-context-active'));

            if (element) {
                element.classList.add('tour-highlight');
                const header = element.closest('.header');
                if (header) {
                    header.classList.add('tour-context-active');
                }
            }
        };

        const showStep = (stepIndex) => {
            if (stepIndex >= steps.length) {
                endTour();
                return;
            }

            const step = steps[stepIndex];
            const targetElement = document.querySelector(step.element);

            if (!targetElement) {
                console.warn('Tour element not found:', step.element);
                showStep(stepIndex + 1);
                return;
            }

            highlightElement(targetElement);

            tourTooltip.innerHTML = `
                <h4>${step.title}</h4>
                <p>${step.content}</p>
                <div class="tour-actions">
                    <button id="tour-next">${stepIndex === steps.length - 1 ? 'Finish' : 'Next'}</button>
                    <button id="tour-skip">Skip Tour</button>
                </div>
            `;

            document.body.appendChild(tourTooltip);

            const targetRect = targetElement.getBoundingClientRect();
            const tooltipRect = tourTooltip.getBoundingClientRect();

            let top, left;
            switch (step.position) {
                case 'bottom':
                    top = targetRect.bottom + 10;
                    left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                    break;
                case 'top':
                    top = targetRect.top - tooltipRect.height - 10;
                    left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                    break;
                case 'left':
                    top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                    left = targetRect.right + 10;
                    break;
                default: // right
                    top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                    left = targetRect.left - tooltipRect.width - 10;
            }

            tourTooltip.style.top = `${Math.max(10, top)}px`;
            tourTooltip.style.left = `${Math.max(10, left)}px`;

            document.getElementById('tour-next').onclick = () => showStep(stepIndex + 1);
            document.getElementById('tour-skip').onclick = endTour;
        };

        const endTour = () => {
            tourOverlay.remove();
            tourTooltip.remove();
            highlightElement(null);
            localStorage.setItem('scriptflow-tour-complete', 'true');
        };

        document.body.appendChild(tourOverlay);
        showStep(currentStep);
    }

    setupCommands() {
        this.commands = [{
                id: 'save',
                name: 'File: Save Current File',
                handler: () => this.save(),
                check: () => this.mode !== 'extension' || this.scriptId
            },
            {
                id: 'format',
                name: 'Editor: Format Code',
                handler: () => this.format()
            },
            {
                id: 'toggle_preview',
                name: 'View: Toggle Live Preview',
                handler: () => this.togglePreview()
            },
            {
                id: 'export_zip',
                name: 'Project: Export Workspace as ZIP',
                handler: () => this.exportZip(),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'test_script',
                name: 'Script: Test on example.com',
                handler: () => this.test(),
                check: () => this.mode === 'extension'
            },
            {
                id: 'git_sync',
                name: 'Git: Open Sync Panel',
                handler: () => this.gitModal.classList.add('visible')
            },
            {
                id: 'git_clone',
                name: 'Git: Clone Repository',
                handler: () => this.clone()
            },
            {
                id: 'git_pull',
                name: 'Git: Pull Changes',
                handler: () => {
                    if (this.mode === 'multi-file-edit') {
                        this.pullMultiFile();
                    } else {
                        this.pull();
                    }
                },
                check: () => this.mode === 'git' || (this.mode === 'multi-file-edit' && this.script?.githubRepo?.url)
            },
            {
                id: 'git_push',
                name: 'Git: Push Changes',
                handler: () => {
                    if (this.mode === 'multi-file-edit') {
                        this.pushMultiFile();
                    } else {
                        this.push();
                    }
                },
                check: () => this.mode === 'git' || (this.mode === 'multi-file-edit' && this.script?.githubRepo?.url)
            },
            {
                id: 'new_file',
                name: 'File: New File',
                handler: () => this.newFile(),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'new_folder',
                name: 'File: New Folder',
                handler: () => this.newFolder(),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'toggle_explorer',
                name: 'View: Toggle File Explorer',
                handler: () => this.toggleExplorer()
            },
            {
                id: 'search',
                name: 'Find: Search in File',
                handler: () => this.openSearch({
                    mode: 'search'
                })
            },
            {
                id: 'replace',
                name: 'Find: Replace in File',
                handler: () => this.openSearch({
                    mode: 'replace'
                })
            },
            {
                id: 'help_tour',
                name: 'Help: Start Guided Tour',
                handler: () => {
                    localStorage.removeItem('scriptflow-tour-complete');
                    this.runOnboardingTour();
                }
            },
            {
                id: 'new_multifile_project',
                name: 'File: New Multi-File Project',
                handler: () => this.createEmptyMultiFileProject(),
                check: () => this.mode !== 'multi-file-edit' && !this.workspaceHandle
            },
            {
                id: 'new_image',
                name: 'File: Add Image',
                handler: () => this.newImage(),
                check: () => this.mode === 'workspace' || this.mode === 'git' || this.mode === 'multi-file-edit'
            },
            {
                id: 'push_project',
                name: 'Git: Push Multi-File Project',
                handler: () => this.pushMultiFileProject(),
                check: () => this.mode === 'multi-file-edit'
            },
            {
                id: 'export_project_zip',
                name: 'Project: Export Multi-File Project as ZIP',
                handler: () => this.exportZip(),
                check: () => this.mode === 'multi-file-edit'
            },
            {
                id: 'save_multifile',
                name: 'Script: Save as Multi-File Script',
                handler: () => this.saveAsMultiFileScript(),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'test_multifile',
                name: 'Script: Test Multi-File on example.com',
                handler: () => this.testMultiFile(),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'open_settings',
                name: 'Editor: Open Settings',
                handler: () => this.openEditorSettings()
            },
            {
                id: 'refresh_git_status',
                name: 'Git: Refresh Status',
                handler: () => this.refreshSourceControl(),
                check: () => this.mode === 'git'
            },
            {
                id: 'git_stage_all',
                name: 'Git: Stage All Changes',
                handler: () => {
                    this.sourceControl.changedFiles.forEach(f => {
                        this.sourceControl.stagedFiles.add(f.path);
                    });
                    this.renderSourceControl();
                },
                check: () => this.mode === 'git' && this.sourceControl.changedFiles.length > 0
            },
            {
                id: 'git_commit',
                name: 'Git: Commit Staged Changes',
                handler: () => {
                    const msg = prompt('Commit message:');
                    if (msg) {
                        this.sourceControl.commitMessage = msg;
                        this.commitChanges();
                    }
                },
                check: () => this.mode === 'git' && this.sourceControl.stagedFiles.size > 0
            },
            {
                id: 'git_commit_push',
                name: 'Git: Commit and Push',
                handler: () => {
                    const msg = prompt('Commit message:');
                    if (msg) {
                        this.sourceControl.commitMessage = msg;
                        this.commitChanges(true);
                    }
                },
                check: () => this.mode === 'git' && this.sourceControl.stagedFiles.size > 0
            },
            {
                id: 'increase_font',
                name: 'Editor: Increase Font Size',
                handler: () => {
                    this.editorSettings.fontSize = Math.min(30, this.editorSettings.fontSize + 1);
                    localStorage.setItem('sf_editor_fontSize', this.editorSettings.fontSize);
                    this.applyEditorSettings();
                }
            },
            {
                id: 'decrease_font',
                name: 'Editor: Decrease Font Size',
                handler: () => {
                    this.editorSettings.fontSize = Math.max(10, this.editorSettings.fontSize - 1);
                    localStorage.setItem('sf_editor_fontSize', this.editorSettings.fontSize);
                    this.applyEditorSettings();
                }
            },
            {
                id: 'toggle_minimap',
                name: 'Editor: Toggle Minimap',
                handler: () => {
                    this.editorSettings.minimap = !this.editorSettings.minimap;
                    localStorage.setItem('sf_editor_minimap', this.editorSettings.minimap);
                    this.applyEditorSettings();
                    this.setStatus(`Minimap ${this.editorSettings.minimap ? 'enabled' : 'disabled'}`);
                }
            },
            {
                id: 'switch_to_files',
                name: 'View: Switch to Files Tab',
                handler: () => this.switchSidebarTab('files'),
                check: () => this.mode === 'workspace' || this.mode === 'git'
            },
            {
                id: 'switch_to_source_control',
                name: 'View: Switch to Source Control Tab',
                handler: () => this.switchSidebarTab('source-control'),
                check: () => this.mode === 'git' || (this.mode === 'multi-file-edit' && this.script?.githubRepo?.url)
            },
            {
                id: 'configure_github',
                name: 'Git: Configure GitHub Repository',
                handler: () => {
                    this.gitModal.classList.add('visible');
                    if (this.mode === 'multi-file-edit' && this.script?.githubRepo) {
                        document.getElementById('repoUrl').value = this.script.githubRepo.url || '';
                        document.getElementById('branch').value = this.script.githubRepo.branch || 'main';
                    }
                },
                check: () => this.mode === 'multi-file-edit'
            }
        ];
    }

    openCommandPalette() {
        if (this.isPaletteOpen) return;
        this.isPaletteOpen = true;
        this.commandPalette.overlay.classList.add('visible');
        this.commandPalette.input.value = '';
        this.renderCommandList();
        this.commandPalette.input.focus();
    }

    closeCommandPalette() {
        if (!this.isPaletteOpen) return;
        this.isPaletteOpen = false;
        this.commandPalette.overlay.classList.remove('visible');
        this.editor.focus();
    }

    getAvailableCommands() {
        return this.commands.filter(cmd => !cmd.check || cmd.check());
    }

    // filters commands as i type in the palette
    filterCommands() {
        const query = this.commandPalette.input.value.toLowerCase().trim();
        const availableCommands = this.getAvailableCommands();
        const filtered = availableCommands.filter(cmd => cmd.name.toLowerCase().includes(query));
        this.renderCommandList(filtered);
    }

    renderCommandList(commands) {
        const list = this.commandPalette.list;
        const availableCommands = commands || this.getAvailableCommands();

        list.innerHTML = '';
        if (availableCommands.length === 0) {
            list.innerHTML = '<div class="command-item-none">No matching commands found</div>';
            return;
        }

        availableCommands.forEach((cmd, index) => {
            const item = document.createElement('div');
            item.className = 'command-item';
            if (index === 0) item.classList.add('selected');
            item.dataset.id = cmd.id;
            item.textContent = cmd.name;
            list.appendChild(item);
        });
    }

    handlePaletteKeydown(e) {
        if (e.key === 'Escape') {
            this.closeCommandPalette();
            return;
        }

        const items = this.commandPalette.list.querySelectorAll('.command-item');
        if (items.length === 0) return;

        let selected = this.commandPalette.list.querySelector('.command-item.selected');
        let newSelected;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            newSelected = selected?.nextElementSibling || items[0];
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            newSelected = selected?.previousElementSibling || items[items.length - 1];
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selected) {
                this.executeCommand(selected.dataset.id);
            } else if (items.length > 0) {
                this.executeCommand(items[0].dataset.id);
            }
        }

        if (newSelected) {
            if (selected) selected.classList.remove('selected');
            newSelected.classList.add('selected');
            newSelected.scrollIntoView({
                block: 'nearest'
            });
        }
    }

    // runs the selected command handler
    executeCommand(id) {
        const command = this.commands.find(cmd => cmd.id === id);
        if (command?.handler) {
            command.handler();
        }
        this.closeCommandPalette();
    }

    togglePreview() {
        if (this.isPreviewing) {
            this.closePiPPreview();
        } else {
            this.openPiPPreview();
        }
    }

    async getHandleByPath(path) {
        if (!this.workspaceHandle) return null;
        const parts = path.split('/');
        const entryName = parts.pop();
        const parentPath = parts.join('/');
        const parentHandle = await this.getHandleFromPath(parentPath);
        return await parentHandle.getFileHandle(entryName);
    }

    // runs the preview from the right click context menu
    async previewFromContext() {
        const menu = document.getElementById('fileContextMenu');
        const path = menu.dataset.path;
        const kind = menu.dataset.kind;

        if (!path || kind !== 'file') return;

        if (this.currentPath !== path) {
            if (this.mode === 'git') {
                await this.loadVirtual(path);
            } else if (this.mode === 'workspace') {
                try {
                    const handle = await this.getHandleByPath(path);
                    await this.loadFile(handle, path);
                } catch (e) {
                    this.setStatus('Error finding file for preview.');
                    console.error("Preview Error:", e);
                    return;
                }
            }
        }

        if (!this.isPreviewing) {
            this.togglePreview();
        } else {
            this.updatePreview();
        }
    }

    // sends the current code to the pip iframe
    updatePreview() {
        if (!this.isPreviewing || !this.pipWindow) {
            return;
        }

        const pipIframe = this.pipWindow.document.querySelector('iframe');
        if (!pipIframe || !pipIframe.contentWindow) {
            return;
        }

        const isHtml = (this.currentPath && this.currentPath.toLowerCase().endsWith('.html')) ||
            (!this.currentPath && this.editor.getValue().trim().startsWith('<'));

        if (isHtml) {
            this.setStatus('Updating preview...');
            const code = this.editor.getValue();

            this.processHtmlPreview(code).then(processed => {
                try {
                    pipIframe.contentWindow.postMessage({
                        type: 'clear'
                    }, '*');

                    setTimeout(() => {
                        pipIframe.contentWindow.postMessage(processed, '*');
                        this.setStatus('Preview updated.');
                    }, 50);
                } catch (err) {
                    console.error('[updatePreview] postMessage failed:', err);
                }

            }).catch(err => {
                this.setStatus('Error updating preview.');
                const errorHtml = `
                <!DOCTYPE html>
                <html>
                <body style="font-family: sans-serif; padding: 20px; background: #1e1e1e; color: #ff6b6b;">
                    <h2>Preview Error</h2>
                    <pre style="background: #2d2d2d; padding: 15px; border-radius: 4px; overflow: auto;">${this.escape(err.stack || err.message)}</pre>
                </body>
                </html>
            `;
                if (pipIframe.contentWindow) {
                    pipIframe.contentWindow.postMessage(errorHtml, '*');
                }
            });
        } else {
            console.log('Not HTML file, skipping');
        }
    }

    // src: https://developer.chrome.com/docs/web-platform/document-picture-in-picture
    // opens the preview in a picture in picture window
    // took me a while to figure out how to get the iframe communication working
    async openPiPPreview() {
        if (!documentPictureInPicture.requestWindow) {
            this.setStatus('PiP API not supported on this browser.', true, 'error');
            return;
        }

        try {
            const pip = await documentPictureInPicture.requestWindow({
                width: 1400,
                height: 800,
            });

            const iframe = pip.document.createElement('iframe');
            iframe.src = chrome.runtime.getURL('pages/preview/preview.html');
            iframe.style.cssText = 'width: 100%; height: 100%; border: none;';

            pip.document.documentElement.style.cssText = 'height: 100%;';
            pip.document.body.style.cssText = 'margin: 0; height: 100%; overflow: hidden;';
            pip.document.body.appendChild(iframe);

            this.pipWindow = pip;
            this.isPreviewing = true;
            this.setStatus('Preview window opened');

            iframe.onload = () => {
                this.updatePreview();
            };

            pip.addEventListener('pagehide', () => {
                this.pipWindow = null;
                this.isPreviewing = false;
                this.setStatus('Preview closed');
            });

        } catch (error) {
            console.error('PiP failed:', error);
            this.setStatus('Failed to open preview window.', true, 'error');
        }
    }

    closePiPPreview() {
        if (this.pipWindow) {
            this.pipWindow.close();
        }
    }

    setEditorMode(path) {
        let mode = 'javascript';
        if (path) {
            const ext = path.split('.').pop().toLowerCase();
            switch (ext) {
                case 'html':
                case 'htm':
                    mode = 'html';
                    break;
                case 'css':
                    mode = 'css';
                    break;
                case 'json':
                    mode = 'json';
                    break;
                case 'js':
                    mode = 'javascript';
                    break;
                default:
                    mode = 'plaintext';
            }
        }
        if (this.editor && this.editor.getModel()) {
            monaco.editor.setModelLanguage(this.editor.getModel(), mode);
        }
    }

    // this is tricky it finds relative paths in html and inlines them as base64 or text
    async processHtmlPreview(html) {
        if (!this.workspaceHandle && this.mode !== 'git') {
            return html;
        }

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const resolvePath = (relativePath) => {
                if (!relativePath || relativePath.startsWith('http') || relativePath.startsWith('//') || relativePath.startsWith('data:')) return null;
                if (relativePath.startsWith('./')) relativePath = relativePath.substring(2);
                let folder = '';
                if (this.currentPath && this.currentPath.includes('/')) {
                    folder = this.currentPath.substring(0, this.currentPath.lastIndexOf('/'));
                }
                return folder ? `${folder}/${relativePath}` : relativePath;
            };

            const getFileContent = async (path) => {
                if (this.script && this.script.files && this.script.files[path]) {
                    return this.script.files[path];
                }
                if (this.mode === 'git' && this.gitFS) {
                    try {
                        let targetPath = path;

                        if (!targetPath.startsWith(this.gitDir)) {
                            const cleanPath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
                            targetPath = `${this.gitDir}/${cleanPath}`;
                        }

                        if (path.match(/\.(png|jpg|jpeg|gif|ico|svg)$/i)) {
                            return await this.gitFS.readFile(targetPath);
                        }
                        return await this.gitFS.readFile(targetPath, 'utf8');
                    } catch (e) {
                        // need to see what error is causing it to not work
                        // edit: actually nvm already found the bug
                        //console.warn('Preview file not found:', path);
                    }
                }
                if (this.mode === 'workspace' && this.workspaceHandle) {
                    try {
                        const parts = path.split('/');
                        let currentHandle = this.workspaceHandle;
                        for (let i = 0; i < parts.length - 1; i++) {
                            currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
                        }
                        const fileHandle = await currentHandle.getFileHandle(parts[parts.length - 1]);
                        const file = await fileHandle.getFile();
                        if (path.match(/\.(png|jpg|jpeg|gif|ico|svg)$/i)) {
                            return await file.arrayBuffer();
                        } else {
                            return await file.text();
                        }
                    } catch (e) {
                        console.warn('Not found:', path);
                    }
                }
                return null;
            };

            const toBase64 = (buffer) => {
                let binary = '';
                const bytes = new Uint8Array(buffer);
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                return window.btoa(binary);
            };

            const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
            for (const link of links) {
                const href = link.getAttribute('href');
                const resolved = resolvePath(href);
                if (resolved) {
                    const content = await getFileContent(resolved);
                    if (content) {
                        const style = doc.createElement('style');
                        style.textContent = content;
                        link.replaceWith(style);
                    }
                }
            }

            const scripts = Array.from(doc.querySelectorAll('script[src]'));
            for (const script of scripts) {
                const src = script.getAttribute('src');
                const resolved = resolvePath(src);
                if (resolved) {
                    const content = await getFileContent(resolved);
                    if (content) {
                        script.removeAttribute('src');
                        script.textContent = content;
                    }
                }
            }

            const images = Array.from(doc.querySelectorAll('img[src]'));
            for (const img of images) {
                const src = img.getAttribute('src');
                const resolved = resolvePath(src);
                if (resolved) {
                    const content = await getFileContent(resolved);
                    if (content) {
                        const mime = this.getMimeType(resolved);
                        const b64 = toBase64(content);
                        img.src = `data:${mime};base64,${b64}`;
                    }
                }
            }

            return doc.documentElement.outerHTML;

        } catch (err) {
            console.error('Preview Error:', err);
            return html;
        }
    }

    async loadModuleTree(path, resolvePathFn) {
        const modules = [];
        const visited = new Set();
        const loading = new Set();

        const load = async (modulePath) => {

            const normalizedPath = modulePath.replace(/\.js$/, '') + '.js';

            if (visited.has(normalizedPath)) {
                console.log(`[Preview] Already loaded: ${normalizedPath}`);
                return;
            }

            if (loading.has(normalizedPath)) {
                console.warn(`[Preview] Circular dependency detected: ${normalizedPath}`);
                return;
            }

            loading.add(normalizedPath);
            visited.add(normalizedPath);

            console.log(`[Preview] Loading module: ${normalizedPath}`);
            const code = await this.getFile(normalizedPath, false);

            if (!code) {
                console.warn(`[Preview] Module not found: ${normalizedPath}`);
                loading.delete(normalizedPath);
                return;
            }

            modules.push({
                path: normalizedPath,
                code
            });

            const importRegex = /import\s+(?:{[^}]*}|[^'";\s]+|\*\s+as\s+[^'";\s]+)\s+from\s+['"]([^'"]+)['"]/g;
            let match;
            const imports = [];

            while ((match = importRegex.exec(code)) !== null) {
                imports.push(match[1]);
            }

            console.log(`[Preview] Found ${imports.length} imports in ${normalizedPath}`);

            for (const importPath of imports) {
                const resolved = resolvePathFn(importPath);
                if (resolved && !resolved.startsWith('http')) {
                    const pathToLoad = resolved.endsWith('.js') ? resolved : resolved + '.js';
                    await load(pathToLoad);
                }
            }

            loading.delete(normalizedPath);
        };

        const startPath = path.endsWith('.js') ? path : path + '.js';
        await load(startPath);

        console.log(`[Preview] Loaded ${modules.length} modules total`);
        return modules;
    }

    // a helper to get a file from either git fs or the local workspace
    async getFile(path, binary = false) {
        console.log(`[getFile] Requested: "${path}", Binary: ${binary}, Mode: ${this.mode}`);

        if (this.mode === 'git') {
            const fullPath = `${this.gitDir}/${path}`;
            console.log(`[getFile] Git full path: "${fullPath}"`);

            try {
                const content = await this.fs.promises.readFile(fullPath, binary ? null : 'utf8');
                console.log(`[getFile] Read from Git: ${fullPath} (${binary ? 'binary' : content.length + ' chars'})`);
                return content;
            } catch (e) {
                console.warn(`[getFile] Git file not found: ${fullPath}`, e.code);
                return null;
            }
        } else if (this.mode === 'workspace' && this.workspaceHandle) {
            try {
                const parts = path.split('/').filter(Boolean);
                console.log(`[getFile] Workspace parts:`, parts);
                let handle = this.workspaceHandle;

                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];

                    if (i === parts.length - 1) {
                        handle = await handle.getFileHandle(part);
                    } else {
                        handle = await handle.getDirectoryHandle(part);
                    }
                }

                const file = await handle.getFile();
                const content = binary ? await file.arrayBuffer() : await file.text();
                console.log(`[getFile] Read from workspace: ${path} (${binary ? 'binary' : content.length + ' chars'})`);
                return content;
            } catch (e) {
                console.warn(`[getFile] Workspace file not found: ${path}`, e.name);
                return null;
            }
        }

        console.warn('[getFile] No valid mode');
        return null;
    }

    getMimeType(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const types = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'webp': 'image/webp',
            'ico': 'image/x-icon',
            'bmp': 'image/bmp',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'ogg': 'audio/ogg',
            'mp4': 'video/mp4',
            'webm': 'video/webm'
        };
        return types[ext] || 'application/octet-stream';
    }

    toBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    // src: https://microsoft.github.io/monaco-editor/
    // initializes the monaco editor with all the settings
    initEditor() {
        return new Promise((resolve) => {
            require.config({
                paths: {
                    'vs': '../../lib/vs'
                }
            });

            window.MonacoEnvironment = {
                getWorkerUrl: function(moduleId, label) {
                    const base = chrome.runtime.getURL('lib/vs');

                    if (label === 'json') return `${base}/language/json/json.worker.js`;
                    if (label === 'css' || label === 'scss' || label === 'less') return `${base}/language/css/css.worker.js`;
                    if (label === 'html' || label === 'handlebars' || label === 'razor') return `${base}/language/html/html.worker.js`;
                    if (label === 'typescript' || label === 'javascript') return `${base}/language/typescript/ts.worker.js`;
                    return `${base}/editor/editor.worker.js`;
                }
            };

            require(['vs/editor/editor.main'], () => {
                monaco.languages.typescript.javascriptDefaults.setEagerModelSync(false);
                monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
                    noSemanticValidation: false,
                    noSyntaxValidation: false,
                    noSuggestionDiagnostics: true,
                    diagnosticCodesToIgnore: [
                        1375,
                        2339,
                        7016,
                    ],
                });

                monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
                    target: monaco.languages.typescript.ScriptTarget.ESNext,
                    allowNonTsExtensions: false,
                    checkJs: false,
                    allowJs: true,
                    noImplicitAny: true,
                    strict: false,
                    noUnusedLocals: false,
                    noUnusedParameters: false,
                    noImplicitReturns: false,
                    noFallthroughCasesInSwitch: false,
                    allowUnreachableCode: true,
                    allowUnusedLabels: true,
                    skipLibCheck: true,
                    skipDefaultLibCheck: true,
                    maxNodeModuleJsDepth: 0,
                });

                const gmTypeDefs = `
                    declare function GM_addStyle(css: string): HTMLElement;
                    declare function GM_setValue(name: string, value: any): void;
                    declare function GM_getValue(name: string, defaultValue?: any): any;
                    declare function GM_deleteValue(name: string): void;
                    declare function GM_listValues(): string[];
                    declare function GM_log(message: any): void;
                    declare const unsafeWindow: Window;
                    declare const chrome: any;
                    declare const browser: any;
                    declare const GM: any;
                    declare const GM_info: any;
                `;
                monaco.languages.typescript.javascriptDefaults.addExtraLib(gmTypeDefs, 'file:///gm.d.ts');

                monaco.editor.defineTheme('dracula', {
                    base: 'vs-dark',
                    inherit: true,
                    rules: [{
                            token: 'comment',
                            foreground: '6272a4'
                        },
                        {
                            token: 'string',
                            foreground: 'f1fa8c'
                        },
                        {
                            token: 'number',
                            foreground: 'bd93f9'
                        },
                        {
                            token: 'keyword',
                            foreground: 'ff79c6'
                        },
                        {
                            token: 'delimiter',
                            foreground: 'f8f8f2'
                        },
                        {
                            token: 'tag',
                            foreground: '8be9fd'
                        },
                        {
                            token: 'attribute.name',
                            foreground: '50fa7b'
                        },
                        {
                            token: 'attribute.value',
                            foreground: 'f1fa8c'
                        },
                        {
                            token: 'operator',
                            foreground: 'ff79c6'
                        },
                    ],
                    colors: {
                        'editor.background': '#071028',
                        'editor.foreground': '#f8f8f2',
                        'editorCursor.foreground': '#f8f8f0',
                        'editor.lineHighlightBackground': '#44475a',
                        'editor.selectionBackground': '#44475a',
                        'editorGutter.background': '#071028',
                        'editorError.foreground': '#ef4444',
                        'editorWarning.foreground': '#f59e0b',
                        'editorInfo.foreground': '#3b82f6',
                        'editorError.background': 'transparent',
                        'editorGutter.error': '#ef4444',
                        'editorGutter.warning': '#f59e0b',
                        'editorGutter.info': '#3b82f6'
                    }
                });

                monaco.editor.defineTheme('monokai', {
                    base: 'vs-dark',
                    inherit: true,
                    rules: [{
                            token: 'comment',
                            foreground: '75715e'
                        },
                        {
                            token: 'string',
                            foreground: 'e6db74'
                        },
                        {
                            token: 'number',
                            foreground: 'ae81ff'
                        },
                        {
                            token: 'keyword',
                            foreground: 'f92672'
                        },
                        {
                            token: 'identifier',
                            foreground: 'a6e22e'
                        },
                        {
                            token: 'type',
                            foreground: '66d9ef'
                        },
                    ],
                    colors: {
                        'editor.background': '#272822',
                        'editor.foreground': '#f8f8f2',
                        'editor.selectionBackground': '#49483e',
                        'editor.lineHighlightBackground': '#3e3d32',
                        'editorCursor.foreground': '#f8f8f0',
                    }
                });

                monaco.editor.defineTheme('solarized-light', {
                    base: 'vs',
                    inherit: true,
                    rules: [{
                            token: 'comment',
                            foreground: '93a1a1'
                        },
                        {
                            token: 'string',
                            foreground: '2aa198'
                        },
                        {
                            token: 'number',
                            foreground: 'd33682'
                        },
                        {
                            token: 'keyword',
                            foreground: '859900'
                        },
                        {
                            token: 'identifier',
                            foreground: '657b83'
                        },
                    ],
                    colors: {
                        'editor.background': '#fdf6e3',
                        'editor.foreground': '#657b83',
                        'editor.selectionBackground': '#eee8d5',
                        'editor.lineHighlightBackground': '#eee8d5',
                        'editorCursor.foreground': '#657b83',
                    }
                });

                this.editor = monaco.editor.create(document.getElementById('codeEditorContainer'), {
                    language: 'javascript',
                    theme: 'dracula',
                    lineNumbers: 'on',
                    autoClosingBrackets: 'languageDefined',
                    autoClosingQuotes: 'languageDefined',
                    matchBrackets: 'always',
                    wordWrap: 'on',
                    tabSize: 4,
                    insertSpaces: false,
                    glyphMargin: true,
                    minimap: {
                        enabled: true
                    },
                    automaticLayout: true,
                });

                const initialModel = monaco.editor.createModel(
                    '',
                    'javascript',
                    monaco.Uri.parse('file:///userscript.js')
                );
                this.editor.setModel(initialModel);

                this.editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                    () => this.save()
                );

                this.editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
                    () => this.format()
                );

                this.editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
                    () => this.openSearch({
                        mode: 'search'
                    })
                );

                this.editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR,
                    () => this.openSearch({
                        mode: 'replace'
                    })
                );

                this.editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketLeft,
                    () => this.openCommandPalette()
                );

                document.addEventListener('keydown', (e) => {
                    const isInputFocused = document.activeElement?.tagName === 'INPUT' ||
                        document.activeElement?.tagName === 'TEXTAREA';

                    if (!isInputFocused || this.editor?.hasTextFocus()) {
                        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                            e.preventDefault();
                            this.save();
                        } else if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
                            e.preventDefault();
                            this.openSearch({
                                mode: 'replace'
                            });
                        } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                            e.preventDefault();
                            this.openSearch({
                                mode: 'search'
                            });
                        } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
                            e.preventDefault();
                            this.format();
                        } else if ((e.ctrlKey || e.metaKey) && e.key === '[') {
                            e.preventDefault();
                            this.openCommandPalette();
                        }
                    }
                }, true);

                this.debounceParse = this.debounce(() => this.parseMeta(), 500);
                this.debounceConvert = this.debounce(() => this.tryConvert(), 750);
                this.debouncePreview = this.debounce(() => this.updatePreview(), 300);

                let changeTimeout;
                this.editor.onDidChangeModelContent((e) => {
                    clearTimeout(changeTimeout);
                    changeTimeout = setTimeout(() => {
                        this.updateStats();
                        this.setStatus('Modified');
                        this.debounceParse();
                        this.debounceConvert();
                        if (this.isPreviewing) this.debouncePreview();
                    }, 800);
                });

                setTimeout(() => {
                    this.editor.focus();
                }, 100);

                resolve();
            });
        });
    }

    // yurio wont keep shutting up about image rendering so i made a simple one
    isImageFile(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext);
    }

    displayImageInEditor(imageUrl, filename, isDataUrl = false) {
        this.editor.updateOptions({
            readOnly: true
        });

        const editorContainer = document.getElementById('codeEditorContainer');

        const existingPreview = editorContainer.querySelector('.image-preview-overlay');
        if (existingPreview) {
            existingPreview.remove();
        }

        const imagePreview = document.createElement('div');
        imagePreview.className = 'image-preview-overlay';
        imagePreview.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 20px;
    `;

        imagePreview.innerHTML = `
        <div style="position: absolute; top: 20px; right: 20px;">
            <button id="closeImagePreview" class="btn btn-secondary" style="padding: 8px 16px;">
                Close (ESC)
            </button>
        </div>
        <div style="text-align: center; margin-bottom: 20px;">
            <h3 style="margin: 0 0 10px 0; color: var(--text);">${this.escape(filename)}</h3>
            <p style="margin: 0; color: var(--muted); font-size: 14px;">Image Preview (binary file)</p>
        </div>
        <img src="${imageUrl}" style="max-width: 90%; max-height: 70vh; object-fit: contain; border: 1px solid var(--border); border-radius: 4px;" alt="${this.escape(filename)}">
        <div style="margin-top: 20px; color: var(--muted); font-size: 14px;">
            This is a binary image file and cannot be edited as text.
        </div>
    `;

        editorContainer.appendChild(imagePreview);
        this.editor.setValue(`// Image file: ${filename}\n// Binary content cannot be displayed as text`);

        const closeBtn = imagePreview.querySelector('#closeImagePreview');

        const closePreview = () => {
            imagePreview.remove();
            this.editor.updateOptions({
                readOnly: false
            });
            this.editor.setValue('/* Select a file from the explorer to edit. */');
            this.currentPath = null;
            this.fileHandle = null;
            this.setStatus('Image preview closed');

            const tree = document.getElementById('fileTree');
            const current = tree?.querySelector('.tree-item.active');
            if (current) current.classList.remove('active');

            document.removeEventListener('keydown', this.boundCloseImageHandler);
            this.boundCloseImageHandler = null;
        };

        closeBtn.addEventListener('click', closePreview);

        this.boundCloseImageHandler = (e) => {
            if (e.key === 'Escape') {
                closePreview();
            }
        };
        document.addEventListener('keydown', this.boundCloseImageHandler);
    }

    // src: https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
    // took me few hours to make this work properly but basically
    // this loads a file from the local filesystem using the file system access api
    async loadFile(handle, path) {
        try {
            this.fileHandle = handle;
            this.currentPath = path;
            this.setEditorMode(handle.name);
            this.mode = this.workspaceHandle ? 'workspace' : 'local';
            this.saveBtn.textContent = 'Save File';

            if (this.isImageFile(handle.name)) {
                const file = await handle.getFile();
                const imageUrl = URL.createObjectURL(file);
                this.displayImageInEditor(imageUrl, handle.name);
                this.setStatus(`Viewing image: ${this.currentPath}`);
                return;
            }

            this.editor.updateOptions({
                readOnly: false
            });

            const editorContainer = document.getElementById('codeEditorContainer');
            const existingPreview = editorContainer.querySelector('.image-preview-overlay');
            if (existingPreview) {
                existingPreview.remove();
            }

            const file = await handle.getFile();
            const content = await file.text();

            this.editor.setValue(content);
            this.setStatus(`Loaded: ${this.currentPath} (${(content.length / 1024).toFixed(2)} KB)`);

            this.currentFile = {
                full: content,
                complete: true,
                size: content.length
            };
            this.isLargeFile = false;

            if (this.isPreviewing) this.updatePreview();

        } catch (err) {
            console.error("Error loading file:", err);
            this.setStatus(`Error loading file: ${this.currentPath}`);
        }
    }

    // this builds the file explore tree from a directory handle
    // it recursively scans the folders
    async buildTree(dir, element, basePath = '', expandedPaths = new Set()) {
        element.innerHTML = '<div style="padding: 10px; color: var(--muted);">Loading...</div>';

        try {
            let entries = [];
            for await (const entry of dir.values()) {
                entries.push(entry);
            }

            entries.sort((a, b) => {
                if (a.kind === 'directory' && b.kind !== 'directory') return -1;
                if (a.kind !== 'directory' && b.kind === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            element.innerHTML = '';
            const fragment = document.createDocumentFragment();

            for (const entry of entries) {
                const li = document.createElement('li');
                const item = document.createElement('div');
                item.classList.add('tree-item');
                item.setAttribute('draggable', true);

                const currentPath = basePath ? `${basePath}/${entry.name}` : entry.name;
                item.dataset.path = currentPath;
                item.dataset.kind = entry.kind;

                const arrow = document.createElement('span');
                arrow.className = 'arrow';
                item.appendChild(arrow);

                const icon = document.createElement('span');
                icon.className = 'icon';
                item.appendChild(icon);

                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = entry.name;
                item.appendChild(name);

                li.appendChild(item);

                if (entry.kind === 'directory') {
                    item.classList.add('is-folder');

                    const shouldExpand = expandedPaths.has(currentPath);
                    item.setAttribute('data-state', shouldExpand ? 'expanded' : 'collapsed');
                    icon.classList.add('folder');

                    const nested = document.createElement('ul');
                    nested.className = 'nested-tree';
                    li.appendChild(nested);

                    if (shouldExpand) {
                        await this.buildTree(entry, nested, currentPath, expandedPaths);
                    }

                    const toggle = () => {
                        const state = item.getAttribute('data-state');
                        if (state === 'collapsed') {
                            item.setAttribute('data-state', 'expanded');
                            if (nested.children.length === 0) {
                                this.buildTree(entry, nested, currentPath);
                            }
                        } else {
                            item.setAttribute('data-state', 'collapsed');
                        }
                    };
                    item.addEventListener('click', toggle);

                } else {
                    item.classList.add('is-file');
                    icon.classList.add('file');
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const tree = document.getElementById('fileTree');
                        const current = tree.querySelector('.tree-item.active');
                        if (current) current.classList.remove('active');
                        item.classList.add('active');
                        this.loadFile(entry, currentPath);
                    });
                }
                fragment.appendChild(li);
            }
            element.appendChild(fragment);

        } catch (err) {
            console.error('Error building tree:', err);
            element.innerHTML = '<div style="padding: 10px; color: red;">Error loading directory</div>';
        }
    }

    // this checks for old userscript headers and converts them to the new scriptflow json block
    async tryConvert() {
        if (!this.editor) return;

        const model = this.editor.getModel();
        if (!model) return;

        const lineCount = Math.min(50, model.getLineCount());
        let header = '';
        for (let i = 1; i <= lineCount; i++) {
            header += model.getLineContent(i) + '\n';
        }

        const hasUserScript = /\/\/\s*==UserScript==/.test(header);
        const hasScriptFlow = /\/\*\s*@ScriptFlow/.test(header);

        if (!hasUserScript || hasScriptFlow) return;

        const code = this.editor.getValue();
        const match = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
        if (!match) return;

        this.setStatus('Userscript detected, converting...');

        const headerBlock = match[1];
        const remaining = code.substring(match[0].length).trimStart();
        const lines = headerBlock.split('\n').filter(line => line.trim() !== '');

        const meta = {};
        const multiKeys = ['match', 'grant', 'require', 'resource', 'connect'];

        for (const line of lines) {
            const lineMatch = line.match(/\/\/\s*@(\S+)\s+(.*)/);
            if (lineMatch) {
                const key = lineMatch[1].trim();
                const value = lineMatch[2].trim();

                if (multiKeys.includes(key)) {
                    if (!meta[key]) meta[key] = [];
                    meta[key].push(value);
                } else {
                    meta[key] = value;
                }
            }
        }

        if (!meta.name) {
            this.setStatus('Missing @name, skipping conversion');
            return;
        }

        if (meta['run-at']) {
            const runAtValue = meta['run-at'].trim();
            const runAtMap = {
                'document-start': 'document-start',
                'document-end': 'document-end',
                'document-idle': 'document-idle',
                'document_start': 'document-start',
                'document_end': 'document-end',
                'document_idle': 'document-idle'
            };
            meta['run-at'] = runAtMap[runAtValue] || 'document-idle';
        }

        const allUrlPatterns = new Set([
            '*://*/*',
            'http://*/*',
            'https://*/*'
        ]);

        if (Array.isArray(meta.match)) {
            const hasAllUrls = meta.match.some(m => allUrlPatterns.has(String(m).trim()));
            if (hasAllUrls) {
                meta.match = ['all'];
            }
        } else if (typeof meta.match === 'string') {
            if (allUrlPatterns.has(meta.match.trim())) {
                meta.match = ['all'];
            }
        }

        const newHeader = `/*
@ScriptFlow
${JSON.stringify(meta, null, 2)}
*/`;

        const newCode = `${newHeader}\n\n${remaining}`;

        setTimeout(() => {
            const cursor = this.editor.getPosition();
            this.editor.setValue(newCode);
            this.editor.setPosition(cursor);
            this.setStatus('Userscript converted to ScriptFlow!');
        }, 100);
    }

    // standard debounce function so i dont run stuff on every keystroke
    debounce(func, delay) {
        let timeout;
        let lastArgs;

        const debounced = (...args) => {
            lastArgs = args;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, lastArgs), delay);
        };

        debounced.flush = () => {
            clearTimeout(timeout);
            if (lastArgs) {
                func.apply(this, lastArgs);
                lastArgs = undefined;
            }
        };

        return debounced;
    }

    updateStats() {
        requestAnimationFrame(() => {
            if (!this.editor || !this.editor.getModel()) return;

            const model = this.editor.getModel();
            const lines = model.getLineCount();
            const chars = model.getValueLength();

            document.getElementById('lineCount').textContent = `${lines.toLocaleString()} lines`;
            document.getElementById('charCount').textContent = `${chars.toLocaleString()} characters`;
        });
    }

    // handles drag and drop for opening files/folders
    setupDragDrop() {
        const zone = document.body;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(event => {
            zone.addEventListener(event, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        zone.addEventListener('dragenter', () => zone.classList.add('drag-over'), false);
        zone.addEventListener('dragover', () => zone.classList.add('drag-over'), false);
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'), false);

        zone.addEventListener('drop', async (event) => {
            zone.classList.remove('drag-over');
            if (!event.dataTransfer.types.includes('Files') || !event.dataTransfer.items?.length) {
                return;
            }

            try {
                const handle = await event.dataTransfer.items[0].getAsFileSystemHandle();
                if (!handle) return;

                if (handle.kind === 'directory') {
                    await this.initWorkspace(handle);
                } else if (handle.kind === 'file') {
                    this.workspaceHandle = null;
                    this.scriptId = null;
                    this.saveBtn.textContent = 'Save File';
                    this.toggleExplorer(false);
                    document.getElementById('fileTree').innerHTML = '';
                    await this.loadFile(handle, handle.name);
                }
            } catch (e) {
                console.error("Drop error:", e);
                this.setStatus("Error: Could not handle dropped file");
            }
        });
    }

    async loadSavedToken() {
        try {
            const token = await this.idb.get('settings', 'gitToken');
            if (token) {
                document.getElementById('token').value = token;
                this.logGit('Token loaded');
            }
        } catch (err) {
            console.warn('Could not load token:', err);
        }

        const input = document.getElementById('token');
        if (input) {
            let timeout;
            input.addEventListener('input', () => {
                clearTimeout(timeout);
                timeout = setTimeout(async () => {
                    const token = input.value.trim();
                    try {
                        await this.idb.set('settings', 'gitToken', token);
                        if (token) this.logGit('Token saved');
                    } catch (err) {
                        console.warn('Could not save token:', err);
                    }
                }, 1000);
            });
        }
    }

    async loadSavedWorkspace() {
        const data = await this.idb.get('workspaces', 'root');
        if (data && data.handle) {
            try {
                await data.handle.requestPermission({
                    mode: 'readwrite'
                });
                this.workspaceHandle = data.handle;
                await this.initWorkspace(data.handle);

                const repoUrl = document.getElementById('repoUrl')?.value?.trim();
                if (repoUrl && repoUrl.startsWith('https')) {
                    const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                    if (scTab) scTab.style.display = 'block';
                }

                return true;
            } catch (err) {
                console.log('Permission denied or workspace unavailable');
                return false;
            }
        }
        return false;
    }

    async createEmptyMultiFileProject() {
        this.showNotification({
            title: 'Create New Project',
            message: 'Enter project name in the prompt',
            type: 'info',
            duration: 0,
            buttons: [{
                    text: 'Cancel',
                    class: 'secondary',
                    callback: () => {}
                },
                {
                    text: 'Continue',
                    class: 'primary',
                    callback: () => {
                        const name = prompt('Enter project name:', 'My New Project');
                        if (!name || !name.trim()) return;

                        const matches = prompt('URL patterns (comma-separated):', '*://example.com/*');
                        if (!matches) return;

                        this.script = {
                            type: 'multi-file',
                            name: name.trim(),
                            description: 'New multi-file project',
                            entryPoint: 'main.js',
                            files: {
                                'main.js': `(function() {
    'use strict';
    
    console.log('${name.trim()} loaded!');
    
})();`
                            },
                            matches: matches.split(',').map(m => m.trim()),
                            grant: ['GM_addStyle', 'GM_getValue', 'GM_setValue'],
                            runAt: 'document_idle',
                            enabled: true,
                            lastModified: Date.now()
                        };

                        this.scriptId = null;
                        this.mode = 'multi-file-edit';
                        this.saveBtn.textContent = 'Save Project';
                        this.metadata.style.opacity = 1;
                        this.projectEntryPoint = 'main.js';

                        this.buildTreeFromObject(this.script.files, new Set());
                        this.toggleExplorer(true);
                        this.loadVirtualFileForEditing('main.js');

                        this.updateMultiFileButtons();
                        this.updateFileTreeHighlights();

                        document.getElementById('scriptName').value = name.trim();
                        document.getElementById('scriptDescription').value = 'New multi-file project';
                        this.matches = matches.split(',').map(m => m.trim());
                        this.renderMatches();

                        this.setStatus(`Created new project: ${name}`, true, 'success');
                    }
                }
            ]
        });
    }

    updateMultiFileButtons() {
        const multiFileSaveBtn = document.getElementById('saveMultiFileBtn');
        const exportZipBtn = document.getElementById('exportZipBtn');
        const testBtn = document.getElementById('testBtn');
        const pullBtn = document.getElementById('pullMultiFileBtn');
        const pushBtn = document.getElementById('pushMultiFileBtn');

        if (this.mode === 'workspace' || this.mode === 'git') {
            if (multiFileSaveBtn) multiFileSaveBtn.style.display = 'flex';
            if (testBtn) testBtn.style.display = 'none';
            if (pullBtn) pullBtn.style.display = 'none';
            if (pushBtn) pushBtn.style.display = 'none';
            if (exportZipBtn) {
                exportZipBtn.style.display = 'flex';
                exportZipBtn.textContent = 'Export as ZIP';
            }
        } else if (this.mode === 'multi-file-edit') {
            if (testBtn) testBtn.style.display = 'none';
            if (multiFileSaveBtn) multiFileSaveBtn.style.display = 'none';

            const hasGithubRepo = this.script?.githubRepo?.url;
            if (pullBtn) pullBtn.style.display = hasGithubRepo ? 'flex' : 'none';
            if (pushBtn) pushBtn.style.display = hasGithubRepo ? 'flex' : 'none';

            if (exportZipBtn) {
                exportZipBtn.style.display = 'flex';
                exportZipBtn.textContent = 'Export ZIP';
            }
        } else {
            if (multiFileSaveBtn) multiFileSaveBtn.style.display = 'none';
            if (testBtn) testBtn.style.display = 'flex';
            if (pullBtn) pullBtn.style.display = 'none';
            if (pushBtn) pushBtn.style.display = 'none';
            if (exportZipBtn) exportZipBtn.style.display = 'none';
        }
    }

    // this is the main function for opening a local folder
    // is requests permission and then builds the file tree
    async initWorkspace(handle, save = true) {
        try {
            const granted = await handle.requestPermission({
                mode: 'readwrite'
            }) === 'granted';
            if (!granted) {
                this.setStatus("Permission denied");
                return;
            }

            if (save) {
                await this.idb.set('workspaces', 'root', {
                    handle
                });
            }

            this.workspaceHandle = handle;
            this.projectEntryPoint = null;
            this.mode = 'workspace';
            this.saveBtn.textContent = 'Save File';
            this.metadata.style.opacity = 0.3;

            await this.buildTree(handle, document.getElementById('fileTree'));
            this.toggleExplorer(true);

            this.editor.setValue("/* Select a file from the explorer to begin editing. */");
            this.editor.updateOptions({
                readOnly: true
            });
            this.updateMultiFileButtons();
            this.setStatus(`Workspace "${handle.name}" loaded`);
            if (this.mode === 'git') {
                const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                if (scTab) scTab.style.display = 'block';
            }
        } catch (err) {
            console.error("Error initializing workspace:", err);
            this.setStatus("Could not load workspace");
        }
    }

    // reads the json block from the code and updates the sidebar inputs
    parseMeta() {
        if (!this.editor || this.mode !== 'extension') return;

        const model = this.editor.getModel();
        if (!model) return;

        const lineCount = Math.min(30, model.getLineCount());
        let header = '';
        for (let i = 1; i <= lineCount; i++) {
            header += model.getLineContent(i) + '\n';
        }

        const match = header.match(/\/\*\s*@ScriptFlow\s*(\{[\s\S]*?\})\s*\*\//);
        if (!match) return;

        try {
            const meta = JSON.parse(match[1]);
            document.getElementById('scriptName').value = meta.name || '';
            document.getElementById('scriptDescription').value = meta.description || '';
            this.matches = Array.isArray(meta.match) ? meta.match :
                (typeof meta.match === 'string' ? [meta.match] : []);
            this.grants = meta.grant || [];
            this.renderMatches();
        } catch (e) {
            // invalid json so ignore it
        }
    }

    // shows the little popup message at the top right
    showNotification(options) {
        const {
            title,
            message,
            type = 'info',
            duration = 5000,
            buttons
        } = options;

        const container = document.getElementById('notification-container');
        if (!container) return;

        const existingNotifs = container.querySelectorAll('.notification');
        for (const notif of existingNotifs) {
            const existingTitle = notif.querySelector('.notification-title')?.textContent;
            const existingMsg = notif.querySelector('.notification-message')?.textContent;

            if (existingTitle === title && existingMsg === message) {
                return; // die
            }
        }

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;

        let buttonsHTML = '';
        if (buttons && buttons.length > 0) {
            const notifId = `notif-${Date.now()}`;
            notification.id = notifId;

            buttonsHTML = `<div class="notification-buttons">
			${buttons.map((btn, index) => `
				<button id="${notifId}-btn-${index}" class="notification-btn ${btn.class}">
					${this.escape(btn.text)}
				</button>
			`).join('')}
		</div>`;
        }

        let icon = '';
        if (type === 'success') {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>';
        } else if (type === 'error') {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" /></svg>';
        } else if (type === 'warning') {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>';
        } else { // info
            icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" /></svg>';
        }

        const titleEl = title ? `<div class="notification-title">${this.escape(title)}</div>` : '';

        notification.innerHTML = `
		<div class="notification-icon">${icon}</div>
		<div class="notification-content">
			${titleEl}
			<div class="notification-message">${this.escape(message)}</div>
			${buttonsHTML}
		</div>
		${duration > 0 && !buttons ? '<div class="notification-progress"></div>' : ''}
	`;

        container.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('show');
        }, 10);

        if (duration > 0 && !buttons) {
            setTimeout(() => {
                notification.classList.remove('show');
                notification.classList.add('hide');
                setTimeout(() => notification.remove(), 500);
            }, duration);
        }

        if (buttons && buttons.length > 0) {
            buttons.forEach((btn, index) => {
                const btnEl = document.getElementById(`${notification.id}-btn-${index}`);
                if (btnEl) {
                    btnEl.addEventListener('click', () => {
                        if (btn.callback) btn.callback();
                        notification.classList.remove('show');
                        notification.classList.add('hide');
                        setTimeout(() => notification.remove(), 500);
                    });
                }
            });
        }

        if (!buttons) {
            notification.addEventListener('click', () => {
                notification.classList.remove('show');
                notification.classList.add('hide');
                setTimeout(() => notification.remove(), 500);
            });
        }
    }

    setStatus(msg, showNotif = false, notifType = 'info') {
        document.getElementById('statusText').textContent = msg;
        if (showNotif) {
            let title = 'Notification';
            if (notifType === 'success') title = 'Success';
            if (notifType === 'error') title = 'Error';

            if (msg.startsWith('Committed:')) title = 'Commit Successful';
            if (msg.startsWith('Settings saved')) title = 'Settings Saved';
            if (msg.startsWith('Found saved Git workspace:')) {
                title = 'Workspace Loaded';
                msg = msg.replace('Found saved Git workspace: ', 'Restored: ') + ".";
            }

            this.showNotification({
                title: title,
                message: msg,
                type: notifType
            });
        }
    }

    triggerSaveCounter() {
        if (this.mode !== 'git' && this.mode !== 'workspace') return;

        this.saveCounter++;

        if (this.mode === 'git' && this.saveCounter >= this.savesUntilPrompt) {
            this.showNotification({
                title: "Auto Backup Reminder",
                message: "You've made several changes. Commit and push them now?",
                type: 'info',
                buttons: [{
                        text: "No, Later",
                        class: "secondary",
                        callback: () => {
                            this.saveCounter = 0;
                        }
                    },
                    {
                        text: "Yes, Commit/Push",
                        class: "primary",
                        callback: () => {
                            this.sourceControl.changedFiles.forEach(f => {
                                if (!f.isStaged) {
                                    f.isStaged = true;
                                    this.sourceControl.stagedFiles.add(f.path);
                                }
                            });

                            this.sourceControl.commitMessage = "Auto-save commit from ScriptFlow";

                            this.commitChanges(true);

                            this.saveCounter = 0;
                        }
                    }
                ]
            });
        } else if (this.mode === 'workspace' && this.saveCounter >= this.savesUntilPrompt) {
            this.showNotification({
                title: "Backup Reminder",
                message: "You've made several changes. Push this workspace to GitHub?",
                type: 'info',
                buttons: [{
                        text: "No, Later",
                        class: "secondary",
                        callback: () => {
                            this.saveCounter = 0;
                        }
                    },
                    {
                        text: "Yes, Open Git Sync",
                        class: "primary",
                        callback: () => {
                            this.gitModal.classList.add('visible');
                            this.saveCounter = 0;
                        }
                    }
                ]
            });
        }
    }

    renderMatches() {
        const container = document.getElementById('matchesContainer');
        container.innerHTML = this.matches.map((match, index) =>
            `<div class="match-item">
				<span>${this.escape(match)}</span>
				<button class="match-remove" data-index="${index}" title="Remove">&times;</button>
			</div>`
        ).join('');

        if (this.matches.length === 0) {
            const placeholder = this.mode === 'extension' ?
                'No patterns in code' :
                'No patterns added yet';
            container.innerHTML = `<div class="match-item" style="color: var(--muted); font-style: italic;">${placeholder}</div>`;
        }

        container.querySelectorAll('.match-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.matches.splice(parseInt(e.target.dataset.index, 10), 1);
                this.renderMatches();
                this.setStatus('URL pattern removed');
            });
        });
    }

    addMatch() {
        if (this.mode === 'extension') {
            this.setStatus('Patterns must be edited in the @ScriptFlow JSON block');
            return;
        }

        const newMatchInput = document.getElementById('newMatch');
        const pattern = newMatchInput.value.trim();
        if (pattern) {
            this.matches.push(pattern);
            this.renderMatches();
            newMatchInput.value = '';
            this.setStatus('URL pattern added');
        }
    }

    loadTemplate(name) {
        if (!this.templates[name]) return;
        this.mode = 'extension';
        this.toggleExplorer(false);
        this.saveBtn.textContent = 'Save Script';
        this.metadata.style.opacity = 1;
        this.editor.updateOptions({
            readOnly: false
        });

        const oldModel = this.editor.getModel();
        const newModel = monaco.editor.createModel(
            this.templates[name],
            'javascript',
            monaco.Uri.parse(`file:///script-${Date.now()}.js`)
        );
        this.editor.setModel(newModel);

        if (oldModel) {
            oldModel.dispose();
        }
    }

    // this is the main save function it calls the correct save method based on the mode
    async save() {
        if (this.mode === 'multi-file-edit') {
            await this.saveMultiFileProject();
        } else if (this.mode === 'workspace' || this.mode === 'local') {
            await this.saveFile();
        } else if (this.mode === 'extension') {
            await this.saveScript();
        } else if (this.mode === 'git') {
            await this.saveVirtual();
        }

        if (this.isPreviewing) {
            console.log("Updating preview after save...");
            this.updatePreview();
        }
    }

    async saveMultiFileProject() {
        if (!this.script) return;

        if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
            this.script.files[this.currentPath] = this.editor.getValue();
        }

        this.script.name = document.getElementById('scriptName').value.trim();
        this.script.description = document.getElementById('scriptDescription').value.trim();
        this.script.enabled = document.getElementById('scriptEnabled').checked;
        this.script.matches = this.matches;
        const runAtSelect = document.getElementById('scriptRunAt');
        this.script.runAt = runAtSelect?.value || this.editorSettings.runAt || 'document-idle';
        if (this.projectEntryPoint) this.script.entryPoint = this.projectEntryPoint;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveScript',
                script: this.script
            });
            this.setStatus(`Project "${this.script.name} saved!`, true, 'success');
        } catch (err) {
            console.error('Failed to save multi-file project:', err);
            this.setStatus('Error saving project');
        }
    }

    async saveAsMultiFileScript() {
        if (this.mode !== 'workspace' && this.mode !== 'git') {
            this.setStatus('Multi-file scripts require a workspace or git repository');
            return;
        }

        const scriptName = prompt('Enter script name:', 'My MultiFile ScriptFlow');
        if (!scriptName) return;

        let entryPoint;
        if (this.projectEntryPoint) {
            entryPoint = this.projectEntryPoint;

            if (this.mode === 'git' && entryPoint.startsWith(this.gitDir + '/')) {
                entryPoint = entryPoint.substring(this.gitDir.length + 1);
            }

            this.setStatus(`Using "${entryPoint}" as entry point.`, true, 'info');
        } else {
            entryPoint = prompt('Entry point/main file (relative path):', 'main.js');
        }

        if (!entryPoint) return;

        const matches = prompt('URL patterns (comma-separated):', '*://example.com/*');
        if (!matches) return;

        this.setStatus('Collecting files...');

        const files = await this.collectWorkspaceFiles();

        const script = {
            type: 'multi-file',
            name: scriptName,
            description: `Multi-file script with ${Object.keys(files).length} files`,
            entryPoint: entryPoint,
            files: files,
            matches: matches.split(',').map(m => m.trim()),
            grant: ['GM_addStyle', 'GM_getValue', 'GM_setValue'],
            runAt: document.getElementById('scriptRunAt')?.value || this.editorSettings.runAt || 'document_idle',
            enabled: true,
            lastModified: Date.now()
        };

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveScript',
                script: script
            });

            this.setStatus(`Multi-file Script "${scriptName}" saved with ID: ${response.scriptId}`);
        } catch (err) {
            console.error('Failed to save multi-file script:', err);
            this.setStatus('Error saving multi-file script');
        }
    }

    async collectWorkspaceFiles() {
        const files = {};

        if (this.mode === 'workspace' && this.workspaceHandle) {
            await this.collectFromHandle(this.workspaceHandle, '', files);
        } else if (this.mode === 'git') {
            await this.collectFromGit(this.gitDir, '', files);
        }

        console.log('Collected files:', Object.keys(files));

        return files;
    }

    async collectFromHandle(dirHandle, basePath, files) {
        for await (const entry of dirHandle.values()) {
            const path = basePath ? `${basePath}/${entry.name}` : entry.name;

            if (entry.kind === 'file') {
                try {
                    const file = await entry.getFile();
                    const content = await file.text();
                    files[path] = content;
                    console.log(`Collected file: ${path} (${content.length} bytes)`);
                } catch (err) {
                    console.error(`Failed to read file ${path}:`, err);
                }
            } else if (entry.kind === 'directory') {
                await this.collectFromHandle(entry, path, files);
            }
        }
    }

    async collectFromGit(dirPath, basePath, files) {
        try {
            const entries = await this.fs.promises.readdir(dirPath);

            for (const name of entries) {
                if (name === '.git') continue;

                const fullPath = `${dirPath}/${name}`;
                const relativePath = basePath ? `${basePath}/${name}` : name;

                try {
                    const stat = await this.fs.promises.stat(fullPath);

                    if (stat.isDirectory()) {
                        await this.collectFromGit(fullPath, relativePath, files);
                    } else {
                        const content = await this.fs.promises.readFile(fullPath, 'utf8');
                        files[relativePath] = content;
                        console.log(`Collected file: ${relativePath} (${content.length} bytes)`);
                    }
                } catch (err) {
                    console.error(`Error processing ${fullPath}:`, err);
                }
            }
        } catch (err) {
            console.error('Error collecting git files:', err);
        }
    }

    async testMultiFile() {
        if (this.mode !== 'workspace' && this.mode !== 'git') {
            this.setStatus('Multi-file test requires a workspace');
            return;
        }

        this.setStatus('Collecting files for test...');

        const files = await this.collectWorkspaceFiles();
        const entryPoint = this.currentPath ?
            (this.mode === 'git' ? this.currentPath.replace(this.gitDir + '/', '') : this.currentPath) :
            'main.js';

        const testScript = {
            type: 'multi-file',
            name: 'Test Script',
            entryPoint: entryPoint,
            files: files,
            grant: ['GM_addStyle', 'GM_getValue', 'GM_setValue', 'GM_log']
        };

        try {
            const tab = await chrome.tabs.create({
                url: 'https://example.com',
                active: true
            });

            if (!tab?.id) {
                this.setStatus('Error: Could not create tab');
                return;
            }

            chrome.runtime.sendMessage({
                action: 'executeTestMultiFileScript',
                tabId: tab.id,
                script: testScript
            }, (response) => {
                if (response?.success) {
                    this.setStatus(`Multi-file test script injected into tab ${tab.id}`);
                } else {
                    this.setStatus(`Error injecting: ${response?.error || 'Unknown'}`);
                }
            });

        } catch (error) {
            console.error('Test error:', error);
            this.setStatus(`Error: ${error.message}`);
        }
    }

    // this uses the file system access api to write the content back to the local file
    async saveFile() {
        if (!this.fileHandle) return;
        try {
            const writable = await this.fileHandle.createWritable();
            await writable.write(this.editor.getValue());
            await writable.close();
            this.setStatus(`Script saved: ${this.currentPath}`, true, 'success');
            this.triggerSaveCounter();

            if (this.currentFile) {
                this.currentFile.full = this.editor.getValue();
            }

            if (this.script && this.scriptId) {
                const runAtSelect = document.getElementById('scriptRunAt');
                if (runAtSelect) {
                    this.script.runAt = runAtSelect.value;
                    await chrome.runtime.sendMessage({
                        action: 'saveScript',
                        script: this.script
                    });
                }
            }
        } catch (err) {
            console.error("Save failed:", err);
            this.setStatus(`Error saving file`, true, 'error');
        }
    }

    // this saves the file to the virtual git filesystem
    async saveVirtual() {
        if (!this.currentPath) {
            this.setStatus('No file selected');
            return;
        }

        try {
            await this.fs.promises.writeFile(this.currentPath, this.editor.getValue(), 'utf8');
            const path = this.currentPath.replace(this.gitDir + '/', '');
            this.setStatus(`Saved: ${path}`);
            this.logGit(`Saved: ${path}`);
            this.triggerSaveCounter();
            await this.refreshSourceControl();

            if (this.script && this.scriptId) {
                const runAtSelect = document.getElementById('scriptRunAt');
                if (runAtSelect) {
                    this.script.runAt = runAtSelect.value;
                    await chrome.runtime.sendMessage({
                        action: 'saveScript',
                        script: this.script
                    });
                }
            }
        } catch (err) {
            console.error("Save failed:", err);
            const path = this.currentPath.replace(this.gitDir + '/', '');
            this.setStatus(`Error saving ${path}: ${err.message}`);
            this.logGit(`Save failed: ${err.message}`);
        }
    }

    toggleExplorer(force) {
        const show = force !== undefined ? force : this.explorer.style.display === 'none';
        this.explorer.style.display = show ? 'block' : 'none';
        this.metadata.style.display = show ? 'none' : 'block';
        document.getElementById('explorerToggleBtn').classList.toggle('active', show);
    }

    async copyToFS(dir, fsPath, createRoot = true) {
        if (createRoot) {
            await this.gitFS.mkdir(fsPath, {
                recursive: true
            });
        }
        for await (const entry of dir.values()) {
            const newPath = `${fsPath}/${entry.name}`;
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                const content = await file.arrayBuffer();
                await this.gitFS.writeFile(newPath, new Uint8Array(content));
            } else if (entry.kind === 'directory') {
                await this.copyToFS(entry, newPath);
            }
        }
    }

    async deleteRecursive(path) {
        let stats;
        try {
            stats = await this.gitFS.stat(path);
        } catch (e) {
            return;
        }

        if (stats.isDirectory()) {
            const files = await this.gitFS.readdir(path);
            for (const file of files) {
                await this.deleteRecursive(`${path}/${file}`);
            }
            await this.gitFS.rmdir(path);
        } else {
            await this.gitFS.unlink(path);
        }
    }

    async pushMultiFileProject() {
        if (!this.script || !this.script.files) {
            this.setStatus('No project loaded');
            return;
        }

        if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
            this.script.files[this.currentPath] = this.editor.getValue();
        }

        const url = prompt('Enter GitHub repository URL (for backup):',
            this.script.gitBackup?.url || 'https://github.com/username/repo.git');
        if (!url) return;

        let branch = prompt('Enter branch name:',
            this.script.gitBackup?.branch || 'main');
        if (!branch) branch = 'main';

        this.gitModal.classList.add('visible');
        this.logGit('Creating GitHub backup of multi-file project...');
        const tempDir = '/temp_push';

        try {

            this.logGit('Preparing temporary workspace...');
            try {
                const entries = await this.gitFS.readdir(this.gitDir);
                for (const entry of entries) {
                    await this.deleteRecursive(`${this.gitDir}/${entry}`);
                }
            } catch (err) {
                if (err.code === 'ENOENT') {
                    await this.gitFS.mkdir(this.gitDir);
                } else {
                    throw err;
                }
            }

            this.logGit(`Writing ${Object.keys(this.script.files).length} files...`);
            for (const [path, content] of Object.entries(this.script.files)) {
                //const fullPath = `${this.gitDir}/${path}`;
                const fullPath = `${tempDir}/${path}`;
                const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));

                await this.gitFS.mkdir(dir, {
                    recursive: true
                }).catch(() => {});
                await this.gitFS.writeFile(fullPath, content, 'utf8');
            }
            this.logGit('Files prepared');

            this.logGit('Initializing Git repo...');
            /*await this.git.init({
                fs: this.fs,
                dir: this.gitDir
            });*/
            await this.git.init({
                fs: this.fs,
                dir: tempDir
            });

            this.logGit(`Adding remote: ${url}`);
            await this.git.addRemote({
                fs: this.fs,
                dir: this.gitDir,
                remote: 'origin',
                url
            });

            this.logGit('Staging files...');
            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: this.gitDir
            });

            await Promise.all(
                status.map(([path, ...statuses]) => {
                    if (statuses[1] === 2) {
                        return this.git.add({
                            fs: this.fs,
                            dir: this.gitDir,
                            filepath: path
                        });
                    }
                })
            );

            this.logGit('Creating commit...');
            const sha = await this.git.commit({
                fs: this.fs,
                dir: this.gitDir,
                message: `Initial Push From ScriptFlow: ${this.script.name}`,
                author: {
                    name: 'ScriptFlow Editor',
                    email: 'bot@scriptflow.app'
                },
            });
            this.logGit(`Committed: ${sha.substring(0, 7)}`);

            this.logGit(`Creating branch '${branch}'...`);
            await this.git.branch({
                fs: this.fs,
                dir: this.gitDir,
                ref: branch,
                checkout: true
            });

            this.logGit(`Pushing to origin/${branch}...`);
            const result = await this.git.push({
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                remote: 'origin',
                ref: branch,
                force: true,
                onAuth: () => this.getAuth(),
                //corsProxy: 'https://cors.isomorphic-git.org',
            });

            if (this.editorSettings.useCorsProxy) {
                result.corsProxy = 'https://cors.isomorphic-git.org';
            }

            if (!result?.ok) {
                throw new Error(`Push failed: ${result ? JSON.stringify(result.errors) : 'No response'}`);
            }

            this.logGit('Backup pushed successfully!');
            await this.updateRepoHistory(url);

            this.script.gitBackup = {
                url,
                branch,
                lastPush: Date.now(),
                lastCommit: sha.substring(0, 7)
            };

            await chrome.runtime.sendMessage({
                action: 'saveScript',
                script: this.script
            });

            this.setStatus(`Project backed up to ${url}`, true, 'success');
            this.gitModal.classList.remove('visible');

        } catch (err) {
            this.logGit(`ERROR: ${err.message}`);
            console.error(err);
            this.setStatus('Backup failed', true, 'error');
        }
    }

    // this takes a local workspace and pushes it to a new github repo
    // new note: this doesnt look like its needed anymore so im removing it
    /*async pushNew() {
        if (this.mode !== 'workspace' || !this.workspaceHandle) {
            this.logGit("ERROR: A workspace must be loaded first");
            return;
        }

        const url = document.getElementById('repoUrl').value;
        let branch = document.getElementById('branch').value.trim();
        if (!branch) branch = 'main';

        if (!url) {
            this.logGit('ERROR: Repository URL required');
            return;
        }

        this.logGit('Pushing local workspace...');

        try {
            let repoExists = false;
            try {
                await this.gitFS.stat(`${this.gitDir}/.git`);
                repoExists = true;
                this.logGit('Existing repo found, syncing...');
            } catch (err) {
                this.logGit('Initializing new repo...');
            }

            if (!repoExists) {
                this.logGit(`Clearing virtual workspace...`);
                try {
                    const entries = await this.gitFS.readdir(this.gitDir);
                    for (const entry of entries) {
                        await this.deleteRecursive(`${this.gitDir}/${entry}`);
                    }
                    this.logGit('Workspace cleared');
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        await this.gitFS.mkdir(this.gitDir);
                    } else {
                        throw err;
                    }
                }

                this.logGit('Initializing Git repo...');
                await this.git.init({
                    fs: this.fs,
                    dir: this.gitDir
                });

                this.logGit(`Adding remote: ${url}`);
                await this.git.addRemote({
                    fs: this.fs,
                    dir: this.gitDir,
                    remote: 'origin',
                    url
                });
            } else {
                this.logGit('Fetching remote changes...');
                try {
                    await this.git.fetch({
                        fs: this.fs,
                        http: this.http,
                        dir: this.gitDir,
                        onAuth: () => this.getAuth(),
                        ref: branch,
                        singleBranch: true
                    });

                    this.logGit('Merging remote changes...');
                    await this.git.merge({
                        fs: this.fs,
                        dir: this.gitDir,
                        ours: branch,
                        theirs: `origin/${branch}`,
                        author: {
                            name: 'ScriptFlow Editor',
                            email: 'bot@scriptflow.app'
                        }
                    });
                    this.logGit('Remote changes merged');
                } catch (fetchErr) {
                    this.logGit(`Fetch note: ${fetchErr.message}`);
                }

                this.logGit('Clearing working directory...');
                const entries = await this.gitFS.readdir(this.gitDir);
                for (const entry of entries) {
                    if (entry !== '.git') {
                        await this.deleteRecursive(`${this.gitDir}/${entry}`);
                    }
                }
                this.logGit('Working directory cleared');
            }

            this.logGit(`Copying files from "${this.workspaceHandle.name}"...`);
            await this.copyToFS(this.workspaceHandle, this.gitDir, false);
            this.logGit('Files copied');

            this.logGit('Staging files...');
            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: this.gitDir
            });
            
            let hasChanges = false;
            for (const [path, ...statuses] of status) {
                const headStatus = statuses[0];
                const workdirStatus = statuses[1];
                
                if (workdirStatus === 0 && headStatus !== 0) {
                    await this.git.remove({
                        fs: this.fs,
                        dir: this.gitDir,
                        filepath: path
                    });
                    this.logGit(` - Staged deletion: ${path}`);
                    hasChanges = true;
                } else if (workdirStatus === 2) {
                    await this.git.add({
                        fs: this.fs,
                        dir: this.gitDir,
                        filepath: path
                    });
                    hasChanges = true;
                }
            }

            if (!hasChanges && repoExists) {
                this.logGit('No changes to commit');
                this.gitModal.classList.remove('visible');
                return;
            }

            this.logGit('Creating commit...');
            const sha = await this.git.commit({
                fs: this.fs,
                dir: this.gitDir,
                message: repoExists ? `Update from ScriptFlow` : 'Initial commit from ScriptFlow',
                author: {
                    name: 'ScriptFlow Editor',
                    email: 'bot@scriptflow.app'
                },
            });
            this.logGit(`Committed: ${sha.substring(0, 7)}`);

            if (!repoExists) {
                this.logGit(`Creating branch '${branch}'...`);
                try {
                    await this.git.branch({
                        fs: this.fs,
                        dir: this.gitDir,
                        ref: branch,
                        checkout: true
                    });
                } catch (e) {
                    // branch might already exist
                }
            }

            this.logGit(`Pushing to origin/${branch}...`);
            const result = await this.git.push({
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                remote: 'origin',
                ref: branch,
                force: false,
                onAuth: () => this.getAuth(),
            });

            if (this.editorSettings.useCorsProxy) {
                result.corsProxy = 'https://cors.isomorphic-git.org';
            }

            if (!result?.ok) {
                throw new Error(`Push failed: ${result ? JSON.stringify(result.errors) : 'No response'}`);
            }

            this.logGit('Push successful!');
            this.saveCounter = 0;
            await this.updateRepoHistory(url);

            await this.idb.set('settings', 'gitWorkspace', {
                url,
                branch
            });
            this.mode = 'git';
            this.setStatus(`Pushed to ${url}`);
            this.gitModal.classList.remove('visible');
            await this.buildGitTree();

        } catch (err) {
            this.logGit(`ERROR: ${err.message}`);
            console.error(err);
        }
    }*/

    // handles renaming for both git and local files
    async rename() {
        const expandedPaths = this.getExpandedPaths();
        const menu = document.getElementById('fileContextMenu');
        const oldPath = menu.dataset.path;
        const oldName = menu.dataset.name;
        if (!oldPath) return;

        const newName = prompt("Enter new name:", oldName);
        if (!newName || !newName.trim() || newName === oldName) return;

        if (this.mode === 'git') {
            const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
            const newPath = `${parentDir}/${newName.trim()}`;
            try {
                await this.fs.promises.rename(oldPath, newPath);
                this.logGit(`Renamed: ${oldPath} -> ${newPath}`);
                await this.buildGitTree();
                await this.restoreExpandedPaths(expandedPaths);
            } catch (err) {
                this.logGit(`Error renaming: ${err.message}`);
                alert(`Error renaming: ${err.message}`);
            }
        } else if (this.mode === 'workspace') {
            try {
                const newPath = await this.renameLocalItem(oldPath, newName);
                if (this.currentPath === oldPath) {
                    this.currentPath = newPath;
                    this.fileHandle = await this.getHandleFromPath(newPath, true);
                }
                await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);
            } catch (err) {
                this.setStatus(`Error renaming: ${err.message}`);
            }
        } else if (this.mode === 'multi-file-edit') {
            try {
                if (this.script && this.script.files) {
                    const kind = menu.dataset.kind;
                    const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
                    const newPath = parentDir ? `${parentDir}/${newName.trim()}` : newName.trim();

                    if (kind === 'file') {
                        const content = this.script.files[oldPath];
                        delete this.script.files[oldPath];
                        this.script.files[newPath] = content;

                        if (this.currentPath === oldPath) {
                            this.currentPath = newPath;
                        }
                    } else if (kind === 'directory') {
                        const oldPrefix = oldPath + '/';
                        const newPrefix = newPath + '/';
                        const filesToRename = {};

                        Object.keys(this.script.files).forEach(filePath => {
                            if (filePath.startsWith(oldPrefix)) {
                                const relativePath = filePath.substring(oldPrefix.length);
                                filesToRename[filePath] = newPrefix + relativePath;
                            }
                        });

                        Object.entries(filesToRename).forEach(([oldFilePath, newFilePath]) => {
                            this.script.files[newFilePath] = this.script.files[oldFilePath];
                            delete this.script.files[oldFilePath];
                        });

                        if (this.currentPath?.startsWith(oldPrefix)) {
                            const relativePath = this.currentPath.substring(oldPrefix.length);
                            this.currentPath = newPrefix + relativePath;
                        }
                    }

                    this.buildTreeFromObject(this.script.files, expandedPaths);
                    this.setStatus(`Renamed: ${oldName} -> ${newName}`);
                }
            } catch (err) {
                this.setStatus(`Error renaming: ${err.message}`);
            }
        }
    }

    // handles deleting for both git and local files
    async delete() {
        const expandedPaths = this.getExpandedPaths();
        const menu = document.getElementById('fileContextMenu');
        const path = menu.dataset.path;
        const name = menu.dataset.name;
        const kind = menu.dataset.kind;
        if (!path) return;

        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

        if (this.mode === 'multi-file-edit') {
            try {
                if (this.script && this.script.files) {
                    if (kind === 'file') {
                        delete this.script.files[path];
                    } else if (kind === 'directory') {
                        const folderPrefix = path + '/';
                        Object.keys(this.script.files).forEach(filePath => {
                            if (filePath.startsWith(folderPrefix)) {
                                delete this.script.files[filePath];
                            }
                        });
                    }

                    if (this.currentPath === path || (kind === 'directory' && this.currentPath?.startsWith(path + '/'))) {
                        this.editor.setValue("/* File deleted. Select another file. */");
                        this.editor.updateOptions({
                            readOnly: true
                        });
                        this.currentPath = null;
                    }

                    this.buildTreeFromObject(this.script.files || {}, expandedPaths);
                    this.setStatus(`Deleted: ${path}`);
                }
            } catch (err) {
                this.setStatus(`Error deleting: ${err.message}`);
            }
            return;
        }

        if (this.mode === 'git') {
            try {
                if (kind === 'file') {
                    await this.fs.promises.unlink(path);
                } else if (kind === 'directory') {
                    await this.deleteRecursive(path);
                }
                this.logGit(`Deleted: ${path}`);
                if (this.currentPath === path) {
                    this.editor.setValue("/* File deleted. Select another file. */");
                    this.editor.updateOptions({
                        readOnly: true
                    });
                    this.currentPath = null;
                }
                await this.buildGitTree();
                await this.restoreExpandedPaths(expandedPaths);
            } catch (err) {
                this.logGit(`Error deleting: ${err.message}`);
                alert(`Error deleting: ${err.message}`);
            }
        } else if (this.mode === 'workspace') {
            try {
                await this.deleteLocalItem(path);
                if (this.currentPath === path) {
                    this.editor.setValue("/* File deleted. Select another file. */");
                    this.editor.updateOptions({
                        readOnly: true
                    });
                    this.currentPath = null;
                    this.fileHandle = null;
                }
                await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);
            } catch (err) {
                this.setStatus(`Error deleting: ${err.message}`);
            }
        }
    }

    switchSidebarTab(tabName) {
        document.querySelectorAll('.sidebar-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        const filesContent = document.querySelector('.tab-content[data-tab-content="files"]');
        const scContent = document.querySelector('.tab-content[data-tab-content="source-control"]');

        if (tabName === 'files') {
            if (filesContent) filesContent.style.display = 'block';
            if (scContent) scContent.style.display = 'none';
        } else if (tabName === 'source-control') {
            if (filesContent) filesContent.style.display = 'none';
            if (scContent) scContent.style.display = 'block';

            const repoUrl = document.getElementById('repoUrl')?.value?.trim();
            const hasRepoUrl = repoUrl && repoUrl.startsWith('https');

            if (this.mode === 'git' || this.mode === 'multi-file-edit' && this.script?.githubRepo?.url || this.mode === 'workspace' && hasRepoUrl) {
                this.refreshSourceControl();
            }
        }
    }

    setupBackgroundCustomization() {
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('hiddenFileInput');
        const previewContainer = document.getElementById('imagePreview');
        const previewImg = document.getElementById('previewImg');
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        const blurSlider = document.getElementById('blurSlider');
        const blurValue = document.getElementById('blurValue');
        const bgSizeSelect = document.getElementById('bgSizeSelect');
        const bgPositionSelect = document.getElementById('bgPositionSelect');
        const enableCheckbox = document.getElementById('enableBgCheckbox');

        this.bgSettings = {
            enabled: true,
            imageData: null,
            opacity: 30,
            blur: 0,
            size: 'cover',
            position: 'center'
        };

        if (!uploadArea || !fileInput) return;

        uploadArea.addEventListener('click', () => {
            fileInput.click();
        });

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = 'var(--accent)';
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.style.borderColor = '';
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = '';
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                this.handleBgImageUpload(file);
            }
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.handleBgImageUpload(file);
            }
        });

        if (opacitySlider) {
            opacitySlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (opacityValue) opacityValue.textContent = value;
                this.bgSettings.opacity = value;
                this.applyCustomBackground();
                this.saveCustomBackground();
            });
        }

        if (blurSlider) {
            blurSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (blurValue) blurValue.textContent = `${value}px`;
                this.bgSettings.blur = value;
                this.applyCustomBackground();
                this.saveCustomBackground();
            });
        }

        if (bgSizeSelect) {
            bgSizeSelect.addEventListener('change', (e) => {
                this.bgSettings.size = e.target.value;
                this.applyCustomBackground();
                this.saveCustomBackground();
            });
        }

        if (bgPositionSelect) {
            bgPositionSelect.addEventListener('change', (e) => {
                this.bgSettings.position = e.target.value;
                this.applyCustomBackground();
                this.saveCustomBackground();
            });
        }

        if (enableCheckbox) {
            enableCheckbox.addEventListener('change', (e) => {
                this.bgSettings.enabled = e.target.checked;
                this.applyCustomBackground();
                this.saveCustomBackground();
                this.setStatus(
                    e.target.checked ? 'Background enabled' : 'Background disabled',
                    true,
                    'info'
                );
            });
        }
    }

    handleBgImageUpload(file) {
        if (file.size > 10 * 1024 * 1024) {
            alert('File too large! Please choose an image under 10MB.');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            this.bgSettings.imageData = e.target.result;

            const previewImg = document.getElementById('previewImg');
            const previewContainer = document.getElementById('imagePreview');
            const uploadArea = document.getElementById('uploadArea');

            if (previewImg) previewImg.src = e.target.result;
            if (previewContainer) previewContainer.style.display = 'block';
            if (uploadArea) uploadArea.style.borderColor = 'var(--accent-2)';

            this.applyCustomBackground();
            this.saveCustomBackground();
            this.setStatus('Background image uploaded!', true, 'success');
        };
        reader.readAsDataURL(file);
    }

    applyCustomBackground() {
        if (!this.bgSettings) return;

        let bgLayer = document.getElementById('customBackgroundLayer');
        if (!bgLayer) {
            bgLayer = document.createElement('div');
            bgLayer.id = 'customBackgroundLayer';
            bgLayer.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: -1;
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
                transition: opacity 0.3s ease;
                pointer-events: none;
            `;
            document.body.insertBefore(bgLayer, document.body.firstChild);
        }

        if (this.bgSettings.enabled && this.bgSettings.imageData) {
            bgLayer.style.backgroundImage = `url(${this.bgSettings.imageData})`;
            bgLayer.style.backgroundSize = this.bgSettings.size;
            bgLayer.style.backgroundPosition = this.bgSettings.position;
            bgLayer.style.opacity = this.bgSettings.opacity / 100;
            bgLayer.style.filter = `blur(${this.bgSettings.blur}px)`;
            bgLayer.classList.add('active');
        } else {
            bgLayer.classList.remove('active');
            bgLayer.style.opacity = '0';
        }
    }

    openCustomizeModal() {
        const modal = document.getElementById('customizeModal');
        if (!modal) return;

        this.loadCustomBackground();

        modal.classList.add('visible');

        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        const blurSlider = document.getElementById('blurSlider');
        const blurValue = document.getElementById('blurValue');
        const bgSizeSelect = document.getElementById('bgSizeSelect');
        const bgPositionSelect = document.getElementById('bgPositionSelect');
        const enableCheckbox = document.getElementById('enableBgCheckbox');

        if (opacitySlider) opacitySlider.value = this.bgSettings.opacity;
        if (opacityValue) opacityValue.textContent = this.bgSettings.opacity;
        if (blurSlider) blurSlider.value = this.bgSettings.blur;
        if (blurValue) blurValue.textContent = `${this.bgSettings.blur}px`;
        if (bgSizeSelect) bgSizeSelect.value = this.bgSettings.size;
        if (bgPositionSelect) bgPositionSelect.value = this.bgSettings.position;
        if (enableCheckbox) enableCheckbox.checked = this.bgSettings.enabled;
    }

    saveCustomBackground() {
        localStorage.setItem('sf-custombackground', JSON.stringify(this.bgSettings));
        console.log('Background settings saved:', this.bgSettings);
    }

    loadCustomBackground() {
        if (!this.bgSettings) {
            this.bgSettings = {
                enabled: true,
                imageData: null,
                opacity: 30,
                blur: 0,
                size: 'cover',
                position: 'center'
            };
        }

        const saved = localStorage.getItem('sf-custombackground');
        if (saved) {
            try {
                const savedSettings = JSON.parse(saved);
                this.bgSettings = {
                    ...this.bgSettings,
                    ...savedSettings
                };

                console.log('Background settings loaded:', this.bgSettings);

                const opacitySlider = document.getElementById('opacitySlider');
                const opacityValue = document.getElementById('opacityValue');
                const blurSlider = document.getElementById('blurSlider');
                const blurValue = document.getElementById('blurValue');
                const bgSizeSelect = document.getElementById('bgSizeSelect');
                const bgPositionSelect = document.getElementById('bgPositionSelect');
                const enableCheckbox = document.getElementById('enableBgCheckbox');
                const previewImg = document.getElementById('previewImg');
                const previewContainer = document.getElementById('imagePreview');

                if (opacitySlider) opacitySlider.value = this.bgSettings.opacity;
                if (opacityValue) opacityValue.textContent = this.bgSettings.opacity;
                if (blurSlider) blurSlider.value = this.bgSettings.blur;
                if (blurValue) blurValue.textContent = `${this.bgSettings.blur}px`;
                if (bgSizeSelect) bgSizeSelect.value = this.bgSettings.size;
                if (bgPositionSelect) bgPositionSelect.value = this.bgSettings.position;
                if (enableCheckbox) enableCheckbox.checked = this.bgSettings.enabled;

                if (this.bgSettings.imageData) {
                    if (previewImg) previewImg.src = this.bgSettings.imageData;
                    if (previewContainer) previewContainer.style.display = 'block';
                }
            } catch (e) {
                console.error('Failed to load background settings:', e);
            }
        }
    }

    removeCustomBackground() {
        this.bgSettings.imageData = null;
        this.bgSettings.enabled = false;

        const previewContainer = document.getElementById('imagePreview');
        const uploadArea = document.getElementById('uploadArea');
        const enableCheckbox = document.getElementById('enableBgCheckbox');

        if (previewContainer) previewContainer.style.display = 'none';
        if (uploadArea) uploadArea.style.borderColor = '';
        if (enableCheckbox) enableCheckbox.checked = false;

        this.applyCustomBackground();
        this.saveCustomBackground();
        this.setStatus('Background removed', true, 'info');
    }

    setupEvents() {

        document.getElementById('customizeBtn')?.addEventListener('click', () => {
            this.openCustomizeModal();
        });

        document.getElementById('customizeModalCloseBtn')?.addEventListener('click', () => {
            document.getElementById('customizeModal').classList.remove('visible');
        });

        this.setupBackgroundCustomization();

        document.getElementById('settingsBtn')?.addEventListener('click', () => {
            this.openEditorSettings();
        });

        document.getElementById('settingsModalCloseBtn')?.addEventListener('click', () => {
            document.getElementById('settingsModal').classList.remove('visible');
        });

        document.getElementById('saveSettingsBtn')?.addEventListener('click', () => {
            this.saveEditorSettings();
        });

        document.getElementById('cancelSettingsBtn')?.addEventListener('click', () => {
            document.getElementById('settingsModal').classList.remove('visible');
        });

        document.querySelectorAll('.sidebar-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchSidebarTab(tabName);
            });
        });
        document.getElementById('loadWorkspaceBtn').addEventListener('click', async () => {
            try {
                const handle = await window.showDirectoryPicker();
                await this.initWorkspace(handle);
            } catch (err) {
                if (err.name !== 'AbortError') console.error('Error selecting workspace:', err);
            }
        });

        document.getElementById('newFileBtn').addEventListener('click', () => {
            if (this.mode !== 'workspace' && this.mode !== 'git' && this.mode !== 'multi-file-edit') {
                this.showNotification({
                    title: 'No Project Open',
                    message: 'Would you like to create a new multi-file project first?',
                    type: 'info',
                    duration: 0,
                    buttons: [{
                            text: 'No, Just New File',
                            class: 'secondary',
                            callback: () => {
                                this.loadTemplate('basic');
                                this.setStatus('Created new single-file script');
                            }
                        },
                        {
                            text: 'Yes, Create Project',
                            class: 'primary',
                            callback: () => this.createEmptyMultiFileProject()
                        }
                    ]
                });
                return;
            }
            this.newFile();
        });

        document.getElementById('newFolderBtn').addEventListener('click', () => {
            if (this.mode !== 'workspace' && this.mode !== 'git' && this.mode !== 'multi-file-edit') {
                this.showNotification({
                    title: 'No Project Open',
                    message: 'Would you like to create a new multi-file project first?',
                    type: 'info',
                    duration: 0,
                    buttons: [{
                            text: 'Cancel',
                            class: 'secondary',
                            callback: () => {}
                        },
                        {
                            text: 'Yes, Create Project',
                            class: 'primary',
                            callback: () => this.createEmptyMultiFileProject()
                        }
                    ]
                });
                return;
            }
            this.newFolder();
        });
        document.getElementById('gitSyncBtn').addEventListener('click', () => {
            this.gitModal.classList.add('visible');

            if (this.mode === 'multi-file-edit' && this.script?.githubRepo) {
                document.getElementById('repoUrl').value = this.script.githubRepo.url || '';
                document.getElementById('branch').value = this.script.githubRepo.branch || 'main';
            }
        });
        document.getElementById('gitModalCloseBtn')?.addEventListener('click', () => {
            document.getElementById('gitModal').classList.remove('visible');

            if (this.mode === 'workspace') {
                const repoUrl = document.getElementById('repoUrl')?.value?.trim();
                if (repoUrl && repoUrl.startsWith('https')) {
                    const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                    if (scTab) {
                        scTab.style.display = 'block';
                    }
                }
            }
        });
        document.getElementById('gitCloneBtn').addEventListener('click', () => this.clone());
        document.getElementById('gitPullBtn').addEventListener('click', () => {
            if (this.mode === 'multi-file-edit') {
                this.pullMultiFile();
            } else {
                this.pull();
            }
        });
        document.getElementById('gitPushBtn').addEventListener('click', () => {
            if (this.mode === 'multi-file-edit') {
                this.pushMultiFile();
            } else {
                this.push();
            }
        });
        document.getElementById('pullMultiFileBtn')?.addEventListener('click', () => this.pullMultiFile());
        document.getElementById('pushMultiFileBtn')?.addEventListener('click', () => this.pushMultiFile());
        document.getElementById('configureGithubBtn')?.addEventListener('click', () => {
            if (this.mode === 'multi-file-edit') {
                const url = document.getElementById('repoUrl').value.trim();
                const branch = document.getElementById('branch').value.trim() || 'main';

                if (!url) {
                    this.setStatus('GitHub URL required');
                    return;
                }

                this.script.githubRepo = {
                    url,
                    branch
                };

                chrome.runtime.sendMessage({
                    action: 'saveScript',
                    script: this.script
                }).then(() => {
                    this.setStatus('GitHub repository configured', true, 'success');
                    this.gitModal.classList.remove('visible');

                    const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
                    if (scTab) scTab.style.display = 'block';

                    this.updateMultiFileButtons();
                    this.refreshSourceControl();
                });
            }
        });
        document.getElementById('saveMultiFileBtn')?.addEventListener('click', () => this.saveAsMultiFileScript());

        document.getElementById('explorerToggleBtn').addEventListener('click', () => this.toggleExplorer());
        document.getElementById('addMatchBtn').addEventListener('click', () => this.addMatch());

        document.querySelectorAll('[data-template]').forEach(btn => {
            btn.addEventListener('click', (e) => this.loadTemplate(e.target.dataset.template));
        });

        const scriptRunAtSelect = document.getElementById('scriptRunAt');
        if (scriptRunAtSelect) {
            scriptRunAtSelect.addEventListener('change', () => {

                this.editorSettings.runAt = scriptRunAtSelect.value;
                localStorage.setItem('sf_editor_runAt', scriptRunAtSelect.value);

                const settingRunAt = document.getElementById('setting_runAt');
                if (settingRunAt) {
                    settingRunAt.value = scriptRunAtSelect.value;
                }

                if (this.script && this.scriptId) {
                    this.setStatus('Run At changed - save to apply', false);
                }
            });
        }

        const tree = document.getElementById('fileTree');
        const menu = document.getElementById('fileContextMenu');

        tree.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.tree-item');
            if (!item) return;

            e.preventDefault();
            menu.style.display = 'block';
            menu.style.left = `${e.clientX}px`;
            menu.style.top = `${e.clientY}px`;

            const path = item.dataset.path;
            const kind = item.dataset.kind;
            menu.dataset.path = path;
            menu.dataset.kind = kind;
            menu.dataset.name = item.querySelector('.name').textContent;

            const previewBtn = document.getElementById('previewContextBtn');
            const setEntryBtn = document.getElementById('setEntryBtn');
            const unsetEntryBtn = document.getElementById('unsetEntryBtn');

            const isHtml = path && (path.toLowerCase().endsWith('.html') || path.toLowerCase().endsWith('.htm'));
            const isFile = kind === 'file';
            const isEntry = this.projectEntryPoint === path;

            previewBtn.style.display = isHtml ? 'flex' : 'none';
            setEntryBtn.style.display = isFile && !isEntry ? 'flex' : 'none';
            unsetEntryBtn.style.display = isFile && isEntry ? 'flex' : 'none';

            const divider = document.getElementById('entryPointDivider');
            if (divider) {
                divider.style.display = (isHtml || isFile) ? 'block' : 'none';
            }
        });

        document.addEventListener('click', () => {
            menu.style.display = 'none';
        });

        document.getElementById('previewContextBtn').addEventListener('click', () => this.previewFromContext());
        document.getElementById('setEntryBtn').addEventListener('click', () => {
            const menu = document.getElementById('fileContextMenu');
            const path = menu.dataset.path;
            if (path) {
                this.projectEntryPoint = path;
                this.updateFileTreeHighlights();
                this.setStatus(`Entry point set: ${path.split('/').pop()}`, true, 'success');
            }
        });
        document.getElementById('unsetEntryBtn').addEventListener('click', () => {
            const menu = document.getElementById('fileContextMenu');
            const path = menu.dataset.path;
            if (path) {
                this.projectEntryPoint = null;
                this.updateFileTreeHighlights();
                this.setStatus(`Entry point unset: ${path.split('/').pop()}`, true, 'info');
            }
        });
        document.getElementById('renameBtn').addEventListener('click', () => this.rename());
        document.getElementById('deleteBtn').addEventListener('click', () => this.delete());
        document.getElementById('newFileContextBtn').addEventListener('click', () => this.newFileFromContext());
        document.getElementById('newImageContextBtn').addEventListener('click', () => this.newImageFromContext());
        document.getElementById('newFolderContextBtn').addEventListener('click', () => this.newFolderFromContext());

        if (tree) {
            tree.addEventListener('dragstart', (e) => this.handleDragStart(e));
            tree.addEventListener('dragover', (e) => this.handleDragOver(e));
            tree.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            tree.addEventListener('drop', (e) => this.handleDrop(e));
            tree.addEventListener('dragend', (e) => this.handleDragEnd(e));
        }

        document.getElementById('saveBtn').addEventListener('click', () => this.save());
        document.getElementById('formatBtn').addEventListener('click', () => this.format());
        document.getElementById('exportZipBtn').addEventListener('click', () => this.exportZip());

        this.commandPalette.input.addEventListener('input', () => this.filterCommands());
        this.commandPalette.input.addEventListener('keydown', (e) => this.handlePaletteKeydown(e));
        this.commandPalette.overlay.addEventListener('click', (e) => {
            if (e.target === this.commandPalette.overlay) {
                this.closeCommandPalette();
            }
        });
        this.commandPalette.list.addEventListener('click', (e) => {
            const item = e.target.closest('.command-item');
            if (item) {
                this.executeCommand(item.dataset.id);
            }
        });
    }

    handleDragStart(e) {
        const source = e.target.closest('.tree-item');
        if (!source) return;

        e.dataTransfer.setData('sourcePath', source.dataset.path);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => source.classList.add('dragging'), 0);
    }

    handleDragOver(e) {
        e.preventDefault();
        const target = e.target.closest('.tree-item.is-folder');
        if (target && !target.classList.contains('drag-over-folder')) {
            const current = document.querySelector('.drag-over-folder');
            if (current) current.classList.remove('drag-over-folder');
            target.classList.add('drag-over-folder');
        }
    }

    handleDragLeave(e) {
        const target = e.target.closest('.tree-item.is-folder');
        if (target) {
            target.classList.remove('drag-over-folder');
        }
    }

    handleDragEnd() {
        const dragged = document.querySelector('.dragging');
        if (dragged) dragged.classList.remove('dragging');
    }

    // this figures out what was dropped onto what and calls the move function
    async handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        const current = document.querySelector('.drag-over-folder');
        if (current) current.classList.remove('drag-over-folder');

        const sourcePath = e.dataTransfer.getData('sourcePath');
        const targetElement = e.target.closest('.tree-item.is-folder');

        if (!sourcePath || !targetElement) return;
        const targetPath = targetElement.dataset.path;

        if (sourcePath === targetPath || sourcePath.substring(0, sourcePath.lastIndexOf('/')) === targetPath) {
            return;
        }

        if (this.mode === 'git') {
            const sourceName = sourcePath.split('/').pop();
            const newPath = `${targetPath}/${sourceName}`;
            await this.moveItem(sourcePath, newPath);
        } else if (this.mode === 'workspace') {
            await this.moveLocalItem(sourcePath, targetPath);
        }
    }

    async newLocalFile(targetDirHandle, newName) {
        if (!newName || !newName.trim()) return;
        const newFileHandle = await targetDirHandle.getFileHandle(newName, {
            create: true
        });
        return newFileHandle;
    }

    async renameLocalItem(path, newName) {
        if (!newName || !newName.trim()) return;

        const {
            parent: parentHandle,
            name: oldName
        } = await this.getParentHandleAndName(path);
        const sourceHandle = await (async () => {
            try {
                return await parentHandle.getDirectoryHandle(oldName);
            } catch (e) {
                return await parentHandle.getFileHandle(oldName);
            }
        })();

        const newPath = path.substring(0, path.lastIndexOf('/') + 1) + newName;

        if (sourceHandle.kind === 'file') {
            await this.moveLocalFile(sourceHandle, parentHandle, parentHandle, newName);
        } else {
            await this.moveLocalDirectory(sourceHandle, parentHandle, parentHandle, newName);
        }

        return newPath;
    }

    async deleteLocalItem(path) {
        const {
            parent: parentHandle,
            name
        } = await this.getParentHandleAndName(path);
        if (!parentHandle) throw new Error("Could not find parent directory.");
        await parentHandle.removeEntry(name, {
            recursive: true
        });
    }

    async newLocalFolder(targetDirHandle, newName) {
        if (!newName || !newName.trim()) return;
        const newFolderHandle = await targetDirHandle.getDirectoryHandle(newName, {
            create: true
        });
        return newFolderHandle;
    }

    // moves a file in the virtual git fs
    async moveItem(oldPath, newPath) {
        try {
            await this.fs.promises.rename(oldPath, newPath);
            this.logGit(`Moved: ${oldPath.replace(this.gitDir, '')} -> ${newPath.replace(this.gitDir, '')}`);
            await this.buildGitTree();
        } catch (err) {
            this.logGit(`Error moving item: ${err.message}`);
            alert(`Error moving item: ${err.message}`);
        }
    }

    // moves a local file or folder using the file system api
    async moveLocalItem(sourcePath, targetFolderPath) {
        const expandedPaths = this.getExpandedPaths();
        this.setStatus(`Moving ${sourcePath}...`);
        try {
            const {
                parent: sourceParentHandle,
                name: sourceName
            } = await this.getParentHandleAndName(sourcePath);
            const targetDirHandle = await this.getHandleFromPath(targetFolderPath);

            if (!sourceParentHandle || !targetDirHandle) {
                throw new Error("Could not find source or destination.");
            }

            const sourceHandle = await (async () => {
                try {
                    return await sourceParentHandle.getDirectoryHandle(sourceName);
                } catch (e) {
                    return await sourceParentHandle.getFileHandle(sourceName);
                }
            })();

            const newPath = `${targetFolderPath}/${sourceName}`;
            let newHandle = null;

            if (sourceHandle.kind === 'file') {
                newHandle = await this.moveLocalFile(sourceHandle, targetDirHandle, sourceParentHandle);
            } else if (sourceHandle.kind === 'directory') {
                newHandle = await this.moveLocalDirectory(sourceHandle, targetDirHandle, sourceParentHandle);
            }

            if (this.currentPath === sourcePath) {
                this.fileHandle = newHandle;
                this.currentPath = newPath;
                this.setStatus(`Moved and updated current file to ${newPath}`);
            } else {
                this.setStatus(`Moved ${sourceName} to ${targetFolderPath}`);
            }

            await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);

        } catch (err) {
            this.setStatus(`Error moving: ${err.message}`);
            console.error(err);
        }
    }

    async moveLocalFile(sourceFileHandle, targetDirHandle, sourceParentHandle, newName = null) {
        const file = await sourceFileHandle.getFile();
        const name = newName || file.name;
        const newFileHandle = await targetDirHandle.getFileHandle(name, {
            create: true
        });
        const writable = await newFileHandle.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
        await sourceParentHandle.removeEntry(file.name);
        return newFileHandle;
    }

    async moveLocalDirectory(sourceDirHandle, targetDirHandle, sourceParentHandle, newName = null) {
        const name = newName || sourceDirHandle.name;
        const newDirHandle = await targetDirHandle.getDirectoryHandle(name, {
            create: true
        });
        for await (const entry of sourceDirHandle.values()) {
            if (entry.kind === 'file') {
                await this.moveLocalFile(entry, newDirHandle, sourceDirHandle);
            } else if (entry.kind === 'directory') {
                await this.moveLocalDirectory(entry, newDirHandle, sourceDirHandle);
            }
        }
        await sourceParentHandle.removeEntry(sourceDirHandle.name);
        return newDirHandle;
    }

    async getHandleFromPath(path) {
        if (!path) return this.workspaceHandle;
        const parts = path.split('/');
        let current = this.workspaceHandle;
        for (const part of parts) {
            current = await current.getDirectoryHandle(part);
        }
        return current;
    }

    async getParentHandleAndName(path) {
        const parts = path.split('/');
        const name = parts.pop();
        const parentPath = parts.join('/');
        const parent = await this.getHandleFromPath(parentPath);
        return {
            parent,
            name
        };
    }

    getTargetDirFromContext() {
        const menu = document.getElementById('fileContextMenu');
        const path = menu.dataset.path;
        const kind = menu.dataset.kind;

        if (!path) return '';

        return kind === 'directory' ? path : path.substring(0, path.lastIndexOf('/'));
    }

    newFileFromContext() {
        const baseDir = this.getTargetDirFromContext();
        this.newFile(baseDir);
    }

    newImageFromContext() {
        const baseDir = this.getTargetDirFromContext();
        this.newImage(baseDir);
    }

    newFolderFromContext() {
        const baseDir = this.getTargetDirFromContext();
        this.newFolder(baseDir);
    }

    getExpandedPaths() {
        const expanded = new Set();
        document.querySelectorAll('#fileTree .tree-item.is-folder[data-state="expanded"]').forEach(item => {
            expanded.add(item.dataset.path);
        });
        return expanded;
    }

    async restoreExpandedPaths(expandedPaths) {
        if (!expandedPaths || expandedPaths.size === 0) return;

        await new Promise(resolve => setTimeout(resolve, 50));

        expandedPaths.forEach(path => {
            const item = document.querySelector(`#fileTree .tree-item[data-path="${path}"]`);
            if (item && item.classList.contains('is-folder')) {
                item.setAttribute('data-state', 'expanded');

                const nested = item.parentElement.querySelector('.nested-tree');
                if (nested && nested.children.length === 0 && this.mode === 'workspace') {
                    item.click();
                }
            }
        });
    }

    async newFile(baseDir = null) {
        const expandedPaths = this.getExpandedPaths();

        if (this.mode === 'git') {
            const dir = baseDir || this.getBasePath();
            const name = prompt(`Enter new file name in:\n${dir.replace(this.gitDir, '') || '/'}`);
            if (!name?.trim()) return;
            const fullPath = `${dir}/${name.trim()}`;
            try {
                await this.fs.promises.writeFile(fullPath, '', 'utf8');
                this.logGit(`Created file: ${fullPath}`);
                await this.buildGitTree();
                await this.restoreExpandedPaths(expandedPaths);
            } catch (err) {
                this.logGit(`Error creating file: ${err.message}`);
                alert(`Error: ${err.message}`);
            }
        } else if (this.mode === 'workspace') {
            const dirPath = baseDir || '';
            const name = prompt(`Enter new file name in:\n${dirPath || '/'}`);
            if (!name?.trim()) return;
            try {
                const dirHandle = await this.getHandleFromPath(dirPath);
                await this.newLocalFile(dirHandle, name);
                await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);
            } catch (err) {
                this.setStatus(`Error creating file: ${err.message}`);
            }
        } else if (this.mode === 'multi-file-edit') {
            const dirPath = baseDir || '';
            const name = prompt(`Enter new file name in:\n${dirPath || '/'} (multi-file project)`);
            if (!name?.trim()) return;
            const fullPath = dirPath ? `${dirPath}/${name.trim()}` : name.trim();
            try {
                if (!this.script) throw new Error('No script loaded');
                this.script.files = this.script.files || {};
                if (this.script.files.hasOwnProperty(fullPath)) {
                    this.setStatus(`File already exists: ${fullPath}`);
                    return;
                }
                this.script.files[fullPath] = '';
                this.buildTreeFromObject(this.script.files, expandedPaths);
                this.setStatus(`Created file: ${fullPath}`);
                this.loadVirtualFileForEditing(fullPath);
            } catch (err) {
                this.setStatus(`Error creating file: ${err.message}`);
            }
        }
    }

    async newFolder(baseDir = null) {
        const expandedPaths = this.getExpandedPaths();

        if (this.mode === 'git') {
            const dir = baseDir || this.getBasePath();
            const name = prompt(`Enter new folder name in:\n${dir.replace(this.gitDir, '') || '/'}`);
            if (!name?.trim()) return;
            const fullPath = `${dir}/${name.trim()}`;
            try {
                await this.fs.promises.mkdir(fullPath, {
                    recursive: true
                });
                this.logGit(`Created folder: ${fullPath}`);
                await this.buildGitTree();
                await this.restoreExpandedPaths(expandedPaths);
            } catch (err) {
                this.logGit(`Error creating folder: ${err.message}`);
                alert(`Error: ${err.message}`);
            }
        } else if (this.mode === 'workspace') {
            const dirPath = baseDir || '';
            const name = prompt(`Enter new folder name in:\n${dirPath || '/'}`);
            if (!name?.trim()) return;
            try {
                const dirHandle = await this.getHandleFromPath(dirPath);
                await this.newLocalFolder(dirHandle, name);
                await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);
            } catch (err) {
                this.setStatus(`Error creating folder: ${err.message}`);
            }
        } else if (this.mode === 'multi-file-edit') {
            const dirPath = baseDir || '';
            const name = prompt(`Enter new folder name in:\n${dirPath || '/'} (multi-file project)`);
            if (!name?.trim()) return;
            const folderPath = dirPath ? `${dirPath}/${name.trim()}` : name.trim();
            const placeholder = `${folderPath}/.keep`;
            try {
                if (!this.script) throw new Error('No script loaded');
                this.script.files = this.script.files || {};
                if (this.script.files.hasOwnProperty(placeholder)) {
                    this.setStatus(`Folder already exists: ${folderPath}`);
                    return;
                }
                this.script.files[placeholder] = '';
                this.buildTreeFromObject(this.script.files, expandedPaths);
                this.setStatus(`Created folder: ${folderPath}`);
            } catch (err) {
                this.setStatus(`Error creating folder: ${err.message}`);
            }
        }
    }

    async newImage(baseDir = null) {
        const expandedPaths = this.getExpandedPaths();

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = false;

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                if (this.mode === 'git') {
                    const dir = baseDir || this.getBasePath();
                    const fullPath = `${dir}/${file.name}`;

                    const arrayBuffer = await file.arrayBuffer();
                    await this.fs.promises.writeFile(fullPath, new Uint8Array(arrayBuffer));

                    this.logGit(`Added image: ${fullPath}`);
                    await this.buildGitTree();
                    await this.restoreExpandedPaths(expandedPaths);

                } else if (this.mode === 'workspace') {
                    const dirPath = baseDir || '';
                    const dirHandle = await this.getHandleFromPath(dirPath);

                    const newFileHandle = await dirHandle.getFileHandle(file.name, {
                        create: true
                    });
                    const writable = await newFileHandle.createWritable();
                    await writable.write(file);
                    await writable.close();

                    await this.buildTree(this.workspaceHandle, document.getElementById('fileTree'), '', expandedPaths);
                    this.setStatus(`Image added: ${file.name}`);

                } else if (this.mode === 'multi-file-edit') {
                    const dirPath = baseDir || '';
                    const fullPath = dirPath ? `${dirPath}/${file.name}` : file.name;

                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        if (!this.script) throw new Error('No script loaded');
                        this.script.files = this.script.files || {};

                        if (this.script.files.hasOwnProperty(fullPath)) {
                            if (!confirm(`File ${fullPath} already exists. Replace it?`)) return;
                        }

                        this.script.files[fullPath] = e.target.result;
                        this.buildTreeFromObject(this.script.files, expandedPaths);
                        this.setStatus(`Image added: ${fullPath}`);
                    };
                    reader.readAsDataURL(file);
                }

            } catch (err) {
                this.setStatus(`Error adding image: ${err.message}`);
                console.error('Image upload error:', err);
            }
        };

        input.click();
    }

    // just a helper to log stuff to the git modal console
    logGit(msg, type = 'info') {
        console.log(`[GIT] ${msg}`);

        const isUserFacing = !msg.startsWith('Staging') && !msg.startsWith('Adding remote') && !msg.startsWith('Initializing') && !msg.startsWith('Token');
        if (isUserFacing) {
            this.setStatus(msg, true, type);
        }

        this.gitLogs.textContent += `> ${msg}\n`;
        this.gitLogs.parentElement.scrollTop = this.gitLogs.parentElement.scrollHeight;
    }

    async getAuth() {

        const token = document.getElementById('token').value;

        if (token) {
            return {
                username: 'x-oauth-basic',
                password: token
            };
        }

        return {};
    }

    // clones a git repo into the vrtual filesystem
    async clone() {
        const url = document.getElementById('repoUrl').value;
        const branch = document.getElementById('branch').value;

        if (!this.git?.clone) {
            this.logGit('ERROR: Git library not initialized');
            return;
        }
        if (!url) {
            this.logGit('ERROR: Repo URL required');
            return;
        }

        this.logGit(`Clearing workspace...`);
        try {
            const entries = await this.gitFS.readdir(this.gitDir);
            for (const entry of entries) {
                await this.deleteRecursive(`${this.gitDir}/${entry}`);
            }
            this.logGit('Workspace cleared');
        } catch (err) {
            if (err.code === 'ENOENT') {
                await this.gitFS.mkdir(this.gitDir);
            } else {
                throw err;
            }
        }

        try {
            this.logGit(`Cloning ${url}...`);

            let options = {
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                url: url,
                singleBranch: true,
                depth: 1,
                //corsProxy: 'https://cors.isomorphic-git.org',
                onAuth: () => this.getAuth(),
            };

            if (this.editorSettings.useCorsProxy) {
                options.corsProxy = 'https://cors.isomorphic-git.org';
            }

            if (branch?.trim()) {
                options.ref = branch.trim();
            }

            try {
                await this.git.clone(options);
                this.logGit('Clone successful!');
            } catch (firstError) {
                if (firstError.message.includes('Could not find')) {
                    const branches = ['master', 'main', 'develop', 'dev'];
                    let success = false;

                    for (const tryBranch of branches) {
                        if (tryBranch === (branch || '').trim()) continue;
                        this.logGit(`Branch '${branch || 'default'}' not found. Trying '${tryBranch}'`);
                        try {
                            await this.git.clone({
                                ...options,
                                ref: tryBranch
                            });
                            this.logGit(`Success with branch: ${tryBranch}`);
                            document.getElementById('branch').value = tryBranch;
                            success = true;
                            break;
                        } catch (branchError) {
                            this.logGit(`Branch '${tryBranch}' failed: ${branchError.message}`);
                        }
                    }
                    this.lastGitRepoUrl = url;
                    this.lastGitBranch = branch;
                    chrome.storage.local.set({
                        lastGitRepoUrl: url,
                        lastGitBranch: branch
                    });
                    if (!success) {
                        throw new Error(`All attempts failed. Original: ${firstError.message}`);
                    }
                } else {
                    throw firstError;
                }
            }

            const finalBranch = document.getElementById('branch').value.trim();
            await this.idb.set('settings', 'gitWorkspace', {
                url,
                branch: finalBranch
            });
            this.logGit('Git workspace saved');
            this.projectEntryPoint = null;
            await this.updateRepoHistory(url);

            this.mode = 'git';
            this.saveBtn.textContent = 'Save File';
            this.metadata.style.opacity = 0.3;

            await this.buildGitTree();

            this.editor.setValue("/* Select a file from the explorer. */");
            this.setStatus(`Git workspace loaded: ${url.split('/').pop()}`);
            this.gitModal.classList.remove('visible');
            const scTab = document.querySelector('.sidebar-tab[data-tab="source-control"]');
            if (scTab) scTab.style.display = 'block';

            this.switchSidebarTab('source-control');
        } catch (error) {
            this.logGit(`CLONE FAILED: ${error.message}`);
            console.error(error);
            await this.idb.set('settings', 'gitWorkspace', null);
        }
    }

    async loadSavedGitWorkspace() {
        try {
            const workspace = await this.idb.get('settings', 'gitWorkspace');
            if (!workspace?.url) return false;

            try {
                await this.gitFS.stat(this.gitDir);
            } catch (e) {
                await this.idb.set('settings', 'gitWorkspace', null);
                return false;
            }

            this.logGit(`Found saved Git workspace: ${workspace.url}`);
            this.projectEntryPoint = null;
            document.getElementById('repoUrl').value = workspace.url;
            if (workspace.branch) {
                document.getElementById('branch').value = workspace.branch;
            }

            this.mode = 'git';
            this.saveBtn.textContent = 'Save File';
            this.metadata.style.opacity = 0.3;

            await this.buildGitTree();
            this.toggleExplorer(true);
            this.editor.setValue("/* Git workspace restored. Select a file to edit. */");
            this.editor.updateOptions({
                readOnly: true
            });
            this.setStatus(`Git workspace restored: ${workspace.url.split('/').pop()}`);

            return true;
        } catch (err) {
            console.error("Error loading Git workspace:", err);
            this.logGit(`Error restoring: ${err.message}`);
            return false;
        }
    }

    // pulls changes from the remote repo
    async pull() {
        if (this.mode !== 'git') {
            this.logGit("ERROR: No Git workspace loaded");
            return;
        }
        const branch = document.getElementById('branch').value;
        this.logGit('Pulling changes...');

        try {
            await this.git.fetch({
                fs: this.fs,
                http: this.http,
                dir: this.gitDir,
                ref: branch,
                singleBranch: true,
                depth: 1,
                corsProxy: 'https://cors.isomorphic-git.org',
                onAuth: () => this.getAuth(),
            });

            const remoteRef = `origin/${branch}`;
            const oid = await this.git.resolveRef({
                fs: this.fs,
                dir: this.gitDir,
                ref: remoteRef
            });

            await this.git.checkout({
                fs: this.fs,
                dir: this.gitDir,
                ref: oid,
                force: true,
            });

            this.logGit(`Reset to ${remoteRef}`);
            await this.buildGitTree();
            this.editor.setValue("/* Pull complete. Select a file to view changes. */");
        } catch (error) {
            this.logGit(`PULL FAILED: ${error.message}`);
        }
    }

    // stages all changes, commits, and pushes to the remote repo
    async push() {
        if (this.mode !== 'git' && this.mode !== 'multi-file-edit') {
            this.logGit('ERROR No Git workspace or multi-file project loaded');
            return;
        }

        const url = document.getElementById('repoUrl').value;
        let branch = document.getElementById('branch').value || 'main';
        branch = branch.trim();

        if (!url) {
            this.logGit('ERROR Repository URL required');
            return;
        }

        try {
            let workDir = this.gitDir;

            if (this.mode === 'multi-file-edit') {
                this.script.files = this.script.files || {};

                if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
                    this.script.files[this.currentPath] = this.editor.getValue();
                }

                await this.syncMultiFileToGit();
                this.logGit('Files synced to Git workspace');
                workDir = this.gitDir;
            }

            const status = await this.git.statusMatrix({
                fs: this.fs,
                dir: workDir
            });
            let hasChanges = false;
            this.logGit('Staging changes...');

            for (const row of status) {
                const path = row[0];
                const workdir = row[2];

                if (workdir === 0) continue;

                if (workdir === 2 || workdir === 3) {
                    await this.git.add({
                        fs: this.fs,
                        dir: workDir,
                        filepath: path
                    });
                    this.logGit(' - Staged change', path);
                    hasChanges = true;
                } else if (workdir === 1) {
                    await this.git.remove({
                        fs: this.fs,
                        dir: workDir,
                        filepath: path
                    });
                    this.logGit(' - Staged deletion', path);
                    hasChanges = true;
                }
            }

            if (!hasChanges) {
                this.logGit('No changes to commit');
            } else {
                this.logGit('Committing...');
                const commitMsg =
                    this.mode === 'multi-file-edit' ?
                    `Update from ScriptFlow: ${this.script.name || 'Project'}` :
                    'Update from ScriptFlow';

                const sha = await this.git.commit({
                    fs: this.fs,
                    dir: workDir,
                    message: commitMsg,
                    author: {
                        name: 'ScriptFlow',
                        email: 'bot@scriptflow.app'
                    },
                });

                this.logGit('Committed', sha.substring(0, 7));
            }

            const pushOptions = {
                fs: this.fs,
                http: this.http,
                dir: workDir,
                remote: 'origin',
                ref: branch,
                force: false,
                onAuth: this.getAuth,
            };

            if (this.editorSettings.useCorsProxy) {
                pushOptions.corsProxy = 'https://cors.isomorphic-git.org';
            }

            this.logGit(`Pushing to origin/${branch}...`);

            let result;
            let autoFixed = false;

            try {
                result = await this.git.push(pushOptions);
            } catch (err) {
                const msg = String(err?.message || '').toLowerCase();

                if (msg.includes('non-fast-forward') || msg.includes('not a simple fast-forward')) {
                    autoFixed = true;

                    this.showNotification({
                        title: 'Push Failed',
                        message: 'Git reported a non-fast-forward error. Will attempt auto-fix by syncing to remote and re-applying your changes.',
                        type: 'warning',
                        duration: 7000,
                    });

                    await this.syncWorkspaceToGit();
                    this.logGit('Local virtual repo reset to match remote.');

                    const statusAfterSync = await this.git.statusMatrix({
                        fs: this.fs,
                        dir: workDir
                    });

                    let hasNewChanges = false;
                    this.logGit('Re-staging changes after sync...');

                    for (const row of statusAfterSync) {
                        const path = row[0];
                        const workdir = row[2];

                        if (workdir === 0) continue;

                        if (workdir === 2 || workdir === 3) {
                            await this.git.add({
                                fs: this.fs,
                                dir: workDir,
                                filepath: path
                            });
                            this.logGit(' - Re-staged change', path);
                            hasNewChanges = true;
                        } else if (workdir === 1) {
                            await this.git.remove({
                                fs: this.fs,
                                dir: workDir,
                                filepath: path
                            });
                            this.logGit(' - Re-staged deletion', path);
                            hasNewChanges = true;
                        }
                    }

                    if (hasNewChanges) {
                        this.logGit('Re-committing...');
                        const commitMsg = this.mode === 'multi-file-edit' ? `Update from ScriptFlow: ${this.script.name || 'Project'}` : 'Update from ScriptFlow';

                        const sha = await this.git.commit({
                            fs: this.fs,
                            dir: workDir,
                            message: commitMsg,
                            author: {
                                name: 'ScriptFlow',
                                email: 'bot@scriptflow.app'
                            },
                        });

                        this.logGit('Re-committed', sha.substring(0, 7));
                    } else {
                        this.logGit('No changes to re-commit after sync.');
                    }

                    this.logGit('Retrying push...');
                    result = await this.git.push({
                        ...pushOptions,
                        force: false
                    });
                } else {
                    throw err;
                }
            }

            if (!result?.ok) {
                const errorText = result?.errors ? result.errors.join(', ') : 'No response';
                throw new Error(`Push failed: ${errorText}`);
            }

            this.logGit('Push successful!');
            this.saveCounter = 0;

            this.setStatus(autoFixed ? 'Committed and pushed after auto-fix.' : 'Committed and pushed!', true, 'success');

            this.showNotification({
                title: autoFixed ? 'Push Fixed Automatically' : 'Push Successful',
                message: autoFixed ? 'Your push initially failed with a non-fast-forward error, but ScriptFlow automatically synced to the remote and retried successfully.' : 'Your changes were committed and pushed to GitHub.',
                type: 'success',
                duration: 6000,
            });

            await this.updateRepoHistory(url);
            await this.refreshSourceControl?.();
        } catch (err) {
            this.logGit('ERROR', err.message);
            console.error(err);
            this.setStatus('Commit/Push failed: ' + (err.message || 'Unknown error'), true, 'error');

            this.showNotification({
                title: 'Push Failed',
                message: err.message || 'Unknown Git error',
                type: 'error',
                duration: 8000,
            });

            await this.refreshSourceControl?.();
        }
    }

    getBasePath() {
        const active = document.querySelector('#fileTree .tree-item.active');
        if (!active) return this.gitDir;

        const path = active.dataset.path;
        const kind = active.dataset.kind;

        if (kind === 'directory') {
            return path;
        } else {
            return path.substring(0, path.lastIndexOf('/'));
        }
    }

    // builds the file explorer tree from the virtual git filesystem
    async buildGitTree() {
        const tree = document.getElementById('fileTree');
        tree.innerHTML = '';

        if (!this.editor) return;

        const readDir = async (currentDir, element) => {
            let entries = [];
            try {
                const files = await this.fs.promises.readdir(currentDir);

                for (const file of files) {
                    if (file === '.git') continue;

                    const fullPath = currentDir === this.gitDir ? `${this.gitDir}/${file}` : `${currentDir}/${file}`;

                    try {
                        const stat = await this.fs.promises.stat(fullPath);
                        entries.push({
                            name: file,
                            path: fullPath,
                            kind: stat.isDirectory() ? 'directory' : 'file'
                        });
                    } catch (statError) {
                        continue;
                    }
                }
            } catch (readdirError) {
                const li = document.createElement('li');
                li.innerHTML = `<div class="tree-item" style="color: red;">Error reading directory</div>`;
                element.appendChild(li);
                return;
            }

            entries.sort((a, b) => {
                if (a.kind === 'directory' && b.kind !== 'directory') return -1;
                if (a.kind !== 'directory' && b.kind === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            for (const entry of entries) {
                const li = document.createElement('li');
                const item = document.createElement('div');
                item.classList.add('tree-item');
                item.setAttribute('draggable', true);

                item.dataset.path = entry.path;
                item.dataset.kind = entry.kind;
                item.dataset.name = entry.name;

                const arrow = document.createElement('span');
                arrow.className = 'arrow';
                item.appendChild(arrow);

                const icon = document.createElement('span');
                icon.className = 'icon';
                item.appendChild(icon);

                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = entry.name;
                item.appendChild(name);

                li.appendChild(item);

                if (entry.kind === 'directory') {
                    item.classList.add('is-folder');
                    item.setAttribute('data-state', 'collapsed');
                    icon.classList.add('folder');

                    const nested = document.createElement('ul');
                    nested.className = 'nested-tree';
                    li.appendChild(nested);

                    item.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const state = item.getAttribute('data-state');
                        if (state === 'collapsed') {
                            item.setAttribute('data-state', 'expanded');
                            if (nested.children.length === 0) {
                                await readDir(entry.path, nested);
                            }
                        } else {
                            item.setAttribute('data-state', 'collapsed');
                        }
                    });
                } else {
                    item.classList.add('is-file');
                    icon.classList.add('file');
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const current = tree.querySelector('.tree-item.active');
                        if (current) current.classList.remove('active');
                        item.classList.add('active');
                        this.loadVirtual(entry.path);
                    });
                }
                element.appendChild(li);
            }
        };

        try {
            await readDir(this.gitDir, tree);
            this.toggleExplorer(true);
            this.editor.updateOptions({
                readOnly: true
            });
            this.updateMultiFileButtons();
            await this.refreshSourceControl();
        } catch (e) {
            console.error("Failed to build git tree", e);
        }
    }

    // loads a file from the virtual git fs into the editor
    async loadVirtual(path) {
        try {
            this.mode = 'git';
            this.currentPath = path;
            this.setEditorMode(path);
            this.saveBtn.textContent = 'Save File';

            const filename = path.split('/').pop();

            if (this.isImageFile(filename)) {
                const content = await this.fs.promises.readFile(path);
                const blob = new Blob([content], {
                    type: this.getMimeType(filename)
                });
                const imageUrl = URL.createObjectURL(blob);
                this.displayImageInEditor(imageUrl, filename);
                this.setStatus(`Viewing image: ${path.replace(this.gitDir + '/', '')}`);
                return;
            }

            this.editor.updateOptions({
                readOnly: false
            });

            const editorContainer = document.getElementById('codeEditorContainer');
            const existingPreview = editorContainer.querySelector('.image-preview-overlay');
            if (existingPreview) {
                existingPreview.remove();
            }

            const content = await this.fs.promises.readFile(path, 'utf8');

            this.editor.setValue(content);
            this.setStatus(`Editing: ${path.replace(this.gitDir + '/', '')}`);

            if (this.isPreviewing) this.updatePreview();

        } catch (err) {
            console.error("Error loading virtual file:", err);
            this.setStatus(`Error: Could not read ${path}`);
        }
    }

    clearSearchMarkers() {
        if (this.editor) {
            this.searchMarkers = this.editor.deltaDecorations(this.searchMarkers || [], []);
        }
    }

    openSearch(options) {
        this.closeSearch(false);

        const commandBar = document.getElementById('commandBar');
        this.searchState = {
            mode: options.mode,
            query: '',
            replace: '',
            matches: [],
            currentMatch: -1
        };

        const searchInput = `<input type="text" placeholder="Search..." id="search-query" style="flex:1; background:transparent; border:none; color: var(--text);">`;
        const replaceInput = `<input type="text" placeholder="Replace with..." id="replace-with" style="flex:1; background:transparent; border:none; color: var(--text); border-left: 1px solid var(--border); margin-left:8px; padding-left:8px;">`;
        const buttons = `
        <div style="display:flex; gap: 8px; align-items:center; color: var(--muted);">
            <span id="match-count">0 / 0</span>
            <button id="prev-btn" class="btn-secondary" style="padding: 2px 8px;">&uarr;</button>
            <button id="next-btn" class="btn-secondary" style="padding: 2px 8px;">&darr;</button>
            ${options.mode === 'replace' ? `
            <button id="replace-btn" class="btn-secondary" style="padding: 2px 8px;">Replace</button>
            <button id="replace-all-btn" class="btn-secondary" style="padding: 2px 8px;">All</button>
            ` : ''}
            <button id="close-btn" class="btn-secondary" style="padding: 2px 8px; font-weight:bold;">&times;</button>
        </div>`;

        commandBar.innerHTML = searchInput + (options.mode === 'replace' ? replaceInput : '') + buttons;
        commandBar.style.display = 'flex';
        commandBar.style.gap = '8px';

        const queryInput = commandBar.querySelector('#search-query');
        queryInput.focus();

        this.debounceSearchHighlight = this.debounce(() => {
            this.searchState.query = queryInput.value;
            this.updateMatchCount();
        }, 150);

        queryInput.addEventListener('input', this.debounceSearchHighlight);

        this.boundSearchKeyHandler = this.handleSearchKey.bind(this);
        this.boundSearchClickHandler = this.handleSearchClick.bind(this);

        commandBar.addEventListener('keydown', this.boundSearchKeyHandler);
        commandBar.addEventListener('click', this.boundSearchClickHandler);
    }

    handleSearchKey(e) {
        if (e.key === 'Escape') this.closeSearch();
        if (e.key === 'Enter') {
            e.preventDefault();
            if (this.debounceSearchHighlight) this.debounceSearchHighlight.flush();
            this.findNext();
        }
    }

    handleSearchClick(e) {
        const action = e.target.id;
        this.searchState.query = document.getElementById('search-query').value;
        if (this.searchState.mode === 'replace') {
            this.searchState.replace = document.getElementById('replace-with').value;
        }

        if (this.debounceSearchHighlight) this.debounceSearchHighlight.flush();

        if (action === 'next-btn') this.findNext();
        if (action === 'prev-btn') this.findPrev();
        if (action === 'replace-btn') this.replaceOne();
        if (action === 'replace-all-btn') this.replaceAll();
        if (action === 'close-btn') this.closeSearch();
    }

    updateMatchCount() {
        if (!this.editor || !this.searchState) return;

        if (!this.searchState.query) {
            this.clearSearchMarkers();
            this.searchState.matches = [];
            this.searchState.currentMatch = -1;
        } else {
            const model = this.editor.getModel();
            this.searchState.matches = model.findMatches(this.searchState.query, true, false, false, null, true);

            const newDecorations = this.searchState.matches.map((match, index) => ({
                range: match.range,
                options: {
                    className: 'cm-search-highlight',
                }
            }));
            this.searchMarkers = this.editor.deltaDecorations(this.searchMarkers || [], newDecorations);
        }
        this.updateMatchCountUI();
    }

    updateMatchCountUI() {
        if (!this.searchState) return;
        const total = this.searchState.matches.length;
        const current = this.searchState.currentMatch;
        const countEl = document.getElementById('match-count');
        if (countEl) {
            countEl.textContent = total > 0 ? `${current + 1} / ${total}` : '0 matches';
        }
    }

    findNext() {
        if (!this.searchState || this.searchState.matches.length === 0) return;
        this.searchState.currentMatch++;
        if (this.searchState.currentMatch >= this.searchState.matches.length) {
            this.searchState.currentMatch = 0;
        }
        this.revealCurrentMatch();
    }

    findPrev() {
        if (!this.searchState || this.searchState.matches.length === 0) return;
        this.searchState.currentMatch--;
        if (this.searchState.currentMatch < 0) {
            this.searchState.currentMatch = this.searchState.matches.length - 1;
        }
        this.revealCurrentMatch();
    }

    revealCurrentMatch() {
        if (!this.searchState) return;
        const match = this.searchState.matches[this.searchState.currentMatch];
        if (match) {
            this.editor.setPosition(match.range.getStartPosition());
            this.editor.revealRangeInCenter(match.range, monaco.editor.ScrollType.Smooth);
        }
        this.updateMatchCountUI();
    }

    replaceOne() {
        if (!this.searchState) return;
        const match = this.searchState.matches[this.searchState.currentMatch];
        if (!match) return;

        this.editor.executeEdits('replace', [{
            range: match.range,
            text: this.searchState.replace
        }]);

        this.updateMatchCount();
    }

    replaceAll() {
        if (!this.searchState || this.searchState.matches.length === 0) return;

        const edits = this.searchState.matches.map(match => ({
            range: match.range,
            text: this.searchState.replace
        }));

        this.editor.executeEdits('replace-all', edits);
        this.updateMatchCount();
    }

    closeSearch(focusEditor = true) {
        this.clearSearchMarkers();
        const commandBar = document.getElementById('commandBar');

        if (this.boundSearchKeyHandler) {
            commandBar.removeEventListener('keydown', this.boundSearchKeyHandler);
            this.boundSearchKeyHandler = null;
        }
        if (this.boundSearchClickHandler) {
            commandBar.removeEventListener('click', this.boundSearchClickHandler);
            this.boundSearchClickHandler = null;
        }

        if (this.debounceSearchHighlight) {
            const queryInput = commandBar.querySelector('#search-query');
            if (queryInput) {
                queryInput.removeEventListener('input', this.debounceSearchHighlight);
            }
            this.debounceSearchHighlight = null;
        }

        commandBar.style.display = 'none';
        commandBar.innerHTML = `<input type="text" id="commandInput" placeholder="Enter command (e.g., 'help')...">`;
        this.searchState = null;
        if (focusEditor && this.editor) {
            this.editor.focus();
        }
    }


    async loadAllScripts() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getAllScripts'
            });
            this.scripts = response.scripts || [];
        } catch (error) {
            console.error('Failed to load scripts:', error);
        }
    }

    async loadScript(scriptId) {
        try {
            const result = await chrome.storage.local.get('scripts');
            const scripts = result.scripts || [];
            const script = scripts.find(s => s.id === scriptId);

            if (script) {
                this.script = script;
                if (!this.script.timeSpent) {
                    this.script.timeSpent = 0;
                }
                this.scriptId = scriptId;

                if (this.script.code) {
                    this.editor.setValue(this.script.code);
                }

                //this.populateMetadata();
                this.setStatus(`Loaded: ${this.script.name}`);
            }
        } catch (err) {
            console.error('Failed to load script:', err);
            this.setStatus('Error loading script', true, 'error');
        }
    }

    async saveScript() {
        if (this.isSaving) return;
        this.isSaving = true;
        this.saveBtn.disabled = true;

        const scriptNameVal = document.getElementById('scriptName').value.trim();
        const scriptDescVal = document.getElementById('scriptDescription').value.trim();
        const scriptEnabledVal = document.getElementById('scriptEnabled').checked;
        const scriptRunAtVal = document.getElementById('scriptRunAt')?.value || 'document_idle';

        try {
            const scriptData = {
                id: this.scriptId || (this.script && this.script.id) || null,
                name: scriptNameVal,
                description: scriptDescVal,
                code: this.editor.getValue(),
                matches: this.matches,
                grant: this.grants,
                enabled: scriptEnabledVal,
                runAt: scriptRunAtVal
            };

            const response = await chrome.runtime.sendMessage({
                action: 'saveScript',
                script: scriptData
            });

            if (response && response.success) {
                this.setStatus('Script saved!', true, 'success');

                if (!this.scriptId && response.scriptId) {

                    this.scriptId = response.scriptId;
                    if (!this.script) this.script = {};
                    this.script.id = response.scriptId;

                    const newUrl = new URL(window.location);
                    newUrl.searchParams.set('id', response.scriptId);
                    window.history.replaceState(null, '', newUrl.toString());

                    this.setStatus('Script created. Subsequent saves will update this script.', true, 'info');
                }
            } else {
                this.setStatus(`Error: ${response?.error || 'Unknown error'}`, false, 'error');
            }
        } catch (err) {
            console.error('Failed to save script:', err);
            this.setStatus('Failed to save script.', false, 'error');
        } finally {
            this.isSaving = false;
            this.saveBtn.disabled = false;
        }
    }

    escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // runs the formater
    format() {
        if (this.editor) {
            try {
                const position = this.editor.getPosition();
                const formatted = js_beautify(this.editor.getValue(), {
                    indent_size: 4,
                    space_in_empty_paren: true
                });
                this.editor.setValue(formatted);

                if (position) {
                    this.editor.setPosition(position);
                }

                this.setStatus('Code formatted');
            } catch (err) {
                console.error('Format failed:', err);
                this.setStatus('Format failed');
            }
        }
    }

    formatBundled(code) {
        try {
            if (typeof js_beautify === 'function') {
                return js_beautify(code, {
                    indent_size: 4,
                    space_in_empty_paren: true
                });
            }
        } catch (e) {
            console.warn('Bundled beautify failed', e);
        }
        return code;
    }

    // injects the current script into example com for testing
    async test() {
        const code = this.editor.getValue();
        this.setStatus('Opening example.com for testing...');

        let grants = [];
        const match = code.match(/"grant"\s*:\s*(\[[\s\S]*?\])/);
        if (match?.[1]) {
            try {
                grants = JSON.parse(match[1]);
            } catch (e) {
                console.warn("Could not parse grants", e);
            }
        }

        try {
            const tab = await chrome.tabs.create({
                url: 'https://example.com',
                active: true
            });

            if (!tab?.id) {
                this.setStatus('Error: Could not create tab');
                return;
            }

            chrome.runtime.sendMessage({
                action: 'executeTestScript',
                tabId: tab.id,
                userCode: code,
                grantList: grants
            }, (response) => {
                if (response?.success) {
                    this.setStatus(`Test script injected into tab ${tab.id}`);
                } else {
                    this.setStatus(`Error injecting: ${response?.error || 'Unknown'}`);
                }
            });

        } catch (error) {
            console.error('Test error:', error);
            this.setStatus(`Error: ${error.message}`);
        }
    }

    async addVirtualToZip(zip, path) {
        const entries = await this.fs.promises.readdir(path);
        for (const name of entries) {
            if (name === '.git') continue;

            const fullPath = `${path}/${name}`;
            const stat = await this.fs.promises.stat(fullPath);

            if (stat.isDirectory()) {
                const folder = zip.folder(name);
                await this.addVirtualToZip(folder, fullPath);
            } else {
                const content = await this.fs.promises.readFile(fullPath);
                zip.file(name, content);
            }
        }
    }

    async exportZip() {
        if (this.mode !== 'workspace' && this.mode !== 'git' && this.mode !== 'multi-file-edit') {
            this.setStatus('No workspace or project loaded to export');
            return;
        }

        this.setStatus('Generating ZIP...');
        const zip = new JSZip();
        let name = 'export.zip';

        try {
            if (this.mode === 'multi-file-edit' && this.script && this.script.files) {
                name = `${this.script.name}-project.zip`;

                if (this.currentPath && this.script.files.hasOwnProperty(this.currentPath)) {
                    this.script.files[this.currentPath] = this.editor.getValue();
                }

                for (const [path, content] of Object.entries(this.script.files)) {
                    if (path.includes('/')) {
                        const parts = path.split('/');
                        const fileName = parts.pop();
                        const folders = parts.join('/');
                        zip.folder(folders).file(fileName, content);
                    } else {
                        zip.file(path, content);
                    }
                }

                this.setStatus('Bundling userscript...');
                try {
                    const response = await chrome.runtime.sendMessage({
                        action: 'buildBundledUserscript',
                        scriptId: this.script.id || 'temp'
                    });

                    if (response && response.success && response.bundledCode) {
                        const formatted = this.formatBundled(response.bundledCode);
                        zip.file('bundled.user.js', formatted);
                        this.setStatus('Added bundled.user.js to ZIP');
                    } else {
                        console.warn('Could not generate bundled userscript:', response?.error);
                        this.setStatus('Warning: bundled.user.js generation failed, continuing.', false);
                    }
                } catch (err) {
                    console.error('Bundler error:', err);
                    // continue export even if bundling fails
                }

            } else if (this.mode === 'workspace' && this.workspaceHandle) {
                name = `${this.workspaceHandle.name}.zip`;

                async function addToZip(zipFolder, dir) {
                    for await (const entry of dir.values()) {
                        if (entry.kind === 'file') {
                            const file = await entry.getFile();
                            zipFolder.file(entry.name, file);
                        } else if (entry.kind === 'directory') {
                            const folder = zipFolder.folder(entry.name);
                            await addToZip(folder, entry);
                        }
                    }
                }

                await addToZip(zip, this.workspaceHandle);

            } else if (this.mode === 'git') {
                const url = document.getElementById('repoUrl').value;
                if (url) {
                    name = `${url.split('/').pop().replace('.git', '')}.zip`;
                }
                await this.addVirtualToZip(zip, this.gitDir);
            }

            const content = await zip.generateAsync({
                type: 'blob'
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);

            this.setStatus('Project exported as ZIP!', true, 'success');
        } catch (err) {
            console.error('Export error:', err);
            this.setStatus('Export failed', true, 'error');
        }
    }
}

const startEditor = () => {
    window.editor = new ScriptFlowEditor();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startEditor);
} else {
    startEditor();
}