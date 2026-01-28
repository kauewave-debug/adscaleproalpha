/**
 * Pages Manager Module
 * Minimal Pages listing (photo, name, id) + search + view toggle + UI pagination
 * Version: 6.0 - Minimal mode (no ads-linked counting)
 */
var pagesManager = {
    pages: [],
    isLoading: false,

    // UI state
    viewMode: 'grid',
    searchQuery: '',
    pageSize: 12,
    currentPage: 1,

    // runtime
    _loadSeq: 0,
    _lastLoad: { hadProfiles: false, errors: [] },

    init: function() {
        // Read page size from UI
        try {
            var sel = document.getElementById('pages-page-size');
            if (sel && sel.value) {
                var ps = parseInt(sel.value, 10);
                if (ps && ps > 0) this.pageSize = ps;
            }
        } catch (e) {}

        this.toggleView(this.viewMode);

        // Auto refresh when profiles change and Pages view is open
        var self = this;
        window.addEventListener('profilesUpdated', function() {
            try {
                var view = document.getElementById('view-pages');
                if (view && !view.classList.contains('hidden')) self.loadPages();
            } catch (e2) {}
        });

        if (window.logger) window.logger.info('Pages Manager initialized (v6.0 minimal)');
    },

    // =====================
    // UI controls
    // =====================
    search: function(query) {
        this.searchQuery = String(query || '').toLowerCase().trim();
        this.currentPage = 1;
        this.render();
    },

    toggleView: function(mode) {
        this.viewMode = (mode === 'list') ? 'list' : 'grid';
        var g = document.getElementById('btn-view-grid');
        var l = document.getElementById('btn-view-list');
        if (g) g.classList.toggle('active-view', this.viewMode === 'grid');
        if (l) l.classList.toggle('active-view', this.viewMode === 'list');
        this.render();
    },

    setPageSize: function(v) {
        var n = parseInt(v, 10);
        if (!n || n < 1) n = 12;
        this.pageSize = n;
        this.currentPage = 1;
        this.render();
    },

    prevPage: function() {
        if (this.currentPage > 1) {
            this.currentPage -= 1;
            this.render();
        }
    },

    nextPage: function() {
        var meta = this._getFilteredMeta();
        if (this.currentPage < meta.totalPages) {
            this.currentPage += 1;
            this.render();
        }
    },

    // =====================
    // Load pages (ALL pages via pagination)
    // =====================
    loadPages: function() {
        var self = this;
        var seq = ++this._loadSeq;
        if (this.isLoading) return;
        this.isLoading = true;

        this.pages = [];
        this.currentPage = 1;
        this._lastLoad = { hadProfiles: false, errors: [] };

        var container = document.getElementById('pages-container');
        if (container) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-32">' +
                '<i class="fas fa-circle-notch fa-spin text-4xl text-blue-500 mb-4"></i>' +
                '<p class="text-gray-400 font-medium">Carregando páginas...</p>' +
            '</div>';
        }

        var profiles = (window.profilesManager && window.profilesManager.profiles) ? window.profilesManager.profiles : [];
        this._lastLoad.hadProfiles = profiles.length > 0;

        if (!profiles.length) {
            this.isLoading = false;
            this.render();
            return;
        }

        var tasks = profiles.map(function(p) {
            return self._fetchPagesForProfileWithFallback(p, seq);
        });

        Promise.all(tasks)
            .then(function() {
                if (seq !== self._loadSeq) return;
                self.pages = self._dedupPages(self.pages);
                self.isLoading = false;
                self.render();
                if (window.logger) window.logger.success('Páginas carregadas', { total: self.pages.length });
            })
            .catch(function(err) {
                self.isLoading = false;
                if (window.logger) window.logger.error('Pages load failed', { error: String(err) });
                self.render();
            });
    },

    _fetchPagesForProfileWithFallback: function(profile, seq) {
        var self = this;
        if (!window.fbApi || typeof window.fbApi.getPages !== 'function') return Promise.resolve();

        function attach(list) {
            if (seq !== self._loadSeq) return;
            (list || []).forEach(function(p) {
                // keep only what we need
                var pic = null;
                if (p.picture && p.picture.data && p.picture.data.url) pic = p.picture.data.url;

                self.pages.push({
                    id: String(p.id),
                    name: String(p.name || ''),
                    picture: pic,
                    profileName: profile.name,
                    profileId: profile.id
                });
            });
        }

        // Minimal first to avoid permission/payload issues
        return window.fbApi.getPages(profile.token, { fields: 'id,name,picture{url}', limit: 100 })
            .then(attach)
            .catch(function(err) {
                // fallback even more minimal
                self._pushDiag(profile, 'minimal', err);
                return window.fbApi.getPages(profile.token, { fields: 'id,name', limit: 50 })
                    .then(attach)
                    .catch(function(e2) {
                        self._pushDiag(profile, 'ultra-min', e2);
                    });
            });
    },

    _pushDiag: function(p, step, err) {
        try {
            this._lastLoad.errors.push({
                profile: p && p.name ? p.name : '—',
                step: step,
                error: String(err && err.message ? err.message : err)
            });
        } catch (e) {}
    },

    _dedupPages: function(list) {
        var seen = {};
        var out = [];
        for (var i = 0; i < (list || []).length; i++) {
            var p = list[i];
            if (!p || !p.id) continue;
            var id = String(p.id);
            if (seen[id]) continue;
            seen[id] = true;
            out.push(p);
        }
        return out;
    },

    // =====================
    // Pagination helpers
    // =====================
    _getFilteredMeta: function() {
        var q = this.searchQuery;
        var list = (this.pages || []).filter(function(p) {
            if (!q) return true;
            var name = (p && p.name) ? String(p.name).toLowerCase() : '';
            var id = (p && p.id) ? String(p.id) : '';
            return name.indexOf(q) !== -1 || id.indexOf(q) !== -1;
        });

        var totalItems = list.length;
        var ps = this.pageSize || 12;
        var totalPages = Math.max(1, Math.ceil(totalItems / ps));

        if (this.currentPage < 1) this.currentPage = 1;
        if (this.currentPage > totalPages) this.currentPage = totalPages;

        var start = (this.currentPage - 1) * ps;
        var end = start + ps;
        var slice = list.slice(start, end);

        return {
            list: list,
            slice: slice,
            totalItems: totalItems,
            totalPages: totalPages,
            startIndex: totalItems ? (start + 1) : 0,
            endIndex: Math.min(end, totalItems)
        };
    },

    _syncPaginationUI: function(meta) {
        var sum = document.getElementById('pages-pagination-summary');
        var ind = document.getElementById('pages-page-indicator');
        var prev = document.getElementById('btn-pages-prev');
        var next = document.getElementById('btn-pages-next');

        if (sum) {
            var base = (!meta.totalItems) ? '0 páginas' : (meta.startIndex + '–' + meta.endIndex + ' de ' + meta.totalItems + ' páginas');
            sum.textContent = base;
        }
        if (ind) ind.textContent = this.currentPage + '/' + meta.totalPages;
        if (prev) prev.disabled = this.currentPage <= 1;
        if (next) next.disabled = this.currentPage >= meta.totalPages;
    },

    // =====================
    // Render
    // =====================
    render: function() {
        var container = document.getElementById('pages-container');
        if (!container) return;

        var meta = this._getFilteredMeta();
        this._syncPaginationUI(meta);

        if (!meta.totalItems) {
            container.innerHTML = this._renderEmpty();
            return;
        }

        if (this.viewMode === 'list') this._renderList(container, meta.slice);
        else this._renderGrid(container, meta.slice);
    },

    _renderEmpty: function() {
        // If there are profiles and errors, show diag
        var diag = '';
        if (this._lastLoad && this._lastLoad.hadProfiles && this._lastLoad.errors && this._lastLoad.errors.length) {
            diag += '<div class="mt-4 text-left max-w-2xl mx-auto bg-gray-950 border border-gray-800 rounded-2xl p-4">' +
                '<div class="text-xs font-bold text-gray-300 mb-2">Diagnóstico</div>' +
                '<ul class="text-xs text-gray-500 space-y-2">' +
                this._lastLoad.errors.slice(0, 6).map(function(e) {
                    return '<li><span class="text-gray-300">' + String(e.profile).replace(/</g,'&lt;') + '</span> • ' + String(e.step) + ' • ' + String(e.error).replace(/</g,'&lt;') + '</li>';
                }).join('') +
                '</ul>' +
                '<div class="mt-3 text-[10px] text-gray-500">Sugestão: permissões comuns para listar páginas: <span class="text-gray-300">pages_show_list</span>, <span class="text-gray-300">pages_read_engagement</span>.</div>' +
                '</div>';
        }

        return '<div class="py-24 text-center bg-gray-900/30 rounded-3xl border border-dashed border-gray-800">' +
            '<i class="fas fa-flag text-gray-700 text-5xl mb-4"></i>' +
            '<p class="text-gray-400">Nenhuma página encontrada.</p>' +
            diag +
            '</div>';
    },

    _renderGrid: function(container, list) {
        var self = this;
        var html = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">';

        (list || []).forEach(function(p) {
            var pic = p.picture || '';
            var initials = (p.name || 'P').trim().slice(0, 1).toUpperCase();

            html += '' +
                '<div class="group bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-3xl overflow-hidden transition-all duration-300 hover:shadow-xl hover:-translate-y-1">' +
                '  <div class="h-16 bg-gradient-to-r from-blue-900/40 to-purple-900/40 relative">' +
                '    <div class="absolute inset-0 bg-[url(\'https://www.transparenttextures.com/patterns/cubes.png\')] opacity-10"></div>' +
                '    <div class="absolute -bottom-7 left-6">' +
                (pic
                    ? '      <img src="' + self._esc(pic) + '" class="w-14 h-14 rounded-2xl border-4 border-gray-900 bg-gray-800 object-cover shadow-lg">'
                    : '      <div class="w-14 h-14 rounded-2xl border-4 border-gray-900 bg-gray-800 flex items-center justify-center font-bold text-white shadow-lg">' + self._esc(initials) + '</div>'
                ) +
                '    </div>' +
                '  </div>' +
                '  <div class="pt-10 px-6 pb-6">' +
                '    <h4 class="text-lg font-bold text-white truncate" title="' + self._esc(p.name) + '">' + self._esc(p.name) + '</h4>' +
                '    <div class="mt-2 flex items-center justify-between gap-3">' +
                '      <span class="text-[10px] font-mono text-gray-500 bg-gray-950 border border-gray-800 px-2 py-1 rounded-full truncate">' + self._esc(p.id) + '</span>' +
                '      <button class="columns-btn" type="button" onclick="pagesManager.copyPageId(\'' + self._esc(p.id) + '\')">Copiar ID</button>' +
                '    </div>' +
                '  </div>' +
                '</div>';
        });

        html += '</div>';
        container.innerHTML = html;
    },

    _renderList: function(container, list) {
        var self = this;
        var html = '<div class="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden shadow-2xl">';
        html += '<div class="grid grid-cols-12 gap-4 p-4 bg-gray-800/50 border-b border-gray-800 text-xs font-bold text-gray-400 uppercase tracking-wider">';
        html += '<div class="col-span-7 pl-2">Página</div><div class="col-span-5 text-right pr-2">ID</div></div>';
        html += '<div class="divide-y divide-gray-800">';

        (list || []).forEach(function(p) {
            var pic = p.picture || '';
            var initials = (p.name || 'P').trim().slice(0, 1).toUpperCase();

            html += '' +
                '<div class="grid grid-cols-12 gap-4 p-4 items-center hover:bg-gray-800/30 transition-colors group">' +
                '  <div class="col-span-7 flex items-center gap-3 pl-2 min-w-0">' +
                (pic
                    ? '    <img src="' + self._esc(pic) + '" class="w-10 h-10 rounded-xl bg-gray-800 object-cover shadow-sm">'
                    : '    <div class="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center font-bold text-white shadow-sm">' + self._esc(initials) + '</div>'
                ) +
                '    <div class="min-w-0">' +
                '      <p class="text-sm font-bold text-white truncate">' + self._esc(p.name) + '</p>' +
                '      <p class="text-[10px] text-gray-600 truncate">' + self._esc(p.profileName || '') + '</p>' +
                '    </div>' +
                '  </div>' +
                '  <div class="col-span-5 flex items-center justify-end gap-2 pr-2">' +
                '    <span class="text-[10px] font-mono text-gray-500 bg-gray-950 border border-gray-800 px-2 py-1 rounded-full truncate">' + self._esc(p.id) + '</span>' +
                '    <button class="columns-btn" type="button" onclick="pagesManager.copyPageId(\'' + self._esc(p.id) + '\')">Copiar</button>' +
                '  </div>' +
                '</div>';
        });

        html += '</div></div>';
        container.innerHTML = html;
    },

    copyPageId: function(id) {
        try {
            var text = String(id || '');
            if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text)
                    .then(function() {
                        if (window.logger) window.logger.success('ID da página copiado');
                    })
                    .catch(function() {
                        alert('Não foi possível copiar.');
                    });
            } else {
                var ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                if (window.logger) window.logger.success('ID da página copiado');
            }
        } catch (e) {}
    },

    _esc: function(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};

window.pagesManager = pagesManager;
