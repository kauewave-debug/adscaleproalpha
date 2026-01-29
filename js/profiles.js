/**
 * Profiles Manager Module
 * Handles Facebook profile management (add, remove, list)
 * Version: 3.1 - Ultra Modern UI
 */
console.log('[profilesManager] Loaded v3.1 (Modern UI)');
var profilesManager = {
    profiles: [],
    _syncInFlight: {},
    _tokenModalProfileId: null,

    init: function() {
        this.loadProfiles();

        // Apply proxy routing for loaded profiles
        this._applyProxiesToFbApi();

        this.renderProfilesList();
        this.backgroundSyncProfiles();
        if (window.logger) window.logger.info('Profiles Manager initialized (v3.1)');
    },

    _applyProxiesToFbApi: function() {
        try {
            if (!window.fbApi || typeof window.fbApi.setProxyForToken !== 'function') return;
            for (var i = 0; i < this.profiles.length; i++) {
                var p = this.profiles[i];
                if (p && p.token && p.proxy) {
                    window.fbApi.setProxyForToken(p.token, p.proxy);
                }
            }
        } catch (e) {}
    },

    loadProfiles: function() {
        var stored = localStorage.getItem('fb_profiles');
        if (stored) {
            try { this.profiles = JSON.parse(stored); } catch (e) { this.profiles = []; }
        } else {
            this.profiles = [];
        }
        // Defaults
        for (var i = 0; i < this.profiles.length; i++) {
            var p = this.profiles[i];
            if (!p.addedAt) p.addedAt = new Date().toISOString();
            if (!p.status) p.status = 'active';
            if (!p.meta) p.meta = {};
        }
    },

    saveProfiles: function() {
        localStorage.setItem('fb_profiles', JSON.stringify(this.profiles));
        window.dispatchEvent(new CustomEvent('profilesUpdated', { detail: this.profiles }));
    },

    _findProfile: function(id) {
        for (var i = 0; i < this.profiles.length; i++) {
            if (this.profiles[i].id === id) return this.profiles[i];
        }
        return null;
    },

    backgroundSyncProfiles: function() {
        var self = this;
        if (!window.fbApi || typeof window.fbApi.call !== 'function') return;
        var now = Date.now();
        for (var i = 0; i < this.profiles.length; i++) {
            (function(p) {
                var last = p.meta && p.meta.lastSyncAt ? Date.parse(p.meta.lastSyncAt) : 0;
                if (!last || (now - last) > 12 * 60 * 60 * 1000) {
                    setTimeout(function() { self.syncProfileMeta(p.id, { silent: true }); }, 150 + i * 120);
                }
            })(this.profiles[i]);
        }
    },

    syncProfileMeta: function(profileId, opts) {
        var self = this;
        opts = opts || {};
        var p = this._findProfile(profileId);
        if (!p || !p.token || !window.fbApi) return Promise.resolve();
        if (this._syncInFlight[profileId]) return this._syncInFlight[profileId];

        function log(type, msg, data) { if (!opts.silent && window.logger) window.logger.log(msg, type, data); }

        var token = p.token;
        if (!p.meta) p.meta = {};
        p.meta.syncing = true;
        self.renderProfilesList();

        var accountsPromise = window.fbApi.getAdAccounts(token)
            .then(function(accs) {
                p.meta.accountsCount = (accs || []).length;
                return p.meta.accountsCount;
            })
            .catch(function(err) {
                p.meta.accountsCount = p.meta.accountsCount || 0;
                log('WARN', 'Falha ao sincronizar contas: ' + p.name, { error: String(err) });
                return 0;
            });

        var permissionsPromise = window.fbApi.call('/me/permissions', { access_token: token })
            .then(function(res) {
                var granted = [];
                var declined = [];
                var data = (res && res.data) ? res.data : [];
                for (var i = 0; i < data.length; i++) {
                    var it = data[i];
                    if (!it || !it.permission) continue;
                    if (it.status === 'granted') granted.push(it.permission); else declined.push(it.permission);
                }
                p.meta.permissionsGranted = granted;
                p.meta.permissionsDeclined = declined;
                return granted;
            })
            .catch(function() {
                p.meta.permissionsGranted = p.meta.permissionsGranted || [];
                return [];
            });

        var expiryPromise = window.fbApi.call('/debug_token', { input_token: token, access_token: token })
            .then(function(res3) {
                var exp = res3 && res3.data ? res3.data.expires_at : null;
                if (exp) p.meta.tokenExpiresAt = new Date(exp * 1000).toISOString();
                else p.meta.tokenExpiresAt = null;
                return p.meta.tokenExpiresAt;
            })
            .catch(function() { return null; });

        var promise = Promise.all([accountsPromise, permissionsPromise, expiryPromise])
            .then(function() {
                p.meta.lastSyncAt = new Date().toISOString();
                p.meta.syncing = false;
                self.saveProfiles();
                self.renderProfilesList();
                return true;
            })
            .catch(function(err) {
                p.meta.syncing = false;
                self.saveProfiles();
                self.renderProfilesList();
                log('ERROR', 'Erro sync perfil', { error: String(err) });
                return false;
            })
            .finally(function() { delete self._syncInFlight[profileId]; });

        this._syncInFlight[profileId] = promise;
        return promise;
    },

    addProfile: function(profileData, token) {
        var exists = false;
        for (var i = 0; i < this.profiles.length; i++) {
            if (this.profiles[i].id === profileData.id) { exists = true; break; }
        }
        if (exists) { alert('Este perfil já foi adicionado.'); return false; }

        var pictureUrl = null;
        if (profileData.picture && profileData.picture.data && profileData.picture.data.url) pictureUrl = profileData.picture.data.url;

        var newProfile = {
            id: profileData.id,
            name: profileData.name,
            email: profileData.email || '',
            picture: pictureUrl,
            token: token,
            addedAt: new Date().toISOString(),
            status: 'active',
            meta: { accountsCount: 0, lastSyncAt: null, tokenExpiresAt: null, permissionsGranted: [], permissionsDeclined: [], syncing: false }
        };

        this.profiles.push(newProfile);
        this.saveProfiles();
        this.renderProfilesList();
        this.syncProfileMeta(newProfile.id, { silent: true });
        if (window.logger) window.logger.success('Perfil adicionado: ' + newProfile.name);
        return true;
    },

    removeProfile: function(id) {
        if (!confirm('Tem certeza que deseja remover este perfil?')) return;
        var next = [];
        for (var i = 0; i < this.profiles.length; i++) {
            if (this.profiles[i].id !== id) next.push(this.profiles[i]);
        }
        this.profiles = next;
        this.saveProfiles();
        this.renderProfilesList();
        if (window.logger) window.logger.info('Perfil removido');
    },

    extractToken: function(raw) {
        if (!raw) return '';
        var text = String(raw).trim();
        var m = text.match(/access_token=([^&\s]+)/i);
        if (m && m[1]) { try { return decodeURIComponent(m[1]).trim(); } catch (e) { return m[1].trim(); } }
        var m2 = text.match(/EA[A-Za-z0-9]{20,}/);
        if (m2 && m2[0]) return m2[0].trim();
        return text.replace(/\s+/g, '');
    },

    handleTokenSubmit: function() {
        var self = this;
        var tokenInput = document.getElementById('input-token');
        var raw = tokenInput ? tokenInput.value : '';
        var token = this.extractToken(raw);
        var btn = document.getElementById('btn-add-token');

        // Proxy (optional)
        var proxyInput = document.getElementById('input-proxy');
        var proxy = proxyInput ? String(proxyInput.value || '').trim() : '';

        if (!token || token.length < 40) { alert('Token inválido.'); return; }
        if (!window.fbApi) { alert('API não carregada.'); return; }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Validando...';

        window.fbApi.validateToken(token)
            .then(function(pd) {
                var ok = self.addProfile(pd, token);
                if (ok) {
                    // Persist proxy on the profile (by id) + set proxy routing in fbApi
                    if (proxy) {
                        try {
                            var p = self._findProfile(pd.id);
                            if (p) {
                                p.proxy = proxy;
                                self.saveProfiles();
                            }
                            if (window.fbApi && typeof window.fbApi.setProxyForToken === 'function') {
                                window.fbApi.setProxyForToken(token, proxy);
                            }
                        } catch (e) {}
                    }

                    self.closeModal();
                    if (tokenInput) tokenInput.value = '';
                    if (proxyInput) proxyInput.value = '';
                }
            })
            .catch(function(err) { alert('Erro: ' + (err.message || err)); })
            .finally(function() { btn.disabled = false; btn.innerHTML = 'Adicionar Perfil'; });
    },

    // Modals
    openModal: function() { document.getElementById('modal-add-profile').classList.remove('hidden'); },
    closeModal: function() { document.getElementById('modal-add-profile').classList.add('hidden'); },

    openTokenModal: function(profileId) {
        var p = this._findProfile(profileId);
        if (!p) return;
        this._tokenModalProfileId = profileId;
        var m = document.getElementById('modal-edit-token');
        if (m) m.classList.remove('hidden');
        var sub = document.getElementById('edit-token-subtitle');
        var cur = document.getElementById('edit-token-current');
        var inp = document.getElementById('edit-token-input');
        var st = document.getElementById('edit-token-status');
        if (sub) sub.textContent = p.name;
        if (cur) cur.textContent = this._maskToken(p.token);
        if (inp) inp.value = '';
        if (st) st.classList.add('hidden');
    },
    closeTokenModal: function() {
        document.getElementById('modal-edit-token').classList.add('hidden');
        this._tokenModalProfileId = null;
    },
    _maskToken: function(t) { return t ? (t.slice(0,8) + '••••••••' + t.slice(-6)) : ''; },

    // Proxy modal
    _proxyModalProfileId: null,
    openProxyModal: function(profileId) {
        var p = this._findProfile(profileId);
        if (!p) return;
        this._proxyModalProfileId = profileId;
        var m = document.getElementById('modal-proxy');
        if (m) m.classList.remove('hidden');
        var sub = document.getElementById('proxy-subtitle');
        var inp = document.getElementById('proxy-input');
        if (sub) sub.textContent = p.name;
        if (inp) inp.value = p.proxy || '';
    },
    closeProxyModal: function() {
        var m = document.getElementById('modal-proxy');
        if (m) m.classList.add('hidden');
        this._proxyModalProfileId = null;
    },
    saveProxyFromModal: function() {
        var p = this._findProfile(this._proxyModalProfileId);
        if (!p) return;
        var inp = document.getElementById('proxy-input');
        var proxy = inp ? String(inp.value || '').trim() : '';

        p.proxy = proxy;
        this.saveProfiles();
        this._applyProxiesToFbApi();
        this.renderProfilesList();

        if (window.logger) window.logger.success('Proxy atualizado', { profile: p.name, hasProxy: !!proxy });
        this.closeProxyModal();
    },
    clearProxyFromModal: function() {
        var p = this._findProfile(this._proxyModalProfileId);
        if (!p) return;
        p.proxy = '';
        this.saveProfiles();
        if (window.fbApi && typeof window.fbApi.clearProxyForToken === 'function') {
            window.fbApi.clearProxyForToken(p.token);
        }
        this.renderProfilesList();
        if (window.logger) window.logger.info('Proxy removido', { profile: p.name });
        this.closeProxyModal();
    },
    
    copyCurrentTokenFromModal: function() {
        var p = this._findProfile(this._tokenModalProfileId);
        if (!p) return;
        navigator.clipboard.writeText(p.token).then(() => alert('Copiado!')).catch(() => alert('Erro ao copiar'));
    },

    saveTokenFromModal: function() {
        var self = this;
        var p = this._findProfile(this._tokenModalProfileId);
        if (!p) return;
        var inp = document.getElementById('edit-token-input');
        var token = this.extractToken(inp.value);
        if (!token) { self.syncProfileMeta(p.id); return; } // Just sync if empty

        var btn = document.getElementById('btn-save-token');
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-spin fa-circle-notch"></i> Salvando...';

        window.fbApi.validateToken(token).then(function(pd) {
            if (String(pd.id) !== String(p.id)) throw new Error('Token pertence a outro usuário.');

            // If there is proxy configured, move proxy binding to new token
            var proxy = p.proxy || '';
            if (window.fbApi && typeof window.fbApi.clearProxyForToken === 'function') {
                window.fbApi.clearProxyForToken(p.token);
            }

            p.token = token;
            self.saveProfiles();

            if (proxy && window.fbApi && typeof window.fbApi.setProxyForToken === 'function') {
                window.fbApi.setProxyForToken(token, proxy);
            }

            self.renderProfilesList();
            return self.syncProfileMeta(p.id);
        }).then(function() {
            alert('Token atualizado e sincronizado!');
            self.closeTokenModal();
        }).catch(function(e) {
            alert('Erro: ' + e.message);
        }).finally(function() {
            btn.disabled = false; btn.innerHTML = 'Salvar e Sincronizar';
        });
    },

    // Rendering
    renderProfilesList: function() {
        var container = document.getElementById('profiles-list');
        if (!container) return;
        container.innerHTML = '';

        if (this.profiles.length === 0) {
            container.innerHTML = '<div class="col-span-full py-20 text-center text-gray-500 bg-gray-900/30 border border-dashed border-gray-800 rounded-3xl"><i class="fab fa-facebook text-5xl mb-4 opacity-20"></i><p>Nenhum perfil conectado</p><button onclick="profilesManager.openModal()" class="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all">Conectar Agora</button></div>';
            return;
        }

        for (var i = 0; i < this.profiles.length; i++) {
            var p = this.profiles[i];
            var m = p.meta || {};
            var syncing = m.syncing;
            
            var card = document.createElement('div');
            card.className = 'group relative bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-3xl p-6 transition-all duration-300 hover:shadow-2xl hover:shadow-blue-900/10 hover:-translate-y-1';
            
            var img = p.picture ? '<img src="'+this._esc(p.picture)+'" class="w-16 h-16 rounded-2xl object-cover shadow-lg">' 
                                : '<div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg">'+p.name.charAt(0)+'</div>';

            var statusDot = '<span class="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"></span>';
            if (syncing) statusDot = '<span class="w-2.5 h-2.5 rounded-full bg-blue-500 animate-ping"></span>';

            var perms = m.permissionsGranted || [];
            var permsBadge = perms.length > 0 
                ? '<span class="px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-semibold border border-emerald-500/20">'+perms.length+' permissões</span>' 
                : '<span class="px-2 py-1 rounded-lg bg-gray-800 text-gray-500 text-xs border border-gray-700">Sem dados</span>';

            card.innerHTML = `
                <div class="flex items-start justify-between mb-6">
                    <div class="flex gap-4">
                        ${img}
                        <div>
                            <h3 class="text-lg font-bold text-white leading-tight">${this._esc(p.name)}</h3>
                            <p class="text-xs text-gray-500 font-mono mt-1 mb-2">ID: ${this._esc(p.id)}</p>
                            <div class="flex items-center gap-2">
                                ${statusDot}
                                <span class="text-xs font-medium ${syncing ? 'text-blue-400' : 'text-green-400'}">${syncing ? 'Sincronizando...' : 'Ativo'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="profilesManager.syncProfileMeta('${p.id}')" class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-blue-600 hover:text-white text-gray-400 flex items-center justify-center transition-colors" title="Sincronizar">
                            <i class="fas fa-sync-alt ${syncing ? 'fa-spin' : ''}"></i>
                        </button>
                        <button onclick="profilesManager.openProxyModal('${p.id}')" class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-indigo-600 hover:text-white text-gray-400 flex items-center justify-center transition-colors" title="Configurar Proxy">
                            <i class="fas fa-globe-americas"></i>
                        </button>
                        <button onclick="profilesManager.openTokenModal('${p.id}')" class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-yellow-600 hover:text-white text-gray-400 flex items-center justify-center transition-colors" title="Editar Token">
                            <i class="fas fa-key"></i>
                        </button>
                        <button onclick="profilesManager.removeProfile('${p.id}')" class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-red-600 hover:text-white text-gray-400 flex items-center justify-center transition-colors" title="Remover">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div class="p-3 rounded-2xl bg-gray-800/50 border border-gray-700/50">
                        <div class="text-xs text-gray-500 mb-1">Contas de Anúncio</div>
                        <div class="text-xl font-bold text-white">${m.accountsCount || 0}</div>
                    </div>
                    <div class="p-3 rounded-2xl bg-gray-800/50 border border-gray-700/50">
                        <div class="text-xs text-gray-500 mb-1">Validade Token</div>
                        <div class="text-xs font-medium text-gray-300 truncate" title="${m.tokenExpiresAt || ''}">${m.tokenExpiresAt ? new Date(m.tokenExpiresAt).toLocaleDateString() : 'Desconhecido'}</div>
                    </div>
                </div>

                <div class="flex items-center justify-between pt-4 border-t border-gray-800">
                    <div class="flex items-center gap-2">
                        <i class="fas fa-shield-halved text-gray-600"></i>
                        ${permsBadge}
                    </div>
                    <div class="text-xs text-gray-600">
                        Add: ${new Date(p.addedAt).toLocaleDateString()}
                    </div>
                </div>
            `;
            container.appendChild(card);
        }
    },

    _esc: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
};

window.profilesManager = profilesManager;
