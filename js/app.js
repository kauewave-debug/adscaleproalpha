/**
 * Main Application Logic
 * Router, Initialization, and Global State
 * Version: 2.0 - Production Ready
 */

// Logger Module
var logger = {
    container: null,
    badge: null,

    init: function() {
        this.container = document.getElementById('log-container');
        this.badge = document.getElementById('log-badge');
    },

    log: function(message, type, data) {
        if (!this.container) this.init();
        
        type = type || 'INFO';
        var timestamp = new Date().toLocaleTimeString();
        var colorClass = this.getColorForType(type);
        
        var dataHtml = '';
        if (data) {
            try {
                var json = JSON.stringify(data, null, 2);
                dataHtml = '<div class="mt-1 pl-4 border-l-2 border-gray-700 text-gray-500 text-xs overflow-x-auto whitespace-pre">' + json + '</div>';
            } catch (e) {
                dataHtml = '<div class="mt-1 pl-4 border-l-2 border-gray-700 text-gray-500 text-xs">' + String(data) + '</div>';
            }
        }
        
        var logEntry = document.createElement('div');
        logEntry.className = 'py-2 border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors';
        logEntry.innerHTML = 
            '<div class="flex items-center gap-2">' +
            '    <span class="text-gray-600 text-xs font-mono">[' + timestamp + ']</span>' +
            '    <span class="px-2 py-0.5 rounded text-xs font-bold ' + colorClass + '">' + type + '</span>' +
            '    <span class="text-gray-300 text-sm">' + message + '</span>' +
            '</div>' +
            dataHtml;
        
        if (this.container) {
            this.container.appendChild(logEntry);
            this.container.scrollTop = this.container.scrollHeight;
        }
        
        // Show badge if panel is closed
        var panel = document.getElementById('log-panel');
        if (panel && panel.classList.contains('translate-y-full') && this.badge) {
            this.badge.classList.remove('hidden');
        }
        
        // Also log to console
        console.log('[' + type + '] ' + message, data || '');
    },

    info: function(msg, data) { this.log(msg, 'INFO', data); },
    success: function(msg, data) { this.log(msg, 'SUCCESS', data); },
    warn: function(msg, data) { this.log(msg, 'WARN', data); },
    error: function(msg, data) { this.log(msg, 'ERROR', data); },

    getColorForType: function(type) {
        switch (type) {
            case 'INFO': return 'bg-blue-500/20 text-blue-400';
            case 'SUCCESS': return 'bg-green-500/20 text-green-400';
            case 'WARN': return 'bg-yellow-500/20 text-yellow-400';
            case 'ERROR': return 'bg-red-500/20 text-red-400';
            default: return 'bg-gray-500/20 text-gray-400';
        }
    },

    clear: function() {
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
};

window.logger = logger;

// Toggle Log Panel
function toggleLogs() {
    var panel = document.getElementById('log-panel');
    var badge = document.getElementById('log-badge');
    
    if (panel) {
        if (panel.classList.contains('translate-y-full')) {
            panel.classList.remove('translate-y-full');
            if (badge) badge.classList.add('hidden');
        } else {
            panel.classList.add('translate-y-full');
        }
    }
}

window.toggleLogs = toggleLogs;

// UI Preferences (theme/accent/density/sidebar/motion)
var uiPrefs = {
    key: 'ui_prefs_v2',
    prefs: {
        theme: 'dark',
        motion: 'full',
        sidebarCollapsed: false,
        accent: 'blue',
        density: 'comfortable'
    },

    init: function() {
        try {
            var raw = localStorage.getItem(this.key);
            if (raw) {
                var p = JSON.parse(raw);
                if (p && typeof p === 'object') {
                    this.prefs.theme = p.theme || this.prefs.theme;
                    this.prefs.motion = p.motion || this.prefs.motion;
                    this.prefs.sidebarCollapsed = !!p.sidebarCollapsed;
                    this.prefs.accent = p.accent || this.prefs.accent;
                    this.prefs.density = p.density || this.prefs.density;
                }
            } else {
                // Backward compatibility (v1)
                var raw1 = localStorage.getItem('ui_prefs_v1');
                if (raw1) {
                    var p1 = JSON.parse(raw1);
                    if (p1 && typeof p1 === 'object') {
                        this.prefs.sidebarCollapsed = !!p1.sidebarCollapsed;
                        this.prefs.accent = p1.accent || this.prefs.accent;
                        this.prefs.density = p1.density || this.prefs.density;
                    }
                }
            }
        } catch (e) {}

        this.apply();
        this.syncControls();
    },

    save: function() {
        try {
            localStorage.setItem(this.key, JSON.stringify(this.prefs));
        } catch (e) {}
    },

    resetUI: function() {
        this.prefs = {
            theme: 'dark',
            motion: 'full',
            sidebarCollapsed: false,
            accent: 'blue',
            density: 'comfortable'
        };
        this.save();
        this.apply();
        this.syncControls();
        if (window.logger) window.logger.success('Preferências de UI resetadas');
    },

    apply: function() {
        // Sidebar
        if (this.prefs.sidebarCollapsed) document.body.classList.add('sidebar-collapsed');
        else document.body.classList.remove('sidebar-collapsed');

        // Global hooks
        try {
            document.documentElement.setAttribute('data-accent', String(this.prefs.accent || 'blue'));
            document.documentElement.setAttribute('data-density', String(this.prefs.density || 'comfortable'));
            document.documentElement.setAttribute('data-theme', String(this.prefs.theme || 'dark'));
            document.documentElement.setAttribute('data-motion', String(this.prefs.motion || 'full'));
        } catch (e2) {}

        // CSS behavior hooks
        try {
            document.body.classList.toggle('reduce-motion', String(this.prefs.motion) === 'reduce');
        } catch (e3) {}

        this._syncSidebarIcon();
        this._syncAccentRings();
        this._syncSegmentButtons();
        this._syncToggles();
    },

    syncControls: function() {
        this._syncAccentRings();
        this._syncSegmentButtons();
        this._syncToggles();
    },

    _syncSidebarIcon: function() {
        // Icon rotation is handled in CSS. Nothing else required.
        return;
    },

    _syncAccentRings: function() {
        var btns = document.querySelectorAll('[data-accent-btn]');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            var a = b.getAttribute('data-accent-btn');
            // tailwind ring classes may not exist in all contexts; rely on inline class list already present.
            if (a === this.prefs.accent) {
                b.classList.remove('ring-transparent');
                b.classList.add('ring-white');
            } else {
                b.classList.add('ring-transparent');
                b.classList.remove('ring-white');
            }
        }
    },

    _syncSegmentButtons: function() {
        // Theme buttons
        var darkBtn = document.getElementById('btn-theme-dark');
        var lightBtn = document.getElementById('btn-theme-light');
        if (darkBtn && lightBtn) {
            var isDark = String(this.prefs.theme) !== 'light';
            darkBtn.className = 'px-3 py-1.5 text-xs rounded-lg transition-colors ' + (isDark ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white');
            lightBtn.className = 'px-3 py-1.5 text-xs rounded-lg transition-colors ' + (!isDark ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white');
        }

        // Density buttons
        var cBtn = document.getElementById('btn-density-comfortable');
        var kBtn = document.getElementById('btn-density-compact');
        if (cBtn && kBtn) {
            var isCompact = String(this.prefs.density) === 'compact';
            cBtn.className = 'px-3 py-1.5 text-xs rounded-lg transition-colors ' + (!isCompact ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white');
            kBtn.className = 'px-3 py-1.5 text-xs rounded-lg transition-colors ' + (isCompact ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white');
        }
    },

    _syncToggles: function() {
        var sidebarToggle = document.getElementById('toggle-sidebar');
        if (sidebarToggle) sidebarToggle.checked = !!this.prefs.sidebarCollapsed;

        var motionToggle = document.getElementById('toggle-motion');
        if (motionToggle) motionToggle.checked = String(this.prefs.motion) === 'reduce';
    },

    toggleSidebar: function() {
        this.setSidebarCollapsed(!this.prefs.sidebarCollapsed);
    },

    setSidebarCollapsed: function(isCollapsed) {
        this.prefs.sidebarCollapsed = !!isCollapsed;
        this.save();
        this.apply();
        this.syncControls();
        if (window.logger) window.logger.info('Sidebar ' + (this.prefs.sidebarCollapsed ? 'collapsed' : 'expanded'));
    },

    setAccent: function(accent) {
        this.prefs.accent = String(accent || 'blue');
        this.save();
        this.apply();
        this.syncControls();
    },

    setDensity: function(density) {
        this.prefs.density = String(density || 'comfortable');
        this.save();
        this.apply();
        this.syncControls();
    },

    setTheme: function(theme) {
        this.prefs.theme = (String(theme) === 'light') ? 'light' : 'dark';
        this.save();
        this.apply();
        this.syncControls();
    },

    setMotion: function(motion) {
        this.prefs.motion = (String(motion) === 'reduce') ? 'reduce' : 'full';
        this.save();
        this.apply();
        this.syncControls();
    }
};

// expose for inline handlers
window.uiPrefs = uiPrefs;

window.uiPrefs = uiPrefs;

// Router Module
var router = {
    activeRoute: 'dashboard',
    
    navigate: function(route) {
        var self = this;
        
        // Update Sidebar
        var navItems = document.querySelectorAll('.nav-item');
        for (var i = 0; i < navItems.length; i++) {
            var btn = navItems[i];
            var target = btn.getAttribute('data-target');
            
            if (target === route) {
                btn.classList.add('bg-blue-600/10', 'text-blue-500', 'border-blue-500');
                btn.classList.remove('text-gray-400', 'border-transparent', 'hover:bg-gray-800');
            } else {
                btn.classList.remove('bg-blue-600/10', 'text-blue-500', 'border-blue-500');
                btn.classList.add('text-gray-400', 'border-transparent', 'hover:bg-gray-800');
            }
        }

        // Update Views
        var views = document.querySelectorAll('.view-section');
        for (var i = 0; i < views.length; i++) {
            views[i].classList.add('hidden');
        }
        
        var targetView = document.getElementById('view-' + route);
        if (targetView) {
            targetView.classList.remove('hidden');
            this.activeRoute = route;
            
            // Update Title
            var pageTitle = document.getElementById('page-title');
            if (pageTitle) {
                pageTitle.textContent = this.formatTitle(route);
            }
            
            // Initialize view specific logic
            if (route === 'profiles' && window.profilesManager) {
                window.profilesManager.renderProfilesList();
            } else if (route === 'campaigns' && window.adsManager) {
                window.adsManager.init();
            } else if (route === 'rules' && window.rulesManager) {
                window.rulesManager.init();
            } else if (route === 'pages' && window.pagesManager) {
                window.pagesManager.loadPages();
            } else if (route === 'dashboard') {
                this.updateDashboard();
            }
            
            if (window.logger) {
                window.logger.info('Navigated to: ' + route);
            }
        }
    },

    formatTitle: function(route) {
        var titles = {
            'dashboard': 'Dashboard',
            'profiles': 'Perfis & Business Managers',
            'campaigns': 'Gerenciador de Anúncios',
            'rules': 'Regras Automatizadas',
            'pages': 'Páginas do Facebook',
            'settings': 'Configurações'
        };
        return titles[route] || route;
    },

    updateDashboard: function() {
        // Update dashboard metrics
        var profileCount = 0;
        var accountCount = 0;
        var ruleCount = 0;

        if (window.profilesManager && window.profilesManager.profiles) {
            profileCount = window.profilesManager.profiles.length;
        }
        if (window.adsManager && window.adsManager.accounts) {
            accountCount = window.adsManager.accounts.length;
        }
        if (window.rulesManager && window.rulesManager.rules) {
            ruleCount = window.rulesManager.rules.length;
        }

        var profileEl = document.getElementById('metric-profiles');
        var accountEl = document.getElementById('metric-accounts');
        var ruleEl = document.getElementById('metric-rules');

        if (profileEl) profileEl.textContent = profileCount;
        if (accountEl) accountEl.textContent = accountCount;
        if (ruleEl) ruleEl.textContent = ruleCount;
    }
};

window.router = router;

// Initialization
window.addEventListener('DOMContentLoaded', function() {
    // Initialize Logger
    logger.init();
    logger.info('System initialized');

    // Apply UI prefs early
    if (window.uiPrefs && typeof window.uiPrefs.init === 'function') {
        window.uiPrefs.init();
    }

    // Keep dashboard storage usage in sync (dashboard + settings)
    try {
        var usage = JSON.stringify(localStorage).length / 1024;
        var el2 = document.getElementById('storage-usage-dashboard');
        if (el2) el2.textContent = usage.toFixed(2) + ' KB';
    } catch (e0) {}

    // Initialize Modules
    if (window.profilesManager) {
        window.profilesManager.init();
    }

    // Initialize Pages Manager (sets listeners; loading is triggered when navigating to Pages)
    if (window.pagesManager && typeof window.pagesManager.init === 'function') {
        window.pagesManager.init();
    }

    // Set initial route
    router.navigate('dashboard');

    // Calculate storage usage for settings + dashboard
    setTimeout(function() {
        var usage = JSON.stringify(localStorage).length / 1024;
        var el = document.getElementById('storage-usage');
        if (el) el.textContent = usage.toFixed(2) + ' KB';
        var el2 = document.getElementById('storage-usage-dashboard');
        if (el2) el2.textContent = usage.toFixed(2) + ' KB';
    }, 500);
});