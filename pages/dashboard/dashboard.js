class ScriptFlowDashboard {
    constructor() {
        this.scripts = [];
        this.filteredScripts = [];
        this.currentFilter = 'all';
        this.currentSort = 'status';
        this.searchQuery = '';
        this.init();
    }

    async init() {
        await this.loadScripts();
        this.SetupEventListeners();
        this.RenderDashboard();
    }

    async loadScripts() {
        try {
            const result = await chrome.storage.local.get(['scripts']);
            this.scripts = result.scripts || [];
            this.ApplyFiltersAndSort();
        } catch (error) {
            console.error('Failed to load scripts:', error);
            this.scripts = [];
            this.filteredScripts = [];
        }
    }

    SetupEventListeners() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                await this.loadScripts();
                this.RenderDashboard();
            });
        }

        const newScriptBtn = document.getElementById('newScriptBtn');
        if (newScriptBtn) {
            newScriptBtn.addEventListener('click', () => this.OpenEditor());
        }

        const OpenEditorBtn = document.getElementById('OpenEditorBtn');
        if (OpenEditorBtn) {
            OpenEditorBtn.addEventListener('click', () => this.OpenEditor());
        }

        const customizeBtn = document.getElementById('customizeBtn');
        if (customizeBtn) {
            customizeBtn.addEventListener('click', () => this.OpenCustomizeModal());
        }

        const customizeModalCloseBtn = document.getElementById('customizeModalCloseBtn');
        if (customizeModalCloseBtn) {
            customizeModalCloseBtn.addEventListener('click', () => this.CloseCustomizeModal());
        }

        const customizeModal = document.getElementById('customizeModal');
        if (customizeModal) {
            customizeModal.addEventListener('click', (e) => {
                if (e.target === customizeModal) {
                    this.CloseCustomizeModal();
                }
            });
        }

        this.SetupBackgroundControls();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.ApplyFiltersAndSort();
                this.renderScripts();
            });
        }

        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentFilter = e.target.dataset.filter;
                this.ApplyFiltersAndSort();
                this.renderScripts();
            });
        });

        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.currentSort = e.target.value;
                this.ApplyFiltersAndSort();
                this.renderScripts();
            });
        }

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.scripts) {
                this.scripts = changes.scripts.newValue || [];
                this.ApplyFiltersAndSort();
                this.RenderDashboard();
            }
        });
    }

    ApplyFiltersAndSort() {
        let filtered = [...this.scripts];

        if (this.searchQuery) {
            filtered = filtered.filter(script =>
                script.name.toLowerCase().includes(this.searchQuery) ||
                (script.description && script.description.toLowerCase().includes(this.searchQuery)) ||
                (script.matches && script.matches.some(m => m.toLowerCase().includes(this.searchQuery)))
            );
        }

        switch (this.currentFilter) {
            case 'enabled':
                filtered = filtered.filter(s => s.enabled);
                break;
            case 'disabled':
                filtered = filtered.filter(s => !s.enabled);
                break;
            case 'single':
                filtered = filtered.filter(s => s.type === 'single-file' || !s.type);
                break;
            case 'project':
                filtered = filtered.filter(s => s.type === 'multi-file' || s.type === 'tracked-project');
                break;
        }

        switch (this.currentSort) {
            case 'status':
                filtered.sort((a, b) => {
                    if (a.enabled === b.enabled) {
                        return (b.timeSpent || 0) - (a.timeSpent || 0);
                    }
                    return a.enabled ? -1 : 1;
                });
                break;
            case 'name':
                filtered.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'modified':
                filtered.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
                break;
            case 'time':
                filtered.sort((a, b) => (b.timeSpent || 0) - (a.timeSpent || 0));
                break;
            case 'created':
                filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                break;
        }

        this.filteredScripts = filtered;
    }

    RenderDashboard() {
        this.UpdateStats();
        this.renderScripts();
    }

    UpdateStats() {
        const totalScripts = document.getElementById('totalScripts');
        const enabledScripts = document.getElementById('enabledScripts');
        const disabledScripts = document.getElementById('disabledScripts');
        const totalTime = document.getElementById('totalTime');

        const enabled = this.scripts.filter(s => s.enabled).length;
        const disabled = this.scripts.length - enabled;
        const totalSeconds = this.scripts.reduce((acc, s) => acc + (s.timeSpent || 0), 0);

        if (totalScripts) totalScripts.textContent = this.scripts.length;
        if (enabledScripts) enabledScripts.textContent = enabled;
        if (disabledScripts) disabledScripts.textContent = disabled;
        if (totalTime) totalTime.textContent = this.FormatTimeSpent(totalSeconds);
    }

    FormatTimeSpent(totalSeconds) {
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
        const grid = document.getElementById('scriptsGrid');
        const emptyState = document.getElementById('emptyState');
        const visibleCount = document.getElementById('visibleCount');

        if (!grid) return;

        if (visibleCount) {
            visibleCount.textContent = `${this.filteredScripts.length} script${this.filteredScripts.length !== 1 ? 's' : ''}`;
        }

        if (this.filteredScripts.length === 0) {
            grid.innerHTML = '';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        grid.innerHTML = this.filteredScripts.map(script => this.CreateScriptCard(script)).join('');

        grid.querySelectorAll('.toggle-switch input').forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                this.ToggleScript(id);
            });
        });

        grid.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const button = e.target.closest('[data-action]');
                const action = button.dataset.action;
                const id = button.dataset.id;
                this.HandleAction(action, id);
            });
        });
    }

    CreateScriptCard(script) {
        const isProject = script.type === 'multi-file' || script.type === 'tracked-project';
        const typeClass = isProject ? 'project' : 'single-file';
        const typeLabel = isProject ? 'Project' : 'Single File';
        const fileCount = isProject ? Object.keys(script.files || {}).length : 1;

        const matchesDisplay = script.matches && script.matches.length > 0 ?
            script.matches.slice(0, 3).join(', ') + (script.matches.length > 3 ? ` +${script.matches.length - 3} more` : '') :
            'No matches defined';

        return `
            <div class="script-card ${script.enabled ? 'enabled' : 'disabled'}">
                <div class="script-card-header">
                    <div class="script-info">
                        <div class="script-name ${typeClass}">
                            ${isProject 
                                ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                   </svg>`
                                : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                                    <polyline points="13 2 13 9 20 9"></polyline>
                                   </svg>`
                            }
                            ${this.EscapeHtml(script.name)}
                        </div>
                        ${script.description ? `<div class="script-description">${this.EscapeHtml(script.description)}</div>` : ''}
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" ${script.enabled ? 'checked' : ''} data-id="${script.id}">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                
                <div class="script-meta">
                    <span class="meta-tag type-${isProject ? 'project' : 'single'}">
                        ${isProject 
                            ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                               </svg>`
                            : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                                <polyline points="13 2 13 9 20 9"></polyline>
                               </svg>`
                        }
                        ${typeLabel} (${fileCount} file${fileCount !== 1 ? 's' : ''})
                    </span>
                    <span class="meta-tag time">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        ${this.FormatTimeSpent(script.timeSpent || 0)}
                    </span>
                    <span class="meta-tag">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        ${script.runAt || 'document_idle'}
                    </span>
                </div>

                <div class="script-matches">
                    <strong>Matches:</strong> ${this.EscapeHtml(matchesDisplay)}
                </div>

                <div class="script-actions">
                    <button class="btn btn-secondary btn-with-icon" data-action="edit" data-id="${script.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                        Edit
                    </button>
                    <button class="btn btn-danger btn-with-icon" data-action="delete" data-id="${script.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        Delete
                    </button>
                </div>
            </div>
        `;
    }

    async ToggleScript(scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        const newState = !script.enabled;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'toggleScript',
                scriptId: scriptId,
                enabled: newState
            });

            if (response?.success) {
                script.enabled = newState;
                await chrome.storage.local.set({
                    scripts: this.scripts
                });
                this.ApplyFiltersAndSort();
                this.RenderDashboard();
            } else {
                throw new Error('Toggle failed');
            }
        } catch (error) {
            console.error('Failed to toggle script:', error);
            this.renderScripts();
        }
    }

    async HandleAction(action, scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        switch (action) {
            case 'edit':
                this.OpenEditor(script);
                break;
            case 'delete':
                if (confirm(`Delete script "${script.name}"?`)) {
                    await this.deleteScript(scriptId);
                }
            break;
        }
    }

    OpenEditor(script = null) {
        const url = script ?
            chrome.runtime.getURL('pages/editor/editor.html') + `?id=${script.id}` :
            chrome.runtime.getURL('pages/editor/editor.html') + '?new=true';

        chrome.tabs.create({
            url
        });
    }

    async deleteScript(scriptId) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'deleteScript',
                scriptId
            });

            if (!response || !response.success) {
                throw new Error(response?.error || 'Failed to delete script');
            }

            await this.loadScripts();
            this.RenderDashboard();
        } catch (error) {
            console.error('Failed to delete script:', error);
        }
    }

    escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    EscapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    SetupBackgroundControls() {
        this.bgSettings = {
            enabled: true,
            imageData: null,
            opacity: 30,
            blur: 0,
            size: 'cover',
            position: 'center'
        };

        this.LoadCustomBackground();
        this.ApplyCustomBackground();

        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('hiddenFileInput');
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        const blurSlider = document.getElementById('blurSlider');
        const blurValue = document.getElementById('blurValue');
        const bgSizeSelect = document.getElementById('bgSizeSelect');
        const bgPositionSelect = document.getElementById('bgPositionSelect');
        const enableCheckbox = document.getElementById('enableBgCheckbox');

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
                this.HandleBgImageUpload(file);
            }
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.HandleBgImageUpload(file);
            }
        });

        if (opacitySlider) {
            opacitySlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (opacityValue) opacityValue.textContent = `${value}%`;
                this.bgSettings.opacity = value;
                this.ApplyCustomBackground();
                this.SaveCustomBackground();
            });
        }

        if (blurSlider) {
            blurSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (blurValue) blurValue.textContent = `${value}px`;
                this.bgSettings.blur = value;
                this.ApplyCustomBackground();
                this.SaveCustomBackground();
            });
        }

        if (bgSizeSelect) {
            bgSizeSelect.addEventListener('change', (e) => {
                this.bgSettings.size = e.target.value;
                this.ApplyCustomBackground();
                this.SaveCustomBackground();
            });
        }

        if (bgPositionSelect) {
            bgPositionSelect.addEventListener('change', (e) => {
                this.bgSettings.position = e.target.value;
                this.ApplyCustomBackground();
                this.SaveCustomBackground();
            });
        }

        if (enableCheckbox) {
            enableCheckbox.addEventListener('change', (e) => {
                this.bgSettings.enabled = e.target.checked;
                this.ApplyCustomBackground();
                this.SaveCustomBackground();
            });
        }
    }

    HandleBgImageUpload(file) {
        if (file.size > 10 * 1024 * 1024) {
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

            this.ApplyCustomBackground();
            this.SaveCustomBackground();
        };
        reader.readAsDataURL(file);
    }

    ApplyCustomBackground() {
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

    OpenCustomizeModal() {
        const modal = document.getElementById('customizeModal');
        if (!modal) return;

        this.LoadCustomBackground();
        modal.classList.add('visible');

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
        if (opacityValue) opacityValue.textContent = `${this.bgSettings.opacity}%`;
        if (blurSlider) blurSlider.value = this.bgSettings.blur;
        if (blurValue) blurValue.textContent = `${this.bgSettings.blur}px`;
        if (bgSizeSelect) bgSizeSelect.value = this.bgSettings.size;
        if (bgPositionSelect) bgPositionSelect.value = this.bgSettings.position;
        if (enableCheckbox) enableCheckbox.checked = this.bgSettings.enabled;

        if (this.bgSettings.imageData) {
            if (previewImg) previewImg.src = this.bgSettings.imageData;
            if (previewContainer) previewContainer.style.display = 'block';
        }
    }

    CloseCustomizeModal() {
        const modal = document.getElementById('customizeModal');
        if (modal) {
            modal.classList.remove('visible');
        }
    }

    SaveCustomBackground() {
        localStorage.setItem('sf-custombackground', JSON.stringify(this.bgSettings));
    }

    LoadCustomBackground() {
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
            } catch (e) {
                console.error('Failed to load background settings:', e);
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new ScriptFlowDashboard();
});