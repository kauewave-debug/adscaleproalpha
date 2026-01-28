/**
 * Rules Manager Module
 * Handles automated rules creation and execution
 * Version: 3.4 - Metrics synced with Ads columns + campaign scope + date preset + scheduler (while app open)
 */
var rulesManager = {
    rules: [],
    isInitialized: false,

    // Scheduler runtime
    _schedulerTimer: null,
    _inFlight: {},

    // Global scheduler pause
    _schedulerPausedKey: 'rules_scheduler_paused_v1',
    schedulerPaused: false,

    // ==========
    // Lifecycle
    // ==========
    init: function() {
        if (this.isInitialized) {
            this.renderRulesList();
            this._startScheduler();
            return;
        }
        this.isInitialized = true;
        this._loadSchedulerPaused();
        this.loadRules();
        this.renderRulesList();
        this._syncSchedulerUI();
        this._startScheduler();
        if (window.logger) window.logger.info('Rules Manager initialized (v3.4)');
    },

    loadRules: function() {
        var stored = localStorage.getItem('fb_rules');
        if (stored) {
            try { this.rules = JSON.parse(stored) || []; } catch (e) { this.rules = []; }
        } else {
            this.rules = [];
        }

        // Backward-compat defaults
        for (var i = 0; i < this.rules.length; i++) {
            var r = this.rules[i];
            if (!r.campaignScope) r.campaignScope = 'ALL';
            if (!r.datePreset) r.datePreset = 'today';
            if (!r.schedule) r.schedule = { mode: 'ALWAYS', intervalMin: 5 };
            if (!r.schedule.mode) r.schedule.mode = 'ALWAYS';
            if (!r.schedule.intervalMin) r.schedule.intervalMin = 5;
            if (!r.meta) r.meta = {};
        }
    },

    saveRules: function() {
        localStorage.setItem('fb_rules', JSON.stringify(this.rules));
        this.renderRulesList();
        this._syncSchedulerUI();
    },

    _loadSchedulerPaused: function() {
        try {
            var raw = localStorage.getItem(this._schedulerPausedKey);
            this.schedulerPaused = raw === '1' || raw === 'true';
        } catch (e) {
            this.schedulerPaused = false;
        }
    },

    _saveSchedulerPaused: function() {
        try {
            localStorage.setItem(this._schedulerPausedKey, this.schedulerPaused ? '1' : '0');
        } catch (e) {}
    },

    toggleSchedulerPaused: function() {
        this.schedulerPaused = !this.schedulerPaused;
        this._saveSchedulerPaused();
        this._syncSchedulerUI();
        this._startScheduler();
        if (window.logger) window.logger.info('Scheduler ' + (this.schedulerPaused ? 'PAUSADO' : 'ATIVO'));
    },

    _syncSchedulerUI: function() {
        // Global chip/button in Rules view
        var btn = document.getElementById('btn-scheduler-toggle');
        var chip = document.getElementById('scheduler-status-chip');

        if (chip) {
            if (this.schedulerPaused) {
                chip.textContent = 'PAUSADO';
                chip.className = 'text-[10px] font-bold px-2 py-1 rounded-lg border border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
            } else {
                chip.textContent = 'ATIVO';
                chip.className = 'text-[10px] font-bold px-2 py-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
            }
        }

        if (btn) {
            if (this.schedulerPaused) {
                btn.innerHTML = '<i class="fas fa-play"></i><span>Retomar Scheduler</span>';
                btn.className = 'px-3 py-2 text-xs font-bold rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors flex items-center gap-2';
            } else {
                btn.innerHTML = '<i class="fas fa-pause"></i><span>Pausar Scheduler</span>';
                btn.className = 'px-3 py-2 text-xs font-bold rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors flex items-center gap-2';
            }
        }
    },

    // =====================
    // Metric catalog (synced)
    // =====================
    getMetricCatalog: function() {
        // Keep aligned with adsManager columns (campaign-level insights)
        return [
            { key: 'spend', label: 'Gasto', format: 'currency', unitLabel: 'Moeda da conta' },
            { key: 'cpr', label: 'Custo por Resultado', format: 'currency', unitLabel: 'Moeda da conta' },
            { key: 'cpc', label: 'CPC', format: 'currency', unitLabel: 'Moeda da conta' },
            { key: 'cpm', label: 'CPM', format: 'currency', unitLabel: 'Moeda da conta' },
            { key: 'ctr', label: 'CTR', format: 'percent', unitLabel: '%' },
            { key: 'ic', label: 'IC (Finalizações de compra iniciadas)', format: 'number', unitLabel: 'Quantidade' },
            { key: 'results', label: 'Resultados', format: 'number', unitLabel: 'Quantidade' },
            { key: 'clicks', label: 'Cliques', format: 'number', unitLabel: 'Quantidade' },
            { key: 'impressions', label: 'Impressões', format: 'number', unitLabel: 'Quantidade' },
            { key: 'reach', label: 'Alcance', format: 'number', unitLabel: 'Quantidade' },
            { key: 'frequency', label: 'Frequência', format: 'number2', unitLabel: 'Média' }
        ];
    },

    _metricMeta: function(key) {
        key = String(key || '');
        var list = this.getMetricCatalog();
        for (var i = 0; i < list.length; i++) {
            if (list[i].key === key) return list[i];
        }
        // Backward compatibility aliases
        if (key === 'cost_per_result') return { key: 'cpr', label: 'Custo por Resultado', format: 'currency', unitLabel: 'Moeda da conta' };
        return { key: key, label: key, format: 'number', unitLabel: '' };
    },

    // ===========================
    // Render list
    // ===========================
    renderRulesList: function() {
        var container = document.getElementById('rules-list');
        if (!container) return;
        container.innerHTML = '';

        if (this.rules.length === 0) {
            container.innerHTML =
                '<div class="col-span-full py-20 text-center text-gray-500 bg-gray-900/30 border border-dashed border-gray-800 rounded-3xl">' +
                '  <div class="w-20 h-20 mx-auto bg-gray-800 rounded-full flex items-center justify-center mb-4">' +
                '    <i class="fas fa-robot text-4xl text-purple-500/50"></i>' +
                '  </div>' +
                '  <h3 class="text-lg font-medium text-white mb-1">Nenhuma regra ativa</h3>' +
                '  <p class="mb-6 text-sm">Automatize suas campanhas para economizar tempo.</p>' +
                '  <button onclick="rulesManager.openEditor()" class="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-purple-900/20">' +
                '    <i class="fas fa-plus mr-2"></i>Criar Nova Regra' +
                '  </button>' +
                '</div>';
            return;
        }

        for (var i = 0; i < this.rules.length; i++) {
            var rule = this.rules[i];
            var active = !!rule.active;
            var conds = rule.conditions || [];
            var logicBadge = rule.logic === 'OR' ? 'OU (Qualquer)' : 'E (Todas)';
            var accCount = (rule.accountIds || []).length;
            var lastRun = rule.lastRun ? new Date(rule.lastRun).toLocaleString('pt-BR') : 'Nunca';
            var scope = rule.campaignScope || 'ALL';
            var scopeLabel = scope === 'ACTIVE' ? 'Somente ATIVAS' : (scope === 'PAUSED' ? 'Somente PAUSADAS' : 'Todas');

            var dp = String(rule.datePreset || 'today');
            var dpLabel = this._datePresetLabel(dp);

            var sched = rule.schedule || { mode: 'ALWAYS', intervalMin: 5 };
            var schedLabel = this._scheduleLabel(sched);
            var nextRunLabel = this._nextRunLabel(rule);

            var actionType = rule.action ? rule.action.type : 'UNKNOWN';
            var actionColor = actionType === 'PAUSE'
                ? 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20'
                : 'text-green-400 bg-green-400/10 border-green-400/20';
            var actionIcon = actionType === 'PAUSE' ? 'fa-pause' : 'fa-play';
            var actionLabel = actionType === 'PAUSE' ? 'PAUSAR Campanha' : 'ATIVAR Campanha';

            var card = document.createElement('div');
            card.className = 'group relative flex flex-col bg-gray-900 border ' + (active ? 'border-gray-700' : 'border-gray-800 opacity-75') + ' hover:border-purple-500/50 rounded-3xl p-6 transition-all duration-300 hover:shadow-xl hover:shadow-purple-900/5';

            card.innerHTML =
                '<div class="flex items-start justify-between mb-6">' +
                '  <div class="flex items-center gap-4">' +
                '    <div class="w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900 border border-gray-700 shadow-inner">' +
                '      <i class="fas fa-robot ' + (active ? 'text-purple-400' : 'text-gray-600') + ' text-xl"></i>' +
                '    </div>' +
                '    <div>' +
                '      <h4 class="text-lg font-bold text-white group-hover:text-purple-200 transition-colors">' + this._esc(rule.name) + '</h4>' +
                '      <div class="flex flex-wrap items-center gap-2 mt-1">' +
                '        <span class="text-xs font-mono text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">ID: ' + this._esc(String(rule.id || '').slice(-6)) + '</span>' +
                '        <span class="text-xs text-gray-500">• ' + accCount + ' contas</span>' +
                '        <span class="text-xs text-gray-500">• ' + this._esc(scopeLabel) + '</span>' +
                '      </div>' +
                '      <div class="flex flex-wrap items-center gap-2 mt-2">' +
                '        <span class="text-[10px] text-gray-400 bg-gray-800 px-2 py-1 rounded-full border border-gray-700"><i class="fas fa-calendar mr-1 opacity-70"></i>' + this._esc(dpLabel) + '</span>' +
                '        <span class="text-[10px] text-gray-400 bg-gray-800 px-2 py-1 rounded-full border border-gray-700"><i class="fas fa-clock mr-1 opacity-70"></i>' + this._esc(schedLabel) + '</span>' +
                '        <span class="text-[10px] text-gray-400 bg-gray-800 px-2 py-1 rounded-full border border-gray-700"><i class="fas fa-hourglass-half mr-1 opacity-70"></i>' + this._esc(nextRunLabel) + '</span>' +
                '      </div>' +
                '    </div>' +
                '  </div>' +
                '  <label class="relative inline-flex items-center cursor-pointer" title="Ativar/Desativar Regra">' +
                '    <input type="checkbox" class="sr-only peer" ' + (active ? 'checked' : '') + ' onchange="rulesManager.toggleRuleActive(' + i + ')">' +
                '    <div class="w-11 h-6 bg-gray-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-\'\' after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 peer-checked:after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600 border border-gray-700"></div>' +
                '  </label>' +
                '</div>' +
                '<div class="flex-1 mb-6 relative">' +
                '  <div class="absolute left-6 top-0 bottom-0 w-0.5 bg-gray-800"></div>' +
                '  <div class="relative pl-10 mb-3">' +
                '    <div class="absolute left-[21px] top-2.5 w-3 h-3 bg-gray-800 border-2 border-gray-600 rounded-full z-10"></div>' +
                '    <div class="text-xs text-gray-500 uppercase font-semibold tracking-wider mb-1">Se ' + this._esc(logicBadge) + ':</div>' +
                '    <div class="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50 text-sm text-gray-300 font-mono">' +
                this._renderConds(conds) +
                '    </div>' +
                '  </div>' +
                '  <div class="relative pl-10">' +
                '    <div class="absolute left-[21px] top-2.5 w-3 h-3 bg-gray-800 border-2 border-purple-500 rounded-full z-10"></div>' +
                '    <div class="text-xs text-gray-500 uppercase font-semibold tracking-wider mb-1">Então:</div>' +
                '    <div class="inline-flex items-center gap-2 px-3 py-2 rounded-xl border ' + actionColor + '">' +
                '      <i class="fas ' + actionIcon + '"></i>' +
                '      <span class="font-bold text-xs uppercase tracking-wide">' + actionLabel + '</span>' +
                '    </div>' +
                '  </div>' +
                '</div>' +
                '<div class="flex items-center justify-between pt-4 border-t border-gray-800 mt-auto">' +
                '  <div class="text-xs text-gray-600 flex items-center gap-1.5">' +
                '    <i class="fas fa-clock"></i>' +
                '    <span>' + this._esc(lastRun) + '</span>' +
                '  </div>' +
                '  <div class="flex gap-2">' +
                '    <button onclick="rulesManager.runRuleNow(' + i + ')" class="p-2 rounded-lg bg-gray-800 hover:bg-green-600 hover:text-white text-gray-400 transition-colors" title="Executar Agora">' +
                '      <i class="fas fa-play"></i>' +
                '    </button>' +
                '    <button onclick="rulesManager.deleteRule(' + i + ')" class="p-2 rounded-lg bg-gray-800 hover:bg-red-600 hover:text-white text-gray-400 transition-colors" title="Excluir">' +
                '      <i class="fas fa-trash-alt"></i>' +
                '    </button>' +
                '  </div>' +
                '</div>';

            container.appendChild(card);
        }
    },

    _renderConds: function(conds) {
        if (!conds || !conds.length) return '<span class="text-gray-600 italic">Sem condições...</span>';
        var html = '<ul class="space-y-1">';
        for (var j = 0; j < Math.min(conds.length, 3); j++) {
            var c = conds[j];
            var meta = this._metricMeta(c.metric);
            html += '<li><span class="text-purple-300">' + this._esc(meta.label) + '</span> <span class="text-gray-500">' + this._esc(c.operator) + '</span> <span class="text-white">' + this._esc(String(c.value)) + '</span></li>';
        }
        if (conds.length > 3) html += '<li class="text-xs text-gray-500 italic">+' + (conds.length - 3) + ' outras...</li>';
        html += '</ul>';
        return html;
    },

    _datePresetLabel: function(dp) {
        var map = {
            today: 'Hoje',
            yesterday: 'Ontem',
            last_7d: '7D',
            last_30d: '30D'
        };
        return map[String(dp)] || String(dp);
    },

    _scheduleLabel: function(sched) {
        sched = sched || {};
        var mode = String(sched.mode || 'ALWAYS');
        if (mode === 'AT') return 'No horário ' + (sched.atTime || '--:--');
        if (mode === 'WINDOW') return (sched.startTime || '--:--') + '–' + (sched.endTime || '--:--') + ' (cada ' + (sched.windowIntervalMin || sched.intervalMin || 5) + 'm)';
        return 'Sempre (cada ' + (sched.intervalMin || 5) + 'm)';
    },

    _nextRunLabel: function(rule) {
        // Only for UI. If scheduler paused, show paused.
        if (this.schedulerPaused) return 'Pausado';
        if (!rule || !rule.active) return '—';
        if (!rule.schedule) return '—';
        if (this._inFlight[rule.id]) return 'Executando';

        var next = this._computeNextRunAt(rule);
        if (!next) return '—';

        var now = Date.now();
        var ms = next.getTime() - now;
        if (ms <= 0) return 'Agora';

        var min = Math.round(ms / 60000);
        if (min <= 1) return 'Em ~1 min';
        if (min < 60) return 'Em ~' + min + ' min';

        var h = Math.floor(min / 60);
        var m = min % 60;
        if (h <= 24) return 'Em ~' + h + 'h' + (m ? (' ' + m + 'm') : '');

        // long
        return next.toLocaleString('pt-BR');
    },

    _computeNextRunAt: function(rule) {
        try {
            var sched = rule.schedule || {};
            var mode = String(sched.mode || 'ALWAYS');
            var now = new Date();

            if (mode === 'AT') {
                var at = String(sched.atTime || '');
                if (!this._isTime(at)) return null;
                var parts = at.split(':');
                var target = new Date(now);
                target.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);

                // if already ran today, set tomorrow
                var todayKey = now.toISOString().slice(0, 10);
                if (rule.meta && rule.meta.lastAtRunDate === todayKey) {
                    target.setDate(target.getDate() + 1);
                } else if (target.getTime() <= now.getTime()) {
                    // If past the time, and not ran yet, scheduler will execute on next tick; show "Agora"
                    // but to avoid showing past, add small delta
                    target = new Date(now.getTime() + 30 * 1000);
                }
                return target;
            }

            if (mode === 'WINDOW') {
                var st = String(sched.startTime || '');
                var en = String(sched.endTime || '');
                if (!this._isTime(st) || !this._isTime(en)) return null;

                var iv = parseInt(sched.windowIntervalMin || sched.intervalMin || 5, 10);
                if (!iv || iv < 1) iv = 5;

                // If in window: next = lastAutoRunAt + interval, else next = next window start.
                var stMin = this._timeToMin(st);
                var enMin = this._timeToMin(en);
                var curMin = now.getHours() * 60 + now.getMinutes();

                var inWindow = false;
                if (stMin <= enMin) inWindow = curMin >= stMin && curMin <= enMin;
                else inWindow = curMin >= stMin || curMin <= enMin;

                if (inWindow) {
                    var last = (rule.meta && rule.meta.lastAutoRunAt) ? Date.parse(rule.meta.lastAutoRunAt) : 0;
                    if (!last) return new Date(now.getTime() + 30 * 1000);
                    return new Date(last + iv * 60 * 1000);
                }

                // next window start
                var nextStart = new Date(now);
                nextStart.setSeconds(0, 0);
                // Determine if next start is today or tomorrow
                var startToday = new Date(now);
                startToday.setHours(Math.floor(stMin / 60), stMin % 60, 0, 0);

                if (stMin <= enMin) {
                    // normal window
                    if (now.getTime() < startToday.getTime()) return startToday;
                    // else tomorrow
                    startToday.setDate(startToday.getDate() + 1);
                    return startToday;
                }

                // crosses midnight: if current time is after end and before start, next start is today at start
                // else next start is today (if before start) or tomorrow
                // We simplify:
                if (curMin < stMin && curMin > enMin) {
                    return startToday;
                }
                // if already past today's start (cur>=stMin) then next start is tomorrow
                if (curMin >= stMin) {
                    startToday.setDate(startToday.getDate() + 1);
                    return startToday;
                }
                // else before start and also <= end (after midnight segment) => next start is today
                return startToday;
            }

            // ALWAYS
            var intervalMin = parseInt(sched.intervalMin || 5, 10);
            if (!intervalMin || intervalMin < 1) intervalMin = 5;
            var last2 = (rule.meta && rule.meta.lastAutoRunAt) ? Date.parse(rule.meta.lastAutoRunAt) : 0;
            if (!last2) return new Date(Date.now() + 30 * 1000);
            return new Date(last2 + intervalMin * 60 * 1000);
        } catch (e) {
            return null;
        }
    },

    _esc: function(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    // ===========================
    // Editor
    // ===========================
    openEditor: function() {
        var modal = document.getElementById('modal-rule-editor');
        if (!modal) return;
        modal.classList.remove('hidden');

        // reset
        var name = document.getElementById('rule-name');
        if (name) name.value = '';

        var scopeSel = document.getElementById('rule-campaign-scope');
        if (scopeSel) scopeSel.value = 'ALL';

        var dpSel = document.getElementById('rule-date-preset');
        if (dpSel) dpSel.value = 'today';

        var schedMode = document.getElementById('rule-schedule-mode');
        if (schedMode) schedMode.value = 'ALWAYS';

        var schedInterval = document.getElementById('rule-schedule-interval');
        if (schedInterval) schedInterval.value = '5';

        var at = document.getElementById('rule-schedule-at');
        if (at) at.value = '09:00';

        var wInt = document.getElementById('rule-schedule-window-interval');
        if (wInt) wInt.value = '5';

        var st = document.getElementById('rule-schedule-start');
        if (st) st.value = '09:00';

        var en = document.getElementById('rule-schedule-end');
        if (en) en.value = '21:00';

        var search = document.getElementById('rule-accounts-search');
        if (search) search.value = '';

        this.onScheduleModeChange();
        this.populateAccountsInEditor();
        this.clearConditions();
        this.addConditionRow();
    },

    closeEditor: function() {
        var modal = document.getElementById('modal-rule-editor');
        if (modal) modal.classList.add('hidden');
    },

    onScheduleModeChange: function() {
        var mode = (document.getElementById('rule-schedule-mode') || {}).value || 'ALWAYS';
        var gAlways = document.getElementById('rule-schedule-always-group');
        var gAt = document.getElementById('rule-schedule-at-group');
        var gWin = document.getElementById('rule-schedule-window-group');
        if (gAlways) gAlways.classList.toggle('hidden', mode !== 'ALWAYS');
        if (gAt) gAt.classList.toggle('hidden', mode !== 'AT');
        if (gWin) gWin.classList.toggle('hidden', mode !== 'WINDOW');
    },

    populateAccountsInEditor: function() {
        var container = document.getElementById('rule-accounts-list');
        if (!container) return;

        var accounts = (window.adsManager && window.adsManager.accounts) ? window.adsManager.accounts : [];
        if (!accounts.length) {
            container.innerHTML = '<div class="p-4 text-center text-xs text-gray-500 bg-gray-900/50 rounded-lg">Carregue contas na aba Gerenciador primeiro.</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < accounts.length; i++) {
            var acc = accounts[i];
            var hay = (String(acc.name || acc.account_id || '') + ' ' + String(acc.id || '')).toLowerCase();
            html +=
                '<label class="rule-account-row flex items-center justify-between p-2.5 rounded-lg bg-gray-900/40 border border-gray-800 hover:border-gray-600 cursor-pointer transition-colors group" data-search="' + this._esc(hay) + '">' +
                '  <span class="text-xs text-gray-300 font-medium group-hover:text-white truncate pr-2">' + this._esc(acc.name || acc.account_id) + '</span>' +
                '  <div class="relative inline-flex items-center">' +
                '    <input type="checkbox" class="sr-only peer rule-account-checkbox" value="' + this._esc(acc.id) + '" data-token="' + this._esc(acc.profileToken) + '">' +
                '    <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-\'\' after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 peer-checked:after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>' +
                '  </div>' +
                '</label>';
        }
        container.innerHTML = html;
    },

    filterAccountsInEditor: function(query) {
        query = String(query || '').toLowerCase().trim();
        var container = document.getElementById('rule-accounts-list');
        if (!container) return;
        var rows = container.querySelectorAll('.rule-account-row');
        for (var i = 0; i < rows.length; i++) {
            var hay = rows[i].getAttribute('data-search') || '';
            rows[i].style.display = (!query || hay.indexOf(query) !== -1) ? '' : 'none';
        }
    },

    clearConditions: function() {
        var c = document.getElementById('rule-conditions-container');
        if (c) c.innerHTML = '';
    },

    addConditionRow: function() {
        var container = document.getElementById('rule-conditions-container');
        if (!container) return;

        var rowId = 'cond-' + Date.now();
        var div = document.createElement('div');
        div.className = 'flex gap-2 items-center animate-fade-in';
        div.id = rowId;

        var metrics = this.getMetricCatalog();
        var opts = '';
        for (var i = 0; i < metrics.length; i++) {
            var m = metrics[i];
            opts += '<option value="' + m.key + '" data-format="' + m.format + '">' + this._esc(m.label) + '</option>';
        }

        div.innerHTML =
            '<select class="condition-metric flex-1 bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-xs text-white focus:border-purple-500 outline-none" onchange="rulesManager.onMetricChange(\'' + rowId + '\')">' +
            opts +
            '</select>' +
            '<select class="condition-operator w-28 bg-gray-950 border border-gray-800 rounded-xl px-2 py-2 text-xs text-white focus:border-purple-500 outline-none">' +
            '  <option value=">">Maior</option>' +
            '  <option value="<">Menor</option>' +
            '  <option value="=">Igual</option>' +
            '</select>' +
            '<div class="relative w-40">' +
            '  <span class="cond-prefix hidden absolute left-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-500" data-role="prefix">¤</span>' +
            '  <input type="number" step="0.01" class="condition-value w-full bg-gray-950 border border-gray-800 rounded-xl pl-7 pr-7 py-2 text-xs text-white focus:border-purple-500 outline-none" placeholder="Valor" />' +
            '  <span class="cond-suffix hidden absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-500" data-role="suffix">%</span>' +
            '</div>' +
            '<button type="button" onclick="document.getElementById(\'' + rowId + '\').remove()" class="p-2 text-gray-500 hover:text-red-400 transition-colors" title="Remover condição"><i class="fas fa-times"></i></button>';

        container.appendChild(div);
        this.onMetricChange(rowId);
    },

    onMetricChange: function(rowId) {
        var row = document.getElementById(rowId);
        if (!row) return;
        var metricSel = row.querySelector('.condition-metric');
        var valInput = row.querySelector('.condition-value');
        var prefix = row.querySelector('[data-role="prefix"]');
        var suffix = row.querySelector('[data-role="suffix"]');
        if (!metricSel || !valInput) return;

        var opt = metricSel.options[metricSel.selectedIndex];
        var fmt = opt ? opt.getAttribute('data-format') : 'number';

        // Reset
        if (prefix) prefix.classList.add('hidden');
        if (suffix) suffix.classList.add('hidden');

        if (fmt === 'currency') {
            if (prefix) { prefix.textContent = '¤'; prefix.classList.remove('hidden'); }
            valInput.step = '0.01';
            valInput.placeholder = '0.00';
        } else if (fmt === 'percent') {
            if (suffix) { suffix.textContent = '%'; suffix.classList.remove('hidden'); }
            valInput.step = '0.01';
            valInput.placeholder = '0.00';
        } else if (fmt === 'number2') {
            valInput.step = '0.01';
            valInput.placeholder = '0.00';
        } else {
            valInput.step = '1';
            valInput.placeholder = '0';
        }
    },

    saveFromEditor: function() {
        var name = (document.getElementById('rule-name') || {}).value;
        name = String(name || '').trim();
        if (!name) { alert('Nome obrigatório'); return; }

        // Accounts
        var accEls = document.querySelectorAll('.rule-account-checkbox:checked');
        if (!accEls.length) { alert('Selecione ao menos uma conta.'); return; }
        var accountIds = [];
        for (var i = 0; i < accEls.length; i++) {
            accountIds.push({ id: accEls[i].value, token: accEls[i].getAttribute('data-token') });
        }

        // Scope
        var scopeSel = document.getElementById('rule-campaign-scope');
        var scope = scopeSel ? scopeSel.value : 'ALL';

        // Date preset
        var dpSel = document.getElementById('rule-date-preset');
        var datePreset = dpSel ? dpSel.value : 'today';

        // Schedule
        var schedule = this._readScheduleFromEditor();
        if (!schedule.ok) {
            alert(schedule.error || 'Agendamento inválido');
            return;
        }

        // Conditions
        var condRows = document.querySelectorAll('#rule-conditions-container > div');
        var conditions = [];
        for (var j = 0; j < condRows.length; j++) {
            var m = (condRows[j].querySelector('.condition-metric') || {}).value;
            var o = (condRows[j].querySelector('.condition-operator') || {}).value;
            var v = (condRows[j].querySelector('.condition-value') || {}).value;
            if (v !== undefined && v !== null && String(v).trim() !== '') {
                conditions.push({ metric: m, operator: o, value: parseFloat(v) });
            }
        }
        if (!conditions.length) { alert('Adicione condições.'); return; }

        var logic = (document.getElementById('rule-logic') || {}).value || 'AND';
        var action = (document.getElementById('rule-action') || {}).value || 'PAUSE';

        var rule = {
            id: Date.now().toString(),
            name: name,
            active: true,
            lastRun: null,
            accountIds: accountIds,
            logic: logic,
            campaignScope: scope,
            datePreset: datePreset,
            schedule: schedule.value,
            meta: {},
            conditions: conditions,
            action: { type: action }
        };

        this.rules.push(rule);
        this.saveRules();
        this.closeEditor();
        this._startScheduler();
        if (window.logger) window.logger.success('Regra criada: ' + name);
    },

    _readScheduleFromEditor: function() {
        var mode = (document.getElementById('rule-schedule-mode') || {}).value || 'ALWAYS';

        if (mode === 'AT') {
            var at = (document.getElementById('rule-schedule-at') || {}).value || '';
            if (!this._isTime(at)) return { ok: false, error: 'Informe um horário válido (HH:MM).' };
            return { ok: true, value: { mode: 'AT', atTime: at } };
        }

        if (mode === 'WINDOW') {
            var st = (document.getElementById('rule-schedule-start') || {}).value || '';
            var en = (document.getElementById('rule-schedule-end') || {}).value || '';
            var wi = parseInt((document.getElementById('rule-schedule-window-interval') || {}).value || '5', 10);
            if (!this._isTime(st) || !this._isTime(en)) return { ok: false, error: 'Informe horários válidos (Início e Fim).' };
            if (!wi || wi < 1) wi = 5;
            return { ok: true, value: { mode: 'WINDOW', startTime: st, endTime: en, windowIntervalMin: wi } };
        }

        // ALWAYS
        var iv = parseInt((document.getElementById('rule-schedule-interval') || {}).value || '5', 10);
        if (!iv || iv < 1) iv = 5;
        return { ok: true, value: { mode: 'ALWAYS', intervalMin: iv } };
    },

    _isTime: function(t) {
        if (!t) return false;
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
    },

    deleteRule: function(i) {
        if (confirm('Excluir regra?')) {
            this.rules.splice(i, 1);
            this.saveRules();
        }
    },

    toggleRuleActive: function(i) {
        this.rules[i].active = !this.rules[i].active;
        this.saveRules();
        this._syncSchedulerUI();
        this._startScheduler();
    },

    // ===========================
    // Scheduler
    // ===========================
    _startScheduler: function() {
        var self = this;
        if (this._schedulerTimer) {
            clearInterval(this._schedulerTimer);
            this._schedulerTimer = null;
        }

        // If globally paused, don't schedule.
        if (this.schedulerPaused) return;

        // If no active rules, don't schedule.
        var hasActive = false;
        for (var i = 0; i < this.rules.length; i++) {
            if (this.rules[i] && this.rules[i].active) { hasActive = true; break; }
        }
        if (!hasActive) return;

        // Tick every 30s, rules decide due based on their schedule
        this._schedulerTimer = setInterval(function() {
            self._schedulerTick();
        }, 30 * 1000);

        // run quick tick soon
        setTimeout(function(){ self._schedulerTick(); }, 800);
    },

    _schedulerTick: function() {
        var self = this;
        if (!window.fbApi) return;
        if (this.schedulerPaused) return;

        for (var i = 0; i < this.rules.length; i++) {
            (function(idx){
                var rule = self.rules[idx];
                if (!rule || !rule.active) return;
                if (!rule.accountIds || !rule.accountIds.length) return;
                if (!rule.schedule) rule.schedule = { mode: 'ALWAYS', intervalMin: 5 };
                if (!rule.meta) rule.meta = {};

                if (!self._isRuleDue(rule)) return;
                self._runRuleAuto(idx);
            })(i);
        }
    },

    _isRuleDue: function(rule) {
        var sched = rule.schedule || {};
        var mode = String(sched.mode || 'ALWAYS');
        var now = new Date();
        var nowMs = now.getTime();

        // Prevent overlapping
        if (this._inFlight[rule.id]) return false;

        if (mode === 'AT') {
            var at = String(sched.atTime || '');
            if (!this._isTime(at)) return false;
            var parts = at.split(':');
            var targetMin = parseInt(parts[0],10)*60 + parseInt(parts[1],10);
            var curMin = now.getHours()*60 + now.getMinutes();
            if (curMin < targetMin) return false;

            var todayKey = now.toISOString().slice(0,10);
            if (rule.meta.lastAtRunDate === todayKey) return false;

            return true;
        }

        if (mode === 'WINDOW') {
            var st = String(sched.startTime || '');
            var en = String(sched.endTime || '');
            if (!this._isTime(st) || !this._isTime(en)) return false;

            var stMin = this._timeToMin(st);
            var enMin = this._timeToMin(en);
            var cur = now.getHours()*60 + now.getMinutes();

            var inWindow = false;
            if (stMin <= enMin) {
                inWindow = cur >= stMin && cur <= enMin;
            } else {
                // crosses midnight
                inWindow = cur >= stMin || cur <= enMin;
            }
            if (!inWindow) return false;

            var iv = parseInt(sched.windowIntervalMin || sched.intervalMin || 5, 10);
            if (!iv || iv < 1) iv = 5;
            var last = rule.meta.lastAutoRunAt ? Date.parse(rule.meta.lastAutoRunAt) : 0;
            return !last || (nowMs - last) >= (iv * 60 * 1000);
        }

        // ALWAYS
        var intervalMin = parseInt(sched.intervalMin || 5, 10);
        if (!intervalMin || intervalMin < 1) intervalMin = 5;
        var last2 = rule.meta.lastAutoRunAt ? Date.parse(rule.meta.lastAutoRunAt) : 0;
        return !last2 || (nowMs - last2) >= (intervalMin * 60 * 1000);
    },

    _timeToMin: function(t) {
        var p = String(t||'').split(':');
        return parseInt(p[0],10)*60 + parseInt(p[1],10);
    },

    _runRuleAuto: function(index) {
        var self = this;
        var rule = this.rules[index];
        if (!rule) return;

        // Mark in flight
        this._inFlight[rule.id] = true;

        var promises = [];
        for (var i = 0; i < (rule.accountIds || []).length; i++) {
            promises.push(this._execAccount(rule, rule.accountIds[i]));
        }

        Promise.all(promises)
            .then(function(res) {
                var total = 0;
                for (var i = 0; i < res.length; i++) total += (res[i] || 0);

                rule.lastRun = new Date().toISOString();
                rule.meta = rule.meta || {};
                rule.meta.lastAutoRunAt = new Date().toISOString();
                if (rule.schedule && rule.schedule.mode === 'AT') {
                    rule.meta.lastAtRunDate = new Date().toISOString().slice(0,10);
                }
                self.saveRules();

                if (window.logger) {
                    window.logger.info('Regra (auto) executada: ' + rule.name, { affected: total, schedule: rule.schedule });
                }
            })
            .catch(function(e){
                if (window.logger) window.logger.warn('Falha regra (auto)', { rule: rule.name, error: String(e) });
            })
            .finally(function(){
                delete self._inFlight[rule.id];
            });
    },

    // ===========================
    // Manual execution
    // ===========================
    runRuleNow: function(index) {
        var self = this;
        var rule = this.rules[index];
        if (!rule) return;

        var btn = document.querySelector('button[onclick="rulesManager.runRuleNow(' + index + ')"]');
        var old = null;
        if (btn) {
            old = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
            btn.disabled = true;
        }

        var promises = [];
        for (var i = 0; i < (rule.accountIds || []).length; i++) {
            promises.push(this._execAccount(rule, rule.accountIds[i]));
        }

        Promise.all(promises)
            .then(function(res) {
                var total = 0;
                for (var i = 0; i < res.length; i++) total += (res[i] || 0);
                rule.lastRun = new Date().toISOString();
                rule.meta = rule.meta || {};
                rule.meta.lastAutoRunAt = new Date().toISOString();
                self.saveRules();
                if (window.logger) window.logger.success('Regra executada. ' + total + ' campanhas afetadas.');
            })
            .finally(function() {
                if (btn) {
                    btn.innerHTML = old;
                    btn.disabled = false;
                }
            });
    },

    // ===========================
    // Execution (batch)
    // ===========================
    _insightsFieldsForRule: function(rule) {
        // Build a light but complete set of fields based on conditions
        var need = {
            campaign_id: true,
            account_currency: true
        };

        var conds = (rule && rule.conditions) ? rule.conditions : [];
        for (var i = 0; i < conds.length; i++) {
            var k = String(conds[i].metric || '');
            // Backward compatibility
            if (k === 'cost_per_result') k = 'cpr';

            if (k === 'ic' || k === 'results') need.actions = true;
            if (k === 'cpr') need.cost_per_action_type = true;

            if (k === 'spend') need.spend = true;
            if (k === 'cpc') need.cpc = true;
            if (k === 'cpm') need.cpm = true;
            if (k === 'ctr') need.ctr = true;
            if (k === 'clicks') need.clicks = true;
            if (k === 'impressions') need.impressions = true;
            if (k === 'reach') need.reach = true;
            if (k === 'frequency') need.frequency = true;
        }

        // Minimal fallback to avoid empty insights
        need.spend = true;

        var out = [];
        for (var f in need) if (need.hasOwnProperty(f) && need[f]) out.push(f);
        return out.join(',');
    },

    _execAccount: function(rule, acc) {
        var self = this;
        if (!window.fbApi) return Promise.resolve(0);

        var fields = this._insightsFieldsForRule(rule);
        var dp = rule.datePreset || 'today';

        return Promise.all([
            window.fbApi.getCampaigns(acc.id, acc.token),
            window.fbApi.getInsightsForAccountLevel(acc.id, acc.token, 'campaign', dp, { fields: fields })
        ])
            .then(function(res) {
                var camps = res[0] || [];
                var rows = res[1] || [];
                var map = {};
                for (var k = 0; k < rows.length; k++) if (rows[k] && rows[k].campaign_id) map[String(rows[k].campaign_id)] = rows[k];

                var scope = rule.campaignScope || 'ALL';

                var tasks = [];
                for (var i = 0; i < camps.length; i++) {
                    var c = camps[i];

                    // campaign scope filter
                    if (scope === 'ACTIVE' && String(c.status) !== 'ACTIVE') continue;
                    if (scope === 'PAUSED' && String(c.status) !== 'PAUSED') continue;

                    // action intent filter
                    if (rule.action.type === 'PAUSE' && String(c.status) !== 'ACTIVE') continue;
                    if (rule.action.type === 'ACTIVATE' && String(c.status) === 'ACTIVE') continue;

                    var ins = map[String(c.id)] || {};
                    if (self._check(rule.conditions, rule.logic, ins)) {
                        tasks.push(window.fbApi.updateObject(c.id, { status: rule.action.type === 'PAUSE' ? 'PAUSED' : 'ACTIVE' }, acc.token));
                    }
                }

                return Promise.all(tasks).then(function(r) { return r.length; });
            })
            .catch(function(e) {
                if (window.logger) window.logger.warn('Falha ao executar regra na conta', { account: acc.id, error: String(e) });
                return 0;
            });
    },

    _check: function(conds, logic, ins) {
        conds = conds || [];
        var res = [];

        for (var i = 0; i < conds.length; i++) {
            var c = conds[i] || {};
            var metric = String(c.metric || '');
            // Backward compatibility
            if (metric === 'cost_per_result') metric = 'cpr';

            var val = 0;
            if (metric === 'cpr') val = this._getCPR(ins);
            else if (metric === 'results') val = this._getResults(ins);
            else if (metric === 'ic') val = this._getIC(ins);
            else val = parseFloat(ins[metric] || 0) || 0;

            var pass = false;
            if (c.operator === '>') pass = val > c.value;
            else if (c.operator === '<') pass = val < c.value;
            else pass = Math.abs(val - c.value) < 0.0001;
            res.push(pass);
        }

        if (logic === 'OR') {
            for (var j = 0; j < res.length; j++) if (res[j]) return true;
            return false;
        }
        for (var k = 0; k < res.length; k++) if (!res[k]) return false;
        return true;
    },

    _actionsMap: function(arr) {
        var m = {};
        if (!arr) return m;
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (!it || !it.action_type) continue;
            m[it.action_type] = parseFloat(it.value || 0) || 0;
        }
        return m;
    },

    _getIC: function(ins) {
        var acts = this._actionsMap(ins.actions);
        return (acts['initiate_checkout'] || 0) + (acts['omni_initiated_checkout'] || 0);
    },

    _getResults: function(ins) {
        var acts = this._actionsMap(ins.actions);
        var order = [
            ['purchase', 'omni_purchase'],
            ['lead', 'omni_lead'],
            ['initiate_checkout', 'omni_initiated_checkout'],
            ['link_click']
        ];
        for (var i = 0; i < order.length; i++) {
            var sum = 0;
            for (var j = 0; j < order[i].length; j++) sum += (acts[order[i][j]] || 0);
            if (sum > 0) return sum;
        }
        return 0;
    },

    _getCPR: function(ins) {
        var costs = this._actionsMap(ins.cost_per_action_type);
        var order = ['purchase', 'omni_purchase', 'lead', 'omni_lead', 'initiate_checkout', 'omni_initiated_checkout', 'link_click'];
        for (var i = 0; i < order.length; i++) {
            if (costs[order[i]] !== undefined) return costs[order[i]];
        }
        return 0;
    }
};

window.rulesManager = rulesManager;
