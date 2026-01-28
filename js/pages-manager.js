/**
 * Pages Manager Module
 * Handles Facebook Pages display + reliable ads linkage breakdown
 * Version: 5.3 - Pagination + progressive counts (no infinite spinner) + ACTIVE-only scan + scan progress + hard fail-safe
 */
var pagesManager = {
    pages: [],
    isLoading: false,

    // UI state
    viewMode: 'grid',
    searchQuery: '',
    pageSize: 12,
    currentPage: 1,

    // Runtime
    _loadSeq: 0,
    _lastLoad: { hadProfiles: false, errors: [] },
    _pageUsage: {},
    _nameCache: { campaign: {} },
    _accountsIndex: {},

    // Scan progress
    _scanProgress: { running: false, total: 0, done: 0, startedAt: 0, lastUpdateAt: 0 },

    // Per-account scan cache
    _scanCacheKey: 'pages_usage_cache_v1',
    _scanCacheTtlMs: 15 * 60 * 1000,

    init: function() {
        var self = this;

        // Read page size from UI (if present)
        try {
            var sel = document.getElementById('pages-page-size');
            if (sel && sel.value) {
                var ps = parseInt(sel.value, 10);
                if (ps && ps > 0) this.pageSize = ps;
            }
        } catch (e) {}

        // Ensure toggle UI is consistent
        this.toggleView(this.viewMode);

        // Auto refresh when profiles change and Pages view is open
        window.addEventListener('profilesUpdated', function() {
            try {
                var view = document.getElementById('view-pages');
                if (view && !view.classList.contains('hidden')) self.loadPages();
            } catch (e2) {}
        });

        if (window.logger) window.logger.info('Pages Manager initialized (v5.3)');
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
    // Load Pages
    // =====================
    loadPages: function() {
        var self = this;
        var seq = ++this._loadSeq;
        if (this.isLoading) return;
        this.isLoading = true;

        this._lastLoad = { hadProfiles: false, errors: [] };
        this._pageUsage = {};
        this._accountsIndex = {};
        this._scanProgress = { running: false, total: 0, done: 0, startedAt: 0, lastUpdateAt: 0 };
        this.currentPage = 1;

        var container = document.getElementById('pages-container');
        if (container) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-32">' +
                '<i class="fas fa-circle-notch fa-spin text-4xl text-blue-500 mb-4"></i>' +
                '<p class="text-gray-400 font-medium">Carregando páginas...</p>' +
            '</div>';
        }

        this.pages = [];
        var profiles = (window.profilesManager && window.profilesManager.profiles) ? window.profilesManager.profiles : [];
        this._lastLoad.hadProfiles = profiles.length > 0;

        if (!profiles.length) {
            this.isLoading = false;
            this.render();
            return;
        }

        var promises = profiles.map(function(p) {
            return self._fetchPagesForProfileWithFallback(p, seq);
        });

        Promise.all(promises)
            .then(function() {
                if (seq !== self._loadSeq) return;

                self.pages = self._dedupPages(self.pages);
                self.pages.forEach(function(p) {
                    // Start with loading flags ON, but we will show partial counts (0) immediately.
                    p._adsLinkedLoading = true;
                    p._adsLinkedCount = 0;
                    p._adsLinkedError = null;
                    // Limit still best-effort (not available publicly in many cases)
                    p._limitKnown = false;
                    p._limitValue = 0;
                });

                self.isLoading = false;
                self.render();

                // Background scan accounts incrementally (ACTIVE-only)
                return self._computeAdsUsage(seq);
            })
            .catch(function(err) {
                self.isLoading = false;
                if (window.logger) window.logger.error('Pages load failed', { error: String(err) });
                self._finalizeLoadingAllPages('Falha ao carregar páginas');
                self.render();
            });
    },

    _finalizeLoadingAllPages: function(errMsg) {
        (this.pages || []).forEach(function(p) {
            p._adsLinkedLoading = false;
            if (errMsg) p._adsLinkedError = errMsg;
        });
        this._scanProgress.running = false;
    },

    _fetchPagesForProfileWithFallback: function(profile, seq) {
        var self = this;
        if (!window.fbApi || typeof window.fbApi.getPages !== 'function') return Promise.resolve();

        function attach(list) {
            if (seq !== self._loadSeq) return;
            (list || []).forEach(function(p) {
                p.profileName = profile.name;
                p.profileId = profile.id;
                p.profileToken = profile.token;
                p.pageToken = p.access_token || null;
                self.pages.push(p);
            });
        }

        // Try heavier → lighter
        return window.fbApi.getPages(profile.token, { fields: 'id,name,category,fan_count,picture{url},access_token', limit: 100 })
            .then(attach)
            .catch(function(err) {
                self._pushDiag(profile, 'full', err);
                return window.fbApi.getPages(profile.token, { fields: 'id,name,category,picture{url}', limit: 100 })
                    .then(attach)
                    .catch(function(e2) {
                        self._pushDiag(profile, 'minimal', e2);
                        return window.fbApi.getPages(profile.token, { fields: 'id,name,picture{url}', limit: 50 })
                            .then(attach)
                            .catch(function(e3) {
                                self._pushDiag(profile, 'ultra-min', e3);
                            });
                    });
            });
    },

    _pushDiag: function(p, step, err) {
        try {
            this._lastLoad.errors.push({ profile: p && p.name ? p.name : '—', step: step, error: String(err && err.message ? err.message : err) });
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
            if (this._scanProgress && this._scanProgress.running) {
                base += ' • Escaneando contas: ' + this._scanProgress.done + '/' + this._scanProgress.total;
            }
            sum.textContent = base;
        }
        if (ind) ind.textContent = this.currentPage + '/' + meta.totalPages;

        if (prev) prev.disabled = this.currentPage <= 1;
        if (next) next.disabled = this.currentPage >= meta.totalPages;
    },

    // =====================
    // Account scan (incremental + cached)
    // =====================
    _computeAdsUsage: function(seq) {
        var self = this;

        if (!window.fbApi || typeof window.fbApi.fetchAllPath !== 'function') {
            self._finalizeLoadingAllPages('API não carregada');
            self.render();
            return Promise.resolve();
        }

        return this._getAdAccountsForUsage()
            .then(function(accs) {
                if (seq !== self._loadSeq) return;

                accs = accs || [];
                self._accountsIndex = {};
                for (var i = 0; i < accs.length; i++) self._accountsIndex[String(accs[i].id)] = accs[i];

                self._scanProgress = {
                    running: true,
                    total: accs.length,
                    done: 0,
                    startedAt: Date.now(),
                    lastUpdateAt: Date.now()
                };

                if (!accs.length) {
                    (self.pages || []).forEach(function(p) {
                        p._adsLinkedLoading = false;
                        p._adsLinkedError = 'Sem contas';
                    });
                    self._scanProgress.running = false;
                    self.render();
                    return;
                }

                var merged = {};

                function mergeAccountMap(accountId, map) {
                    for (var pid in map) {
                        if (!map.hasOwnProperty(pid)) continue;
                        if (!merged[pid]) merged[pid] = { totalActiveAds: 0, accounts: {} };
                        merged[pid].totalActiveAds += (map[pid].count || 0);
                        merged[pid].accounts[String(accountId)] = map[pid];
                    }
                }

                var tasks = accs.map(function(a) {
                    return function() {
                        if (seq !== self._loadSeq) return Promise.resolve();

                        // If user left Pages view, stop updating UI (but still resolve quickly)
                        try {
                            var view = document.getElementById('view-pages');
                            if (view && view.classList.contains('hidden')) {
                                return Promise.resolve();
                            }
                        } catch (e0) {}

                        return self._scanAdsForAccountCached(a.id, a.profileToken)
                            .then(function(res) {
                                mergeAccountMap(a.id, (res && res.map) ? res.map : {});

                                self._scanProgress.done += 1;
                                self._scanProgress.lastUpdateAt = Date.now();

                                // progressive UI update: update counts but keep loading flag true
                                self._pageUsage = merged;
                                for (var j = 0; j < (self.pages || []).length; j++) {
                                    var p = self.pages[j];
                                    var u = merged[String(p.id)];
                                    p._adsLinkedCount = u ? (u.totalActiveAds || 0) : 0;
                                }
                                self.render();
                            })
                            .catch(function(err) {
                                self._scanProgress.done += 1;
                                self._scanProgress.lastUpdateAt = Date.now();
                                if (window.logger) window.logger.warn('Falha ao escanear conta', { account: a.id, error: String(err) });
                            });
                    };
                });

                // lower concurrency to avoid rate limit
                return self._runPool(tasks, 2)
                    .then(function() {
                        if (seq !== self._loadSeq) return;

                        self._pageUsage = merged;
                        (self.pages || []).forEach(function(p) {
                            var u = merged[String(p.id)];
                            p._adsLinkedCount = u ? (u.totalActiveAds || 0) : 0;
                            p._adsLinkedLoading = false;
                            p._adsLinkedError = null;
                        });

                        self._scanProgress.running = false;
                        self.render();
                    })
                    .catch(function(err2) {
                        if (window.logger) window.logger.error('Falha geral no scan de contas', { error: String(err2) });
                        self._finalizeLoadingAllPages('Falha ao escanear contas');
                        self.render();
                    });
            })
            .catch(function(err) {
                if (window.logger) window.logger.error('Falha ao obter contas para scan', { error: String(err) });
                self._finalizeLoadingAllPages('Falha ao obter contas');
                self.render();
            });
    },

    _scanAdsForAccountCached: function(accId, token) {
        var key = this._scanCacheKey + ':' + String(accId);
        try {
            var raw = localStorage.getItem(key);
            if (raw) {
                var obj = JSON.parse(raw);
                if (obj && obj.ts && obj.map && (Date.now() - obj.ts) < this._scanCacheTtlMs) {
                    return Promise.resolve({ map: obj.map, cached: true });
                }
            }
        } catch (e) {}

        var self = this;
        return this._scanAdsForAccount(accId, token).then(function(res) {
            try {
                localStorage.setItem(key, JSON.stringify({ ts: Date.now(), map: res.map || {} }));
            } catch (e2) {}
            return res;
        });
    },

    _scanAdsForAccount: function(accId, token) {
        // ACTIVE-only scan (massive performance improvement)
        // Note: effective_status expects JSON array string.
        return window.fbApi.fetchAllPath('/' + accId + '/ads', {
            fields: 'id,status,effective_status,campaign_id,adset_id,creative{object_story_spec}',
            effective_status: JSON.stringify(['ACTIVE']),
            limit: 200,
            access_token: token
        })
            .then(function(ads) {
                var map = {};
                (ads || []).forEach(function(ad) {
                    var st = String(ad.effective_status || ad.status || '');
                    if (st !== 'ACTIVE') return;

                    var pid = (ad.creative && ad.creative.object_story_spec) ? ad.creative.object_story_spec.page_id : null;
                    if (!pid) return;
                    pid = String(pid);

                    if (!map[pid]) map[pid] = { count: 0, campaigns: {}, adsets: {} };
                    map[pid].count++;

                    if (ad.campaign_id) {
                        var cid = String(ad.campaign_id);
                        map[pid].campaigns[cid] = (map[pid].campaigns[cid] || 0) + 1;
                    }
                    if (ad.adset_id) {
                        var aid = String(ad.adset_id);
                        map[pid].adsets[aid] = (map[pid].adsets[aid] || 0) + 1;
                    }
                });
                return { map: map };
            })
            .catch(function(err) {
                // If ads endpoint fails, do not block whole scan
                return { map: {} };
            });
    },

    _getAdAccountsForUsage: function() {
        // Prefer accounts already loaded by Ads Manager
        if (window.adsManager && window.adsManager.accounts && window.adsManager.accounts.length) {
            return Promise.resolve(window.adsManager.accounts);
        }

        var profs = window.profilesManager ? window.profilesManager.profiles : [];
        if (!profs.length) return Promise.resolve([]);
        if (!window.fbApi) return Promise.resolve([]);

        var all = [];
        var tasks = profs.map(function(p) {
            return window.fbApi.getAdAccounts(p.token)
                .then(function(as) {
                    (as || []).forEach(function(a) {
                        a.profileToken = p.token;
                        all.push(a);
                    });
                })
                .catch(function() {});
        });

        return Promise.all(tasks).then(function() { return all; });
    },

    _runPool: function(fns, max) {
        var idx = 0;
        function next() {
            if (idx >= fns.length) return Promise.resolve();
            return Promise.resolve().then(fns[idx++]).then(next);
        }
        var w = [];
        for (var i = 0; i < Math.min(max || 2, fns.length); i++) w.push(next());
        return Promise.all(w);
    },

    // =====================
    // Rendering
    // =====================
    render: function() {
        var container = document.getElementById('pages-container');
        if (!container) return;

        var meta = this._getFilteredMeta();
        this._syncPaginationUI(meta);

        if (!meta.totalItems) {
            if (!this.pages.length) container.innerHTML = this._renderEmpty();
            else container.innerHTML = '<div class="py-24 text-center"><i class="fas fa-search text-gray-600 text-4xl mb-4"></i><p class="text-gray-400">Nenhuma página encontrada para a busca.</p></div>';
            return;
        }

        if (this.viewMode === 'list') this._renderList(container, meta.slice);
        else this._renderGrid(container, meta.slice);
    },

    _renderEmpty: function() {
        // Diagnostics block if we had profiles but got zero pages
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
            '<p class="text-gray-400">Nenhuma página conectada.</p>' +
            diag +
            '</div>';
    },

    _renderGrid: function(container, list) {
        var self = this;
        var html = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">';

        (list || []).forEach(function(p) {
            var pic = (p.picture && p.picture.data) ? p.picture.data.url : '';
            var fans = p.fan_count ? new Intl.NumberFormat('pt-BR', { notation: 'compact' }).format(p.fan_count) : '—';
            var used = p._adsLinkedCount || 0;
            var loading = !!p._adsLinkedLoading;

            var limit = p._limitKnown ? p._limitValue : 0;
            var pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
            var color = pct > 90 ? 'bg-red-500' : (pct > 70 ? 'bg-yellow-500' : 'bg-emerald-500');
            if (limit === 0) color = 'bg-blue-500';

            html += '' +
                '<div class="group bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-3xl overflow-hidden transition-all duration-300 hover:shadow-xl hover:-translate-y-1">' +
                '  <div class="h-24 bg-gradient-to-r from-blue-900/40 to-purple-900/40 relative">' +
                '    <div class="absolute inset-0 bg-[url(\'https://www.transparenttextures.com/patterns/cubes.png\')] opacity-10"></div>' +
                '    <div class="absolute -bottom-10 left-6">' +
                '      <img src="' + (pic || 'https://via.placeholder.com/80') + '" class="w-20 h-20 rounded-2xl border-4 border-gray-900 bg-gray-800 object-cover shadow-lg">' +
                '    </div>' +
                '    <div class="absolute top-4 right-4">' +
                '      <span class="px-2.5 py-1 rounded-lg bg-gray-900/80 backdrop-blur text-xs font-semibold text-gray-300 border border-gray-700 shadow-sm">' + self._esc(p.category || 'Página') + '</span>' +
                '    </div>' +
                '  </div>' +
                '  <div class="pt-12 px-6 pb-6">' +
                '    <div class="mb-4">' +
                '      <h4 class="text-lg font-bold text-white truncate leading-tight" title="' + self._esc(p.name) + '">' + self._esc(p.name) + '</h4>' +
                '      <div class="flex items-center gap-2 mt-1">' +
                '        <span class="text-xs text-gray-500 flex items-center gap-1"><i class="fab fa-facebook"></i> ' + self._esc(p.profileName) + '</span>' +
                '        <span class="text-gray-700">•</span>' +
                '        <span class="text-xs text-gray-400">' + fans + ' fãs</span>' +
                '      </div>' +
                '    </div>' +
                '    <div class="bg-gray-800/40 rounded-2xl p-4 border border-gray-700/50 mb-5">' +
                '      <div class="flex justify-between items-end mb-2">' +
                '        <div>' +
                '          <p class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Ads Ativos</p>' +
                '          <div class="text-2xl font-bold text-white flex items-center gap-2">' +
                '            <span>' + self._esc(String(used)) + '</span>' +
                (loading ? '            <i class="fas fa-circle-notch fa-spin text-xs text-blue-400"></i>' : '') +
                '            <span class="text-sm font-normal text-gray-600">/ ' + (limit > 0 ? limit : '∞') + '</span>' +
                '          </div>' +
                '        </div>' +
                '        <div class="text-right">' +
                '          <p class="text-[10px] text-gray-500 mb-1">Uso</p>' +
                '          <p class="text-sm font-bold text-gray-300">' + (limit > 0 ? pct.toFixed(0) + '%' : '—') + '</p>' +
                '        </div>' +
                '      </div>' +
                '      <div class="w-full bg-gray-700/50 rounded-full h-1.5 overflow-hidden">' +
                '        <div class="' + color + ' h-full rounded-full transition-all duration-700" style="width: ' + (limit > 0 ? (pct + '%') : (used > 0 ? '15%' : '0%')) + '"></div>' +
                '      </div>' +
                '    </div>' +
                '    <div class="flex items-center justify-between">' +
                '      <div class="text-xs font-mono text-gray-600 truncate max-w-[120px]">' + self._esc(p.id) + '</div>' +
                '      <button onclick="pagesManager.openDetails(\'' + self._esc(p.id) + '\')" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-xs font-semibold rounded-xl transition-all border border-gray-700 hover:border-gray-500 flex items-center gap-2 shadow-sm">' +
                '        <i class="fas fa-chart-pie"></i> Detalhes' +
                '      </button>' +
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
        html += '<div class="col-span-5 pl-2">Página</div><div class="col-span-2">Perfil</div><div class="col-span-2">Ads Ativos</div><div class="col-span-3 text-right pr-2">Ações</div></div>';
        html += '<div class="divide-y divide-gray-800">';

        (list || []).forEach(function(p) {
            var pic = (p.picture && p.picture.data) ? p.picture.data.url : '';
            var used = p._adsLinkedCount || 0;
            html += '' +
                '<div class="grid grid-cols-12 gap-4 p-4 items-center hover:bg-gray-800/30 transition-colors group">' +
                '  <div class="col-span-5 flex items-center gap-3 pl-2">' +
                '    <img src="' + (pic || 'https://via.placeholder.com/40') + '" class="w-10 h-10 rounded-xl bg-gray-800 object-cover shadow-sm">' +
                '    <div class="min-w-0">' +
                '      <p class="text-sm font-bold text-white truncate group-hover:text-blue-300 transition-colors">' + self._esc(p.name) + '</p>' +
                '      <p class="text-xs text-gray-500 font-mono truncate">' + self._esc(p.id) + '</p>' +
                '    </div>' +
                '  </div>' +
                '  <div class="col-span-2 text-sm text-gray-400 truncate">' + self._esc(p.profileName) + '</div>' +
                '  <div class="col-span-2">' +
                '    <span class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-white text-xs font-bold">' +
                '      <span>' + (p._adsLinkedLoading ? String(used) : String(used)) + '</span>' +
                (p._adsLinkedLoading ? '<i class="fas fa-circle-notch fa-spin text-[10px] text-blue-400"></i>' : '') +
                '    </span>' +
                '  </div>' +
                '  <div class="col-span-3 flex justify-end pr-2">' +
                '    <button onclick="pagesManager.openDetails(\'' + self._esc(p.id) + '\')" class="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors" title="Detalhes"><i class="fas fa-eye"></i></button>' +
                '  </div>' +
                '</div>';
        });

        html += '</div></div>';
        container.innerHTML = html;
    },

    // =====================
    // Modal Details
    // =====================
    openDetails: function(pageId) {
        var p = null;
        for (var i = 0; i < (this.pages || []).length; i++) {
            if (String(this.pages[i].id) === String(pageId)) { p = this.pages[i]; break; }
        }
        if (!p) return;

        var m = document.getElementById('modal-page-details');
        if (m) m.classList.remove('hidden');

        var t = document.getElementById('page-details-title');
        var s = document.getElementById('page-details-subtitle');
        if (t) t.textContent = p.name;
        if (s) s.textContent = 'ID: ' + p.id;

        this._renderDetailsBody(pageId);
        this._loadCampaignNames(pageId);
    },

    closeDetails: function() {
        var m = document.getElementById('modal-page-details');
        if (m) m.classList.add('hidden');
    },

    _renderDetailsBody: function(pid) {
        var b = document.getElementById('page-details-body');
        if (!b) return;

        var u = this._pageUsage[String(pid)] || { totalActiveAds: 0, accounts: {} };
        var accs = Object.keys(u.accounts || {});

        var html = '' +
            '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">' +
            '  <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700/50">' +
            '    <p class="text-xs text-gray-500 uppercase tracking-wide font-bold">Ads Ativos</p>' +
            '    <p class="text-2xl font-bold text-white mt-1">' + (u.totalActiveAds || 0) + '</p>' +
            '  </div>' +
            '  <div class="bg-gray-800/50 p-4 rounded-2xl border border-gray-700/50">' +
            '    <p class="text-xs text-gray-500 uppercase tracking-wide font-bold">Contas</p>' +
            '    <p class="text-2xl font-bold text-white mt-1">' + accs.length + '</p>' +
            '  </div>' +
            '</div>' +
            '<h4 class="text-sm font-bold text-white mb-4 flex items-center gap-2"><i class="fas fa-list"></i> Detalhamento por Conta</h4>';

        if (!accs.length) {
            html += '<p class="text-sm text-gray-500">Nenhum anúncio ativo encontrado.</p>';
            b.innerHTML = html;
            return;
        }

        html += '<div class="space-y-3">';

        for (var i = 0; i < accs.length; i++) {
            var aid = accs[i];
            var info = u.accounts[aid];
            var accObj = this._accountsIndex[String(aid)] || {};
            var cids = Object.keys((info && info.campaigns) ? info.campaigns : {});

            html += '' +
                '<details class="group bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden open:border-gray-700 transition-colors">' +
                '  <summary class="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-800/50 select-none">' +
                '    <div class="flex items-center gap-3 overflow-hidden">' +
                '      <div class="w-8 h-8 rounded-lg bg-blue-900/20 text-blue-400 flex items-center justify-center font-bold text-xs border border-blue-500/20">' + this._esc((accObj.name || 'C').charAt(0)) + '</div>' +
                '      <div class="min-w-0">' +
                '        <p class="text-sm font-bold text-white truncate">' + this._esc(accObj.name || aid) + '</p>' +
                '        <p class="text-xs text-gray-500 font-mono">ID: ' + this._esc(aid) + '</p>' +
                '      </div>' +
                '    </div>' +
                '    <div class="flex items-center gap-3">' +
                '      <span class="px-2 py-1 rounded bg-gray-800 text-gray-300 text-xs font-bold border border-gray-700">' + (info && info.count ? info.count : 0) + ' ads</span>' +
                '      <i class="fas fa-chevron-down text-gray-500 group-open:rotate-180 transition-transform"></i>' +
                '    </div>' +
                '  </summary>' +
                '  <div class="p-4 border-t border-gray-800 bg-gray-900/50 grid grid-cols-1 md:grid-cols-2 gap-2">';

            for (var j = 0; j < cids.length; j++) {
                var cid = cids[j];
                var cn = this._nameCache.campaign[cid];
                html += '' +
                    '<div class="flex justify-between items-center p-2 rounded-lg bg-gray-800/50 border border-gray-700/30">' +
                    '  <div class="min-w-0 overflow-hidden">' +
                    '    <p class="text-xs text-gray-300 font-medium truncate" title="' + this._esc(cn || cid) + '">' + this._esc(cn || ('Campanha ' + cid)) + '</p>' +
                    '    <p class="text-[10px] text-gray-600 font-mono truncate">' + this._esc(cid) + '</p>' +
                    '  </div>' +
                    '  <span class="text-xs font-bold text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">' + info.campaigns[cid] + '</span>' +
                    '</div>';
            }

            html += '  </div></details>';
        }

        html += '</div>';
        b.innerHTML = html;
    },

    _loadCampaignNames: function(pid) {
        var self = this;
        var u = this._pageUsage[String(pid)];
        if (!u) return;

        var tasks = [];
        Object.keys(u.accounts || {}).forEach(function(aid) {
            var token = (self._accountsIndex[String(aid)] || {}).profileToken;
            if (!token || !window.fbApi || typeof window.fbApi.call !== 'function') return;

            Object.keys((u.accounts[aid] && u.accounts[aid].campaigns) ? u.accounts[aid].campaigns : {}).forEach(function(cid) {
                if (self._nameCache.campaign[cid]) return;
                tasks.push(function() {
                    return window.fbApi.call('/' + cid, { fields: 'name', access_token: token })
                        .then(function(r) {
                            if (r && r.name) self._nameCache.campaign[cid] = r.name;
                        })
                        .catch(function() {});
                });
            });
        });

        this._runPool(tasks, 4).then(function() { self._renderDetailsBody(pid); });
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
