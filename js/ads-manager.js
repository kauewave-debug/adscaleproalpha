/**
 * Ads Manager Module
 * Campaign / AdSet / Ad management with multi-level selection, columns, bulk actions
 * Version: 6.0 - Restored Full Functionality + Robust UI Integration
 */
(function(){
  var adsManager = {
    // State
    accounts: [],
    selectedAccount: null,
    currentLevel: 'campaigns',
    currentDatePreset: 'last_7d',
    data: [],

    // Selection per level
    selectedCampaignIds: [],
    selectedAdSetIds: [],
    selectedAdIds: [],

    // Columns
    columnsCatalog: [],
    selectedColumnKeys: [],
    customColumns: [],
    columnsSearch: '',

    // Edit
    editingObject: null,

    // Bulk editor
    bulk: { isOpen: false, level: null, items: [], activeIndex: 0 },

    // Flags
    isInitialized: false,

    // =====================
    // Init
    // =====================
    init: function(){
      if(this.isInitialized){
        this.renderAccountButton();
        this.updateDateButtonsUI();
        this.updateTabsUI();
        this.renderTableHead();
        this.updateBulkActionBar();
        return;
      }
      this.isInitialized = true;

      this._initColumns();
      this.loadAccountsFromProfiles();
      this.bindEvents();
      this._initColumnsDnD();
      this.updateDateButtonsUI();
      this.updateTabsUI();
      this.renderTableHead();
      this.updateBulkActionBar();

      window.addEventListener('profilesUpdated', () => this.loadAccountsFromProfiles());
      if(window.logger) window.logger.info('Ads Manager initialized (v6.0)');
    },

    // =====================
    // Overlay helper (min 3s)
    // =====================
    _showOverlay: function(){
      var el = document.getElementById('action-loading-overlay');
      if(el) el.classList.remove('hidden');
    },
    _hideOverlay: function(){
      var el = document.getElementById('action-loading-overlay');
      if(el) el.classList.add('hidden');
    },
    withActionLoading: function(promiseFactory){
      var start = Date.now();
      this._showOverlay();
      var p;
      try {
        p = Promise.resolve().then(promiseFactory);
      } catch(e){
        p = Promise.reject(e);
      }
      return p.finally(() => {
        var elapsed = Date.now() - start;
        var wait = Math.max(0, 3000 - elapsed);
        return new Promise(res => setTimeout(res, wait)).then(()=>this._hideOverlay());
      });
    },

    // =====================
    // Currency
    // =====================
    ensureAccountCurrency: function(){
      if(!this.selectedAccount) return;
      var key = 'ads_currency_' + this.selectedAccount.id;
      if(!this.selectedAccount.currency){
        try{
          var cached = localStorage.getItem(key);
          if(cached) this.selectedAccount.currency = cached;
        } catch(e){}
      }
      if(this.selectedAccount.currency){
        try{ localStorage.setItem(key, this.selectedAccount.currency); } catch(e){}
      } else {
        this.selectedAccount.currency = 'BRL';
      }
    },
    formatCurrency: function(v){
      this.ensureAccountCurrency();
      var cur = (this.selectedAccount && this.selectedAccount.currency) ? this.selectedAccount.currency : 'BRL';
      try{
        return new Intl.NumberFormat('pt-BR', { style:'currency', currency: cur }).format(v);
      } catch(e){
        return String(v);
      }
    },
    formatNumber: function(v){
      try{ return new Intl.NumberFormat('pt-BR').format(v); } catch(e){ return String(v); }
    },

    // =====================
    // Accounts
    // =====================
    loadAccountsFromProfiles: function(){
      this.accounts = [];
      var profs = (window.profilesManager && window.profilesManager.profiles) ? window.profilesManager.profiles : [];
      if(!profs.length){
        this.renderAccountButton();
        return;
      }
      var tasks = profs.map(p => this.fetchAccountsForProfile(p));
      Promise.all(tasks).then(()=>{
        this.renderAccountButton();
        if(window.logger) window.logger.info('Ad accounts loaded: ' + this.accounts.length);
      });
    },

    fetchAccountsForProfile: function(profile){
      if(!window.fbApi) return Promise.resolve();
      return window.fbApi.getAdAccounts(profile.token)
        .then(accs => {
          (accs||[]).forEach(a => {
            a.profileToken = profile.token;
            a.profileName = profile.name;
            a.profileId = profile.id;
            this.accounts.push(a);
          });
        })
        .catch(err => {
          if(window.logger) window.logger.warn('Falha ao carregar contas: ' + profile.name, { error: String(err) });
        });
    },

    renderAccountButton: function(){
      var c = document.getElementById('account-selector-container');
      if(!c) return;

      var title = this.selectedAccount ? (this.selectedAccount.name || ('Conta ' + (this.selectedAccount.account_id||this.selectedAccount.id))) : 'Selecione uma conta';
      var cur = this.selectedAccount ? (this.selectedAccount.currency || '—') : '';
      var badge = this.selectedAccount ? `<span class="bg-blue-500/20 text-blue-400 text-[10px] font-bold px-1.5 py-0.5 rounded border border-blue-500/30 ml-2">${cur}</span>` : '';

      c.innerHTML = `
        <button onclick="adsManager.openAccountModal()" class="flex items-center gap-3 px-4 py-2.5 bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-xl transition-all group w-[280px]">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-lg"><i class="fas fa-building text-xs"></i></div>
          <div class="flex-1 text-left min-w-0">
            <p class="text-[10px] text-gray-500 uppercase tracking-wide font-bold">Conta de Anúncios</p>
            <div class="flex items-center text-sm font-semibold text-white truncate">${this._esc(title)} ${badge}</div>
          </div>
          <i class="fas fa-chevron-down text-gray-500 group-hover:text-white transition-colors text-xs"></i>
        </button>
      `;
    },

    openAccountModal: function(){
      var m = document.getElementById('modal-select-account');
      if(m) m.classList.remove('hidden');
      this.renderAccountList();
    },

    closeAccountModal: function(){
      var m = document.getElementById('modal-select-account');
      if(m) m.classList.add('hidden');
    },

    filterAccounts: function(q){
      this.renderAccountList(q);
    },

    renderAccountList: function(q){
      var c = document.getElementById('accounts-list-container');
      if(!c) return;
      q = (q||'').toLowerCase();
      var list = this.accounts.filter(a => {
        if(!q) return true;
        var hay = ((a.name||'')+' '+(a.account_id||'')+' '+(a.business_name||'')+' '+(a.id||'')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });

      if(!list.length){
        c.innerHTML = '<div class="py-10 text-center text-gray-500">Nenhuma conta encontrada.</div>';
        return;
      }

      var html = '';
      list.forEach(a => {
        var selected = this.selectedAccount && String(this.selectedAccount.id)===String(a.id);
        var statusBadge = this._accountStatusBadge(a.account_status);
        html += `
          <div onclick="adsManager.selectAccount('${this._escAttr(a.id)}')" class="flex items-center gap-3 p-3 rounded-2xl border ${selected?'border-blue-500/50 bg-blue-900/10':'border-gray-800 hover:border-gray-600 hover:bg-gray-800/30'} cursor-pointer transition-all">
            <div class="w-10 h-10 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center font-bold text-xs text-white">${this._esc((a.name||'C').substring(0,2).toUpperCase())}</div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0">
                <p class="text-sm font-bold text-white truncate">${this._esc(a.name||'Sem nome')}</p>
                ${statusBadge}
                <span class="text-[10px] text-gray-500 bg-gray-900 border border-gray-800 px-2 py-0.5 rounded-full">${this._esc(a.currency||'—')}</span>
              </div>
              <p class="text-[10px] text-gray-500 font-mono truncate">${this._esc(a.id)}</p>
            </div>
            <div class="text-gray-500">${selected?'<i class="fas fa-check-circle text-blue-400"></i>':''}</div>
          </div>
        `;
      });
      c.innerHTML = html;
    },

    _accountStatusBadge: function(status){
      var map = {
        1: { label: 'Ativa', cls: 'bg-green-500/15 text-green-400 border-green-500/25' },
        2: { label: 'Desativada', cls: 'bg-red-500/15 text-red-400 border-red-500/25' },
        3: { label: 'Não permitida', cls: 'bg-red-500/15 text-red-400 border-red-500/25' },
        7: { label: 'Pendente', cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25' },
        9: { label: 'Em análise', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25' },
        101: { label: 'Fechada', cls: 'bg-red-500/15 text-red-400 border-red-500/25' }
      };
      var info = map[status] || { label: 'Status', cls: 'bg-gray-700/50 text-gray-300 border-gray-600/50' };
      return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${info.cls}">${info.label}</span>`;
    },

    syncAccounts: function(){
      var btn = document.querySelector('#modal-select-account button[onclick="adsManager.syncAccounts()"]');
      if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Sincronizando'; }
      this.loadAccountsFromProfiles();
      setTimeout(()=>{
        this.renderAccountList();
        if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Sincronizar'; }
      }, 1200);
    },

    selectAccount: function(accountId){
      this.selectedAccount = this.accounts.find(a => String(a.id)===String(accountId)) || null;
      this.ensureAccountCurrency();
      this.closeAccountModal();
      this.renderAccountButton();

      // reset table selection when changing account
      this.selectedCampaignIds = [];
      this.selectedAdSetIds = [];
      this.selectedAdIds = [];
      this.currentLevel = 'campaigns';
      this.updateTabsUI();
      this.updateBulkActionBar();
      this.renderTableHead();
      this.loadData();

      if(window.logger && this.selectedAccount) window.logger.info('Conta selecionada', { id: this.selectedAccount.id, currency: this.selectedAccount.currency });
    },

    // =====================
    // Tabs + Date (Facebook-like date picker)
    // =====================
    setViewLevel: function(level){
      if(level!=='campaigns' && level!=='adsets' && level!=='ads') return;
      this.currentLevel = level;
      this.updateTabsUI();
      this.updateBulkActionBar();
      this.renderTableHead();
      this.loadData();
    },

    // --- Date Picker State ---
    datePicker: {
      open: false,
      mode: 'preset', // 'preset' | 'custom'
      preset: 'last_7d',
      since: null, // YYYY-MM-DD
      until: null, // YYYY-MM-DD
      tmpSince: null,
      tmpUntil: null,
      viewMonth: null // Date pointing to first day of left month
    },

    _dateKey: function(d){
      // YYYY-MM-DD
      var y = d.getFullYear();
      var m = String(d.getMonth()+1).padStart(2,'0');
      var da = String(d.getDate()).padStart(2,'0');
      return y+'-'+m+'-'+da;
    },
    _parseDateKey: function(key){
      // key: YYYY-MM-DD
      var p = String(key||'').split('-');
      if(p.length!==3) return null;
      var d = new Date(parseInt(p[0],10), parseInt(p[1],10)-1, parseInt(p[2],10));
      if(String(d)==='Invalid Date') return null;
      return d;
    },
    _fmtBr: function(key){
      var d = this._parseDateKey(key);
      if(!d) return '';
      try{ return d.toLocaleDateString('pt-BR'); } catch(e){ return key; }
    },
    _startOfMonth: function(d){
      return new Date(d.getFullYear(), d.getMonth(), 1);
    },
    _addMonths: function(d, n){
      return new Date(d.getFullYear(), d.getMonth()+n, 1);
    },

    // currentDatePreset remains for presets; custom uses currentTimeRange
    currentDatePreset: 'last_7d',
    currentTimeRange: null, // { since:'YYYY-MM-DD', until:'YYYY-MM-DD' } when custom

    setDatePreset: function(preset){
      // Map our UI presets to Meta date_preset
      var map = {
        today: 'today',
        yesterday: 'yesterday',
        last_2d: 'last_2_days',
        last_7d: 'last_7d',
        last_14d: 'last_14d',
        last_30d: 'last_30d',
        last_90d: 'last_90d',
        this_month: 'this_month',
        last_month: 'last_month'
      };
      var dp = map[String(preset)] || String(preset);
      this.currentDatePreset = dp;
      this.currentTimeRange = null;
      this.datePicker.mode = 'preset';
      this.datePicker.preset = String(preset);
      this._lastPreset = String(preset);
      this._pushRecentRange({ type:'preset', preset: String(preset) });
      this._updateDateTriggerLabel();
      this._highlightPresetRows();
      this.loadData();
    },

    resetDateToLastPreset: function(){
      // Clear custom time range and go back to last preset
      this.currentTimeRange = null;
      this.datePicker.tmpSince = null;
      this.datePicker.tmpUntil = null;
      this.datePicker.mode = 'preset';
      var p = this._lastPreset || this.datePicker.preset || 'last_7d';
      this.datePicker.preset = p;
      this._highlightPresetRows();
      this._syncDateInputs();
      this._updateDateTriggerLabel();
      this.closeDatePicker();
      this.setDatePreset(p);
    },

    // Toggle picker
    toggleDatePicker: function(ev){
      if(ev && ev.stopPropagation) ev.stopPropagation();
      var pop = document.getElementById('ads-date-picker');
      if(!pop) return;
      if(pop.classList.contains('hidden')){
        this.openDatePicker();
      } else {
        this.closeDatePicker();
      }
    },

    openDatePicker: function(){
      var pop = document.getElementById('ads-date-picker');
      if(!pop) return;
      pop.classList.remove('hidden');
      this.datePicker.open = true;

      // init month view
      if(!this.datePicker.viewMonth) this.datePicker.viewMonth = this._startOfMonth(new Date());

      // init temp selection from current selection
      if(this.currentTimeRange){
        this.datePicker.mode = 'custom';
        this.datePicker.tmpSince = this.currentTimeRange.since;
        this.datePicker.tmpUntil = this.currentTimeRange.until;
      } else {
        this.datePicker.mode = 'preset';
        this.datePicker.tmpSince = null;
        this.datePicker.tmpUntil = null;
      }

      this._renderRecentPresets();
      this._highlightPresetRows();
      this._renderCalendars();
      this._syncDateInputs();

      // click outside
      setTimeout(() => {
        this._dpOutsideHandler = (e) => {
          var wrapper = document.getElementById('ads-date-picker-wrapper');
          if(!wrapper) return;
          if(!wrapper.contains(e.target)) this.closeDatePicker();
        };
        document.addEventListener('mousedown', this._dpOutsideHandler);
      }, 0);
    },

    closeDatePicker: function(){
      var pop = document.getElementById('ads-date-picker');
      if(pop) pop.classList.add('hidden');
      this.datePicker.open = false;
      if(this._dpOutsideHandler){
        document.removeEventListener('mousedown', this._dpOutsideHandler);
        this._dpOutsideHandler = null;
      }
    },

    _selectCustomMode: function(){
      this.datePicker.mode = 'custom';
      // keep tmp selection
      if(!this.datePicker.tmpSince){
        var d = new Date();
        var key = this._dateKey(d);
        this.datePicker.tmpSince = key;
        this.datePicker.tmpUntil = key;
      }
      this._highlightPresetRows();
      this._renderCalendars();
      this._syncDateInputs();
    },

    _dpPrevMonth: function(){
      this.datePicker.viewMonth = this._addMonths(this.datePicker.viewMonth || this._startOfMonth(new Date()), -1);
      this._renderCalendars();
    },

    _dpNextMonth: function(){
      this.datePicker.viewMonth = this._addMonths(this.datePicker.viewMonth || this._startOfMonth(new Date()), 1);
      this._renderCalendars();
    },

    _syncDateInputs: function(){
      var sinceEl = document.getElementById('ads-date-since');
      var untilEl = document.getElementById('ads-date-until');
      if(sinceEl) sinceEl.value = this.datePicker.tmpSince ? this._fmtBr(this.datePicker.tmpSince) : '';
      if(untilEl) untilEl.value = this.datePicker.tmpUntil ? this._fmtBr(this.datePicker.tmpUntil) : '';
    },

    _renderRecentPresets: function(){
      var box = document.getElementById('ads-date-recent');
      if(!box) return;
      var list = [];
      try{ list = JSON.parse(localStorage.getItem('ads_date_recent_v1')||'[]') || []; } catch(e){ list = []; }
      if(!list.length){
        box.innerHTML = '<div class="text-xs text-gray-600">Nenhum recente.</div>';
        return;
      }
      var html = '';
      for(var i=0;i<Math.min(6,list.length);i++){
        var it = list[i];
        if(it.type==='preset'){
          html += `<button type="button" class="ads-date-preset-row" onclick="adsManager.setDatePreset('${this._escAttr(it.preset)}')">${this._esc(this._presetLabel(it.preset))}</button>`;
        } else {
          html += `<button type="button" class="ads-date-preset-row" onclick="adsManager._applyRecentCustom('${this._escAttr(it.since)}','${this._escAttr(it.until)}')"><i class="fas fa-sliders-h mr-2 opacity-70"></i>${this._esc(this._fmtBr(it.since))} – ${this._esc(this._fmtBr(it.until))}</button>`;
        }
      }
      box.innerHTML = html;
    },

    _applyRecentCustom: function(since, until){
      this.datePicker.mode = 'custom';
      this.datePicker.tmpSince = since;
      this.datePicker.tmpUntil = until;
      this._renderCalendars();
      this._syncDateInputs();
      this._highlightPresetRows();
    },

    _pushRecentRange: function(entry){
      try{
        var list = JSON.parse(localStorage.getItem('ads_date_recent_v1')||'[]') || [];
        // de-dup
        var key = JSON.stringify(entry);
        list = list.filter(x => JSON.stringify(x)!==key);
        list.unshift(entry);
        if(list.length>12) list = list.slice(0,12);
        localStorage.setItem('ads_date_recent_v1', JSON.stringify(list));
      } catch(e){}
    },

    _presetLabel: function(p){
      var map = {
        today: 'Hoje',
        yesterday: 'Ontem',
        last_2d: 'Hoje e ontem',
        last_7d: 'Últimos 7 dias',
        last_14d: 'Últimos 14 dias',
        last_30d: 'Últimos 30 dias',
        last_90d: 'Últimos 90 dias',
        this_month: 'Este mês',
        last_month: 'Mês passado',
        CUSTOM: 'Personalizado'
      };
      return map[String(p)] || String(p);
    },

    _highlightPresetRows: function(){
      var rows = document.querySelectorAll('#ads-date-picker .ads-date-preset-row');
      for(var i=0;i<rows.length;i++){
        var r = rows[i];
        var p = r.getAttribute('data-preset');
        r.classList.remove('ads-date-preset-active');
        if(this.datePicker.mode==='preset' && p && p===this.datePicker.preset){
          r.classList.add('ads-date-preset-active');
        }
        if(this.datePicker.mode==='custom' && p==='CUSTOM'){
          r.classList.add('ads-date-preset-active');
        }
      }
    },

    _updateDateTriggerLabel: function(){
      var el = document.getElementById('ads-date-trigger-label');
      if(!el) return;
      if(this.currentTimeRange){
        el.textContent = this._fmtBr(this.currentTimeRange.since) + ' – ' + this._fmtBr(this.currentTimeRange.until);
        return;
      }
      // preset label
      var inv = {
        today: 'Hoje',
        yesterday: 'Ontem',
        last_2_days: 'Hoje e ontem',
        last_7d: 'Últimos 7 dias',
        last_14d: 'Últimos 14 dias',
        last_30d: 'Últimos 30 dias',
        last_90d: 'Últimos 90 dias',
        this_month: 'Este mês',
        last_month: 'Mês passado'
      };
      el.textContent = inv[String(this.currentDatePreset)] || String(this.currentDatePreset);
    },

    _renderCalendars: function(){
      var leftMonth = this._startOfMonth(this.datePicker.viewMonth || new Date());
      var rightMonth = this._addMonths(leftMonth, 1);

      var leftTitle = document.getElementById('ads-cal-left-title');
      var rightTitle = document.getElementById('ads-cal-right-title');
      if(leftTitle) leftTitle.textContent = this._monthTitle(leftMonth);
      if(rightTitle) rightTitle.textContent = this._monthTitle(rightMonth);

      var left = document.getElementById('ads-cal-left');
      var right = document.getElementById('ads-cal-right');
      if(left) left.innerHTML = this._renderMonthGrid(leftMonth, 'L');
      if(right) right.innerHTML = this._renderMonthGrid(rightMonth, 'R');

      // bind click handlers
      this._bindCalendarClicks(left);
      this._bindCalendarClicks(right);
    },

    _monthTitle: function(d){
      var months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
      return months[d.getMonth()] + ' ' + d.getFullYear();
    },

    _renderMonthGrid: function(monthDate, side){
      // Build a 7-col grid with weekday header.
      var wd = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
      var html = '<div class="ads-cal-grid">';
      html += '<div class="ads-cal-head">' + wd.map(x=>'<div class="ads-cal-wd">'+x+'</div>').join('') + '</div>';

      var first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
      var last = new Date(monthDate.getFullYear(), monthDate.getMonth()+1, 0);

      // Convert JS day (0 Sun) to Monday-first index
      function monIndex(jsDay){
        return jsDay===0 ? 6 : jsDay-1;
      }

      var startOffset = monIndex(first.getDay());
      var totalDays = last.getDate();
      var cells = [];
      for(var i=0;i<startOffset;i++) cells.push(null);
      for(var d=1; d<=totalDays; d++){
        cells.push(new Date(monthDate.getFullYear(), monthDate.getMonth(), d));
      }
      while(cells.length % 7 !== 0) cells.push(null);

      var since = this.datePicker.tmpSince;
      var until = this.datePicker.tmpUntil;
      var sinceD = since ? this._parseDateKey(since) : null;
      var untilD = until ? this._parseDateKey(until) : null;

      html += '<div class="ads-cal-body">';
      for(var c=0;c<cells.length;c++){
        var day = cells[c];
        if(!day){
          html += '<div class="ads-cal-cell ads-cal-empty"></div>';
          continue;
        }

        var key = this._dateKey(day);
        var cls = 'ads-cal-cell ads-cal-day';

        var inRange = false;
        if(sinceD && untilD){
          var t = day.getTime();
          var a = sinceD.getTime();
          var b = untilD.getTime();
          if(t>=Math.min(a,b) && t<=Math.max(a,b)) inRange = true;
        }
        if(inRange) cls += ' ads-cal-inrange';
        if(since === key) cls += ' ads-cal-start';
        if(until === key) cls += ' ads-cal-end';

        html += `<button type="button" class="${cls}" data-date="${key}">${day.getDate()}</button>`;
      }
      html += '</div></div>';
      return html;
    },

    _bindCalendarClicks: function(container){
      if(!container) return;
      container.querySelectorAll('[data-date]').forEach(btn => {
        btn.onclick = (e) => {
          e.preventDefault();
          this.datePicker.mode = 'custom';
          var key = btn.getAttribute('data-date');
          // Range selection logic
          if(!this.datePicker.tmpSince || (this.datePicker.tmpSince && this.datePicker.tmpUntil)){
            this.datePicker.tmpSince = key;
            this.datePicker.tmpUntil = null;
          } else {
            this.datePicker.tmpUntil = key;
          }
          this._syncDateInputs();
          this._renderCalendars();
          this._highlightPresetRows();
        };
      });
    },

    applyDatePicker: function(){
      if(this.datePicker.mode==='preset'){
        this.closeDatePicker();
        this.setDatePreset(this.datePicker.preset || 'last_7d');
        return;
      }

      // custom
      if(!this.datePicker.tmpSince){
        alert('Selecione uma data de início.');
        return;
      }
      var since = this.datePicker.tmpSince;
      var until = this.datePicker.tmpUntil || this.datePicker.tmpSince;

      // normalize since<=until
      var a = this._parseDateKey(since);
      var b = this._parseDateKey(until);
      if(a && b && a.getTime() > b.getTime()){
        var tmp = since; since = until; until = tmp;
      }

      this.currentTimeRange = { since: since, until: until };
      this.datePicker.since = since;
      this.datePicker.until = until;
      this.currentDatePreset = 'custom';
      this._pushRecentRange({ type:'custom', since: since, until: until });

      this._updateDateTriggerLabel();
      this.closeDatePicker();
      this.loadData();
    },

    // This function is left for compatibility if something still calls it.
    updateDateButtonsUI: function(){
      // keep last preset for reset behavior
      if(!this._lastPreset && !this.currentTimeRange) {
        this._lastPreset = this.datePicker.preset || 'last_7d';
      }
      this._updateDateTriggerLabel();
    },

    updateTabsUI: function(){
      var levels = ['campaigns','adsets','ads'];
      for(var i=0;i<levels.length;i++){
        var l = levels[i];
        var btn = document.querySelector('button[data-tab-level="'+l+'"]');
        if(!btn) continue;
        var active = this.currentLevel===l;
        btn.className = 'group relative px-6 py-3 text-sm font-bold transition-all border-b-2 flex items-center gap-2 ' + (active ? 'text-blue-400 border-blue-500 bg-blue-500/5' : 'text-gray-500 border-transparent hover:text-gray-300 hover:bg-gray-800/50');

        var cnt = (l==='campaigns') ? this.selectedCampaignIds.length : (l==='adsets'?this.selectedAdSetIds.length:this.selectedAdIds.length);
        var badge = document.getElementById('badge-'+l);
        var countEl = document.getElementById('count-'+l);
        if(badge && countEl){
          if(cnt>0){
            badge.classList.remove('hidden');
            countEl.textContent = String(cnt);
          } else {
            badge.classList.add('hidden');
          }
        }
      }
    },

    clearSelection: function(level){
      if(level==='campaigns'){
        this.selectedCampaignIds = [];
        // cascade clears
        this.selectedAdSetIds = [];
        this.selectedAdIds = [];
      } else if(level==='adsets'){
        this.selectedAdSetIds = [];
        this.selectedAdIds = [];
      } else if(level==='ads'){
        this.selectedAdIds = [];
      }
      this.updateTabsUI();
      this.updateBulkActionBar();
      this.renderTable();
    },

    clearCurrentSelection: function(){
      this.clearSelection(this.currentLevel);
    },

    // =====================
    // Data load
    // =====================
    loadData: function(){
      if(!this.selectedAccount){
        this.renderEmptyState('Selecione uma conta para começar');
        return;
      }
      if(!window.fbApi){
        this.renderEmptyState('API não carregada');
        return;
      }

      var loader = document.getElementById('table-loading');
      if(loader) loader.classList.remove('hidden');

      var token = this.selectedAccount.profileToken;
      var accountId = this.selectedAccount.id;
      var level = this.currentLevel;

      // Determine list request + insights level
      var listPromise;
      var insightsLevel;
      var listOptions = {};

      // Filtering rules:
      // - adsets: if campaigns selected, show adsets for those campaigns; else show all
      // - ads: if adsets selected, show ads for those adsets; else if campaigns selected, show ads for those campaigns; else show all
      if(level==='campaigns'){
        listPromise = window.fbApi.getCampaigns(accountId, token);
        insightsLevel = 'campaign';
      } else if(level==='adsets'){
        listOptions.campaignIds = this.selectedCampaignIds.slice();
        listPromise = window.fbApi.getAdSets(accountId, token, listOptions);
        insightsLevel = 'adset';
      } else {
        listOptions.adsetIds = this.selectedAdSetIds.slice();
        listOptions.campaignIds = this.selectedCampaignIds.slice();
        listPromise = window.fbApi.getAds(accountId, token, listOptions);
        insightsLevel = 'ad';
      }

      var fields = this._buildInsightsFieldsForSelectedColumns(insightsLevel);
      var filtering = this._buildInsightsFilteringForCurrentLevel();

      Promise.all([
        listPromise,
        window.fbApi.getInsightsForAccountLevel(accountId, token, insightsLevel, this.currentDatePreset, {
          fields: fields,
          filtering: filtering,
          time_range: this.currentTimeRange ? { since: this.currentTimeRange.since, until: this.currentTimeRange.until } : null
        })
      ])
        .then(res => {
          var items = res[0] || [];
          var insightRows = res[1] || [];
          var map = this._indexInsightsById(insightRows, insightsLevel);

          for(var i=0;i<items.length;i++){
            items[i].insights = map[String(items[i].id)] || {};
          }

          // detect currency
          if(this.selectedAccount && (!this.selectedAccount.currency || this.selectedAccount.currency==='BRL')){
            for(var k=0;k<insightRows.length;k++){
              if(insightRows[k] && insightRows[k].account_currency){
                this.selectedAccount.currency = insightRows[k].account_currency;
                break;
              }
            }
            this.ensureAccountCurrency();
            this.renderAccountButton();
          }

          this.data = items;

          // Clean selections not present in current level
          this._pruneSelectionForCurrentLevel();

          this.renderTableHead();
          this.renderTable();
          this.updateSelectAllState();
          this.updateBulkActionBar();
          this.updateTabsUI();
        })
        .catch(err => {
          if(window.logger) window.logger.error('Erro ao carregar dados', { error: String(err) });
          this.renderEmptyState('Erro ao carregar dados.');
        })
        .finally(() => {
          if(loader) loader.classList.add('hidden');
        });
    },

    _buildInsightsFilteringForCurrentLevel: function(){
      if(this.currentLevel==='adsets'){
        if(this.selectedCampaignIds.length) return [{ field: 'campaign.id', operator: 'IN', value: this.selectedCampaignIds.slice() }];
      }
      if(this.currentLevel==='ads'){
        if(this.selectedAdSetIds.length) return [{ field: 'adset.id', operator: 'IN', value: this.selectedAdSetIds.slice() }];
        if(this.selectedCampaignIds.length) return [{ field: 'campaign.id', operator: 'IN', value: this.selectedCampaignIds.slice() }];
      }
      return null;
    },

    _buildInsightsFieldsForSelectedColumns: function(insightsLevel){
      // Required id field must match insights level
      var idField = insightsLevel==='campaign' ? 'campaign_id' : (insightsLevel==='adset' ? 'adset_id' : 'ad_id');
      var f = {};
      f[idField] = true;
      f.account_currency = true;

      // Always include spend for sanity
      f.spend = true;

      // Add fields required by selected columns
      var cols = this.getSelectedColumns();
      for(var i=0;i<cols.length;i++){
        var c = cols[i];
        if(c.source==='insight' && c.field) f[c.field] = true;
        if((c.source==='derived' || c.source==='custom') && c.requiredFields){
          for(var j=0;j<c.requiredFields.length;j++) f[c.requiredFields[j]] = true;
        }
      }

      // Robustez: trazer `actions` e `cost_per_action_type` quando colunas derivadas precisam.
      // - IC depende de actions
      // - Resultados (compras) usa actions e pode precisar de cost_per_action_type para fallback
      // - CPR (custo por compra) depende de cost_per_action_type
      var needActions = false;
      var needCosts = false;
      for(var ii=0; ii<cols.length; ii++){
        if(cols[ii].key === 'ic') needActions = true;
        if(cols[ii].key === 'cpr' || cols[ii].key === 'results') needCosts = true;
      }
      if(needActions) f.actions = true;
      if(needCosts) f.cost_per_action_type = true;

      // Ensure base metrics are available for custom formulas if user uses them
      // (but keep light)
      return Object.keys(f).join(',');
    },

    _indexInsightsById: function(rows, insightsLevel){
      var keyField = insightsLevel==='campaign' ? 'campaign_id' : (insightsLevel==='adset' ? 'adset_id' : 'ad_id');
      var map = {};
      for(var i=0;i<(rows||[]).length;i++){
        var r = rows[i];
        if(r && r[keyField]) map[String(r[keyField])] = r;
      }
      return map;
    },

    _pruneSelectionForCurrentLevel: function(){
      var ids = (this.data||[]).map(x=>String(x.id));
      function prune(arr){
        return (arr||[]).filter(id => ids.indexOf(String(id))!==-1);
      }
      if(this.currentLevel==='campaigns') this.selectedCampaignIds = prune(this.selectedCampaignIds);
      if(this.currentLevel==='adsets') this.selectedAdSetIds = prune(this.selectedAdSetIds);
      if(this.currentLevel==='ads') this.selectedAdIds = prune(this.selectedAdIds);
    },

    // =====================
    // Table render
    // =====================
    renderTableHead: function(){
      var el = document.getElementById('ads-table-head-row');
      if(!el) return;
      var cols = this.getSelectedColumns();

      var html = '';
      html += '<th class="p-4 w-12 sticky left-0 z-20 bg-gray-900/95 backdrop-blur border-b border-gray-800"><div class="flex items-center justify-center"><input type="checkbox" id="select-all-header" class="chk"></div></th>';
      html += '<th class="p-4 w-16 text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800">On/Off</th>';
      html += '<th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800 min-w-[220px]">Nome</th>';

      for(var i=0;i<cols.length;i++){
        html += '<th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800 whitespace-nowrap text-right">'+this._esc(cols[i].label)+'</th>';
      }

      html += '<th class="p-4 w-16 border-b border-gray-800 sticky right-0 bg-gray-900/95 backdrop-blur z-20"></th>';
      el.innerHTML = html;
    },

    renderTable: function(){
      var tbody = document.getElementById('ads-table-body');
      if(!tbody) return;
      var total = document.getElementById('total-items');
      if(total) total.textContent = String((this.data||[]).length);

      if(!this.data || !this.data.length){
        tbody.innerHTML = '<tr><td colspan="99" class="py-24 text-center text-gray-500">Nenhum item encontrado</td></tr>';
        return;
      }

      var selArr = this._getCurrentSelectionArray();
      var cols = this.getSelectedColumns();

      var html = '';
      for(var i=0;i<this.data.length;i++){
        var item = this.data[i];
        var ins = item.insights || {};
        var selected = selArr.indexOf(item.id)!==-1;
        var active = String(item.status)==='ACTIVE';

        html += '<tr class="group border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors '+(selected?'bg-blue-900/10':'')+'">';

        html += '<td class="p-4 sticky left-0 bg-gray-900/95 group-hover:bg-gray-800/95 transition-colors z-10 border-r border-gray-800/50">'
              + '  <div class="flex items-center justify-center">'
              + '    <input type="checkbox" data-row-checkbox data-level="'+this.currentLevel+'" data-id="'+this._escAttr(item.id)+'" '+(selected?'checked':'')+' class="chk">'
              + '  </div>'
              + '</td>';

        html += '<td class="p-4">'
              + ' <label class="relative inline-flex items-center cursor-pointer">'
              + '  <input type="checkbox" class="sr-only peer" data-toggle-status="'+this._escAttr(item.id)+'" '+(active?'checked':'')+'>'
              + '  <div class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500 border border-gray-600 peer-checked:border-blue-500"></div>'
              + ' </label>'
              + '</td>';

        html += '<td class="p-4">'
              + ' <div class="flex flex-col max-w-[320px]">'
              + '   <span class="text-sm font-semibold text-white truncate" title="'+this._escAttr(item.name||'')+'">'+this._esc(item.name||'-')+'</span>'
              + '   <span class="text-[10px] text-gray-500 font-mono mt-0.5 select-all hover:text-gray-300 transition-colors">'+this._esc(item.id)+'</span>'
              + ' </div>'
              + '</td>';

        for(var c=0;c<cols.length;c++){
          html += '<td class="p-4 text-right text-sm text-gray-300 whitespace-nowrap tabular-nums">'+this._renderCell(item, ins, cols[c])+'</td>';
        }

        html += '<td class="p-4 sticky right-0 bg-gray-900/95 group-hover:bg-gray-800/95 transition-colors z-10 border-l border-gray-800/50 text-center">'
              + ' <div class="flex items-center justify-center gap-1">'
              + '   <button onclick="adsManager.openEditDrawer(\''+this._escAttr(item.id)+'\')" class="text-gray-500 hover:text-blue-400 p-2 rounded-lg hover:bg-blue-500/10 transition-all" title="Edição rápida">'
              + '     <i class="fas fa-pen"></i>'
              + '   </button>'
              + '   <button onclick="adsManager.openBuilder(\'edit\',\''+this.currentLevel.slice(0,-1)+'\',{ item: adsManager.data['+i+'] })" class="text-gray-500 hover:text-emerald-400 p-2 rounded-lg hover:bg-emerald-500/10 transition-all" title="Editar (Builder)">' 
              + '     <i class="fas fa-sliders-h"></i>'
              + '   </button>'
              + ' </div>'
              + '</td>';

        html += '</tr>';
      }

      tbody.innerHTML = html;
      this.updateSelectAllState();
    },

    // =====================
    // Selection
    // =====================
    _getSelectionArray: function(level){
      if(level==='campaigns') return this.selectedCampaignIds;
      if(level==='adsets') return this.selectedAdSetIds;
      return this.selectedAdIds;
    },
    _getCurrentSelectionArray: function(){
      return this._getSelectionArray(this.currentLevel);
    },

    handleItemSelect: function(level, id, checked){
      var arr = this._getSelectionArray(level);
      id = String(id);
      if(checked){
        if(arr.indexOf(id)===-1) arr.push(id);
      } else {
        var idx = arr.indexOf(id);
        if(idx!==-1) arr.splice(idx,1);
      }

      // When selecting adsets, keep ads selection but filtering in ads will prioritize adsets.
      this.updateTabsUI();
      this.updateSelectAllState();
      this.updateBulkActionBar();
    },

    handleSelectAll: function(checked){
      var arr = this._getCurrentSelectionArray();
      arr.length = 0;
      if(checked){
        for(var i=0;i<this.data.length;i++) arr.push(String(this.data[i].id));
      }
      this.renderTable();
      this.updateTabsUI();
      this.updateBulkActionBar();
    },

    updateSelectAllState: function(){
      var chk = document.getElementById('select-all-header');
      if(!chk) return;
      var arr = this._getCurrentSelectionArray();
      chk.checked = this.data.length && arr.length===this.data.length;
      chk.indeterminate = arr.length>0 && arr.length < this.data.length;
    },

    // =====================
    // Bulk action bar
    // =====================
    updateBulkActionBar: function(){
      var bar = document.getElementById('bulk-action-bar');
      if(!bar) return;
      var count = this._getCurrentSelectionArray().length;
      if(count>0){
        bar.classList.remove('hidden');
        var el = document.getElementById('bulk-selected-count');
        if(el) el.textContent = String(count);
        var label = document.getElementById('bulk-selected-label');
        if(label){
          label.textContent = (this.currentLevel==='campaigns'?'Campanhas':'') + (this.currentLevel==='adsets'?'Conjuntos':'') + (this.currentLevel==='ads'?'Anúncios':'') + ' selecionados';
        }
      } else {
        bar.classList.add('hidden');
      }
      var arch = document.getElementById('btn-bulk-archive');
      if(arch){
        arch.classList.toggle('hidden', this.currentLevel==='ads');
      }
    },

    bulkSetStatus: function(status){
      if(!this.selectedAccount) return;
      var ids = this._getCurrentSelectionArray().slice();
      if(!ids.length) return;
      if(this.currentLevel==='ads' && status==='ARCHIVED'){
        alert('Arquivar não é suportado para anúncios neste painel.');
        return;
      }
      if(!confirm('Alterar status de '+ids.length+' itens?')) return;

      var token = this.selectedAccount.profileToken;
      return this.withActionLoading(() => {
        var tasks = ids.map(id => () => window.fbApi.updateObject(id, { status: status }, token).catch(()=>false));
        return this._runPool(tasks, 4).then(()=>this.loadData());
      });
    },

    // =====================
    // Drawer edit
    // =====================
    openEditDrawer: function(id){
      var item = (this.data||[]).find(x => String(x.id)===String(id));
      if(!item) return;
      this.editingObject = item;

      var title = document.getElementById('edit-drawer-title');
      var sub = document.getElementById('edit-drawer-subtitle');
      if(title){
        var lvl = this.currentLevel==='campaigns'?'Campanha':(this.currentLevel==='adsets'?'Conjunto':'Anúncio');
        title.textContent = 'Editar ' + lvl;
      }
      if(sub) sub.textContent = 'ID: ' + item.id;

      var nameEl = document.getElementById('edit-name');
      var statusEl = document.getElementById('edit-status');
      var budgetGroup = document.getElementById('edit-budget-group');
      var budgetEl = document.getElementById('edit-budget');

      if(nameEl) nameEl.value = item.name || '';

      if(statusEl){
        // Ads do not accept ARCHIVED via this UI
        if(this.currentLevel==='ads'){
          statusEl.innerHTML = '<option value="ACTIVE">ATIVO</option><option value="PAUSED">PAUSADO</option>';
        } else {
          statusEl.innerHTML = '<option value="ACTIVE">ATIVO</option><option value="PAUSED">PAUSADO</option><option value="ARCHIVED">ARQUIVADO</option>';
        }
        statusEl.value = item.status || 'PAUSED';
      }

      // Budget only for campaigns/adsets
      if(budgetGroup){
        if(this.currentLevel==='campaigns' || this.currentLevel==='adsets'){
          var cents = null;
          var field = null;
          if(item.daily_budget){ field = 'daily_budget'; cents = parseInt(item.daily_budget,10); }
          else if(item.lifetime_budget){ field = 'lifetime_budget'; cents = parseInt(item.lifetime_budget,10); }
          if(field && budgetEl){
            budgetGroup.classList.remove('hidden');
            budgetEl.value = isNaN(cents)?'':(cents/100).toFixed(2);
          } else {
            budgetGroup.classList.add('hidden');
          }
        } else {
          budgetGroup.classList.add('hidden');
        }
      }

      // Ad preview
      var prevGroup = document.getElementById('edit-ad-preview-group');
      var prevLink = document.getElementById('edit-ad-preview-link');
      var prevCopy = document.getElementById('edit-ad-preview-copy');
      if(prevGroup){
        if(this.currentLevel==='ads' && item.preview_shareable_link){
          prevGroup.classList.remove('hidden');
          if(prevLink) prevLink.href = item.preview_shareable_link;
          if(prevCopy){
            prevCopy.onclick = () => {
              var link = String(item.preview_shareable_link);
              if(navigator && navigator.clipboard && navigator.clipboard.writeText){
                navigator.clipboard.writeText(link).then(()=>window.logger&&window.logger.success('Link copiado')).catch(()=>this._copyFallback(link));
              } else {
                this._copyFallback(link);
              }
            };
          }
        } else {
          prevGroup.classList.add('hidden');
        }
      }

      var drawer = document.getElementById('edit-drawer');
      if(drawer) drawer.classList.remove('translate-x-full');
    },

    _copyFallback: function(text){
      try{
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if(window.logger) window.logger.success('Copiado');
      } catch(e){
        if(window.logger) window.logger.warn('Falha ao copiar', { error: String(e) });
      }
    },

    closeEditDrawer: function(){
      var drawer = document.getElementById('edit-drawer');
      if(drawer) drawer.classList.add('translate-x-full');
      this.editingObject = null;
    },

    saveChanges: function(){
      if(!this.editingObject || !this.selectedAccount) return;

      var nameEl = document.getElementById('edit-name');
      var statusEl = document.getElementById('edit-status');
      var budgetGroup = document.getElementById('edit-budget-group');
      var budgetEl = document.getElementById('edit-budget');

      var updates = {};
      if(nameEl && nameEl.value !== (this.editingObject.name||'')) updates.name = nameEl.value;
      if(statusEl && statusEl.value !== (this.editingObject.status||'')) updates.status = statusEl.value;

      if((this.currentLevel==='campaigns' || this.currentLevel==='adsets') && budgetGroup && !budgetGroup.classList.contains('hidden') && budgetEl){
        var cents = Math.round(parseFloat(budgetEl.value||'0') * 100);
        if(!isNaN(cents)){
          var field = this.editingObject.daily_budget ? 'daily_budget' : (this.editingObject.lifetime_budget ? 'lifetime_budget' : null);
          if(field) updates[field] = cents;
        }
      }

      if(!Object.keys(updates).length){
        alert('Nenhuma alteração detectada.');
        return;
      }

      var token = this.selectedAccount.profileToken;
      var id = this.editingObject.id;

      return this.withActionLoading(() => {
        return window.fbApi.updateObject(id, updates, token)
          .then(()=>{
            this.closeEditDrawer();
            return this.loadData();
          });
      }).catch(err => alert('Erro ao salvar: ' + (err && err.message ? err.message : String(err))));
    },

    // =====================
    // Status toggle
    // =====================
    toggleStatus: function(id, checked){
      if(!this.selectedAccount) return;
      var token = this.selectedAccount.profileToken;
      var status = checked ? 'ACTIVE' : 'PAUSED';
      return this.withActionLoading(() => {
        return window.fbApi.updateObject(id, { status: status }, token)
          .then(()=>this.loadData());
      });
    },

    // =====================
    // Columns system
    // =====================
    _initColumns: function(){
      this.columnsCatalog = [
        { key: 'status', label: 'Status', source: 'object', format: 'badge' },
        { key: 'ic', label: 'IC', source: 'derived', derived: 'action_count', actionTypes: ['initiate_checkout','omni_initiated_checkout'], requiredFields: ['actions'], format: 'number' },
        // Alinhado ao Ads Manager: Resultados = Compras (purchase)
        // Observação: em alguns cenários a Meta pode retornar custo por compra em cost_per_action_type,
        // mas não retornar o count em actions. Por isso incluímos ambos para permitir fallback.
        { key: 'results', label: 'Resultados', source: 'derived', derived: 'purchase_count', requiredFields: ['cost_per_action_type'], format: 'number' },
        // Alinhado ao Ads Manager: Custo por Resultado = Custo por Compra (purchase)
        { key: 'cpr', label: 'Custo por Resultado', source: 'derived', derived: 'purchase_cost', requiredFields: ['cost_per_action_type'], format: 'currency' },
        { key: 'spend', label: 'Gasto', source: 'insight', field: 'spend', format: 'currency' },
        { key: 'impressions', label: 'Impressões', source: 'insight', field: 'impressions', format: 'number' },
        { key: 'reach', label: 'Alcance', source: 'insight', field: 'reach', format: 'number' },
        { key: 'clicks', label: 'Cliques', source: 'insight', field: 'clicks', format: 'number' },
        { key: 'ctr', label: 'CTR', source: 'insight', field: 'ctr', format: 'percent2' },
        { key: 'cpc', label: 'CPC', source: 'insight', field: 'cpc', format: 'currency' },
        { key: 'cpm', label: 'CPM', source: 'insight', field: 'cpm', format: 'currency' },
        { key: 'frequency', label: 'Frequência', source: 'insight', field: 'frequency', format: 'number2' },
        { key: 'daily_budget', label: 'Orçamento Diário', source: 'object', format: 'currency_budget' },
        { key: 'lifetime_budget', label: 'Orçamento Total', source: 'object', format: 'currency_budget' },
        { key: 'start_time', label: 'Início', source: 'object', format: 'date' }
      ];

      var stored = null;
      try{ stored = JSON.parse(localStorage.getItem('ads_columns_v1')||'null'); } catch(e) { stored = null; }
      this.customColumns = (stored && stored.customColumns) ? stored.customColumns : [];
      this.selectedColumnKeys = (stored && stored.selectedColumnKeys) ? stored.selectedColumnKeys : ['status','spend','results','cpr','ctr'];
      this._sanitizeSelectedColumns();
    },

    _sanitizeSelectedColumns: function(){
      var known = {};
      for(var i=0;i<this.columnsCatalog.length;i++) known[this.columnsCatalog[i].key] = true;
      var cleaned = [];
      for(var j=0;j<(this.selectedColumnKeys||[]).length;j++){
        var k = this.selectedColumnKeys[j];
        if(String(k).indexOf('custom:')===0){
          var id = String(k).split(':')[1];
          var cc = this.customColumns.find(x => String(x.id)===String(id));
          if(cc) cleaned.push(k);
        } else if(known[k]){
          cleaned.push(k);
        }
      }
      if(!cleaned.length) cleaned = ['status','spend','results','cpr','ctr'];
      this.selectedColumnKeys = cleaned;
    },

    _persistColumns: function(){
      try{
        localStorage.setItem('ads_columns_v1', JSON.stringify({ selectedColumnKeys: this.selectedColumnKeys, customColumns: this.customColumns }));
      } catch(e){}
    },

    _getColumnDefByKey: function(key){
      if(String(key).indexOf('custom:')===0){
        var id = String(key).split(':')[1];
        var cc = this.customColumns.find(x => String(x.id)===String(id));
        return cc || null;
      }
      return this.columnsCatalog.find(c => c.key === key) || null;
    },

    getSelectedColumns: function(){
      return (this.selectedColumnKeys||[]).map(k => this._getColumnDefByKey(k)).filter(Boolean);
    },

    openColumnsModal: function(){
      var m = document.getElementById('modal-columns');
      if(!m){ alert('Modal de colunas não encontrado'); return; }
      m.classList.remove('hidden');
      this.columnsSearch = '';
      var s = document.getElementById('columns-search');
      if(s) s.value = '';

      // init DnD now that modal exists in DOM
      this._initColumnsDnD();

      // reset scrolls
      try{
        var av = document.getElementById('columns-available');
        var se = document.getElementById('columns-selected');
        if(av && av.parentElement) av.parentElement.scrollTop = 0;
        if(se && se.parentElement) se.parentElement.scrollTop = 0;
      } catch(e){}
      this._renderColumnsModalLists();
    },

    closeColumnsModal: function(){
      var m = document.getElementById('modal-columns');
      if(m) m.classList.add('hidden');
    },

    filterColumns: function(q){
      this.columnsSearch = String(q||'').toLowerCase();
      this._renderColumnsModalLists();
    },

    resetColumnsToDefault: function(){
      this.selectedColumnKeys = ['status','spend','results','cpr','ctr'];
      this._renderColumnsModalLists();
    },

    addColumn: function(key){
      if(this.selectedColumnKeys.indexOf(key)===-1) this.selectedColumnKeys.push(key);
      this._renderColumnsModalLists();
    },

    removeColumn: function(key){
      this.selectedColumnKeys = (this.selectedColumnKeys||[]).filter(k => k!==key);
      this._renderColumnsModalLists();
    },

    moveColumn: function(key, dir){
      var idx = this.selectedColumnKeys.indexOf(key);
      if(idx===-1) return;
      var nidx = idx + dir;
      if(nidx<0 || nidx>=this.selectedColumnKeys.length) return;
      var tmp = this.selectedColumnKeys[idx];
      this.selectedColumnKeys[idx] = this.selectedColumnKeys[nidx];
      this.selectedColumnKeys[nidx] = tmp;
      this._renderColumnsModalLists();
    },

    addCustomColumnFromModal: function(){
      var nameEl = document.getElementById('custom-col-name');
      var formulaEl = document.getElementById('custom-col-formula');
      var name = nameEl ? String(nameEl.value||'').trim() : '';
      var formula = formulaEl ? String(formulaEl.value||'').trim() : '';
      if(!name || !formula){ alert('Preencha Nome e Fórmula'); return; }

      var id = String(Date.now());
      var col = {
        id: id,
        key: 'custom:' + id,
        label: name,
        source: 'custom',
        format: 'number2',
        formula: formula,
        requiredFields: ['spend','impressions','clicks','ctr','cpc','cpm','reach','frequency','actions','cost_per_action_type']
      };
      this.customColumns.push(col);
      this.selectedColumnKeys.push('custom:' + id);

      if(nameEl) nameEl.value = '';
      if(formulaEl) formulaEl.value = '';

      this._renderColumnsModalLists();
      if(window.logger) window.logger.success('Coluna personalizada adicionada', { name: name });
    },

    applyColumnsFromModal: function(){
      this._persistColumns();
      this.closeColumnsModal();
      this.renderTableHead();
      this.renderTable();
      if(this.selectedAccount) this.loadData();
    },

    _renderColumnsModalLists: function(){
      var availableEl = document.getElementById('columns-available');
      var selectedEl = document.getElementById('columns-selected');
      var countEl = document.getElementById('columns-selected-count');
      if(!availableEl || !selectedEl) return;

      // available list
      var htmlA = '';
      for(var i=0;i<this.columnsCatalog.length;i++){
        var c = this.columnsCatalog[i];
        var hay = (c.label+' '+c.key+' '+(c.field||'')).toLowerCase();
        if(this.columnsSearch && hay.indexOf(this.columnsSearch)===-1) continue;
        var isSel = this.selectedColumnKeys.indexOf(c.key)!==-1;
        htmlA += `
          <div class="columns-item">
            <div class="meta">
              <div class="title">${this._esc(c.label)}</div>
              <div class="sub">key: ${this._esc(c.key)}${c.field ? ' • field: '+this._esc(c.field):''}</div>
            </div>
            <button onclick="adsManager.${isSel?'removeColumn':'addColumn'}('${this._escAttr(c.key)}')" class="columns-btn ${isSel?'':'columns-btn-primary'}">${isSel?'Remover':'Adicionar'}</button>
          </div>
        `;
      }
      availableEl.innerHTML = htmlA || '<div class="p-4 text-sm text-gray-500">Nenhuma coluna encontrada.</div>';

      // selected list (includes custom) + drag
      var htmlS = '';
      for(var j=0;j<this.selectedColumnKeys.length;j++){
        var key = this.selectedColumnKeys[j];
        var def = this._getColumnDefByKey(key);
        if(!def) continue;
        var isCustom = String(key).indexOf('custom:')===0;
        htmlS += `
          <div class="columns-item columns-draggable" draggable="true" data-col-key="${this._escAttr(key)}">
            <div class="flex items-center gap-3 min-w-0">
              <div class="columns-grip" title="Arrastar para reordenar"><i class="fas fa-grip-vertical"></i></div>
              <div class="meta">
                <div class="title">${this._esc(def.label||key)}</div>
                <div class="sub">${isCustom?'custom':'key: '+this._esc(key)}</div>
              </div>
            </div>
            <div class="flex gap-2">
              <button onclick="adsManager.moveColumn('${this._escAttr(key)}',-1)" class="columns-icon-btn" title="Mover para cima"><i class="fas fa-arrow-up"></i></button>
              <button onclick="adsManager.moveColumn('${this._escAttr(key)}',1)" class="columns-icon-btn" title="Mover para baixo"><i class="fas fa-arrow-down"></i></button>
              <button onclick="adsManager.removeColumn('${this._escAttr(key)}')" class="columns-icon-btn" title="Remover"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        `;
      }
      selectedEl.innerHTML = htmlS || '<div class="p-4 text-sm text-gray-500">Nenhuma coluna selecionada.</div>';

      if(countEl) countEl.textContent = String(this.selectedColumnKeys.length);
    },

    // =====================
    // Bulk editor
    // =====================
    openBulkEditor: function(){
      if(!this.selectedAccount) return;
      var ids = this._getCurrentSelectionArray();
      if(!ids.length){ alert('Selecione itens para editar.'); return; }

      var level = this.currentLevel;
      this.bulk.isOpen = true;
      this.bulk.level = level;
      this.bulk.activeIndex = 0;

      // Build bulk items from current data snapshot
      var map = {};
      (this.data||[]).forEach(it => map[String(it.id)] = it);
      var items = [];
      for(var i=0;i<ids.length;i++){
        var id = String(ids[i]);
        var it = map[id];
        if(!it) continue;
        var budgetField = null;
        var budgetCents = 0;
        if(level!=='ads'){
          if(it.daily_budget){ budgetField='daily_budget'; budgetCents=parseInt(it.daily_budget,10)||0; }
          else if(it.lifetime_budget){ budgetField='lifetime_budget'; budgetCents=parseInt(it.lifetime_budget,10)||0; }
        }
        items.push({
          id: id,
          original: { id:id, name: it.name||'', status: it.status||'PAUSED' },
          updates: {},
          _budgetField: budgetField,
          _budgetCents: budgetCents
        });
      }
      this.bulk.items = items;

      // Show modal
      var m = document.getElementById('modal-bulk-editor');
      if(m) m.classList.remove('hidden');
      this.renderBulkEditor();
    },

    closeBulkEditor: function(){
      var m = document.getElementById('modal-bulk-editor');
      if(m) m.classList.add('hidden');
      this.bulk.isOpen = false;
      this.bulk.level = null;
      this.bulk.items = [];
      this.bulk.activeIndex = 0;
    },

    renderBulkEditor: function(){
      // toggle global budget group
      var g = document.getElementById('bulk-global-budget-group');
      if(g) g.classList.toggle('hidden', this.bulk.level==='ads');

      this._renderBulkEditorList();
      this._renderBulkPreview();
    },

    _getBulkFilterState: function(){
      var q = (document.getElementById('bulk-filter-q')||{}).value;
      var status = (document.getElementById('bulk-filter-status')||{}).value;
      var onlyChanged = !!((document.getElementById('bulk-filter-changed')||{}).checked);
      return { q: String(q||'').toLowerCase(), status: String(status||''), onlyChanged: onlyChanged };
    },

    _getBulkScope: function(){
      var s = document.getElementById('bulk-global-scope');
      var scope = s ? s.value : 'all';
      return scope || 'all';
    },

    _itemEffectiveStatus: function(item){
      if(item.updates && item.updates.status !== undefined) return String(item.updates.status);
      return String(item.original.status||'');
    },

    _itemMatchesFilter: function(item, filter){
      if(filter.onlyChanged){
        if(!item.updates || !Object.keys(item.updates).length) return false;
      }
      if(filter.status){
        if(this._itemEffectiveStatus(item) !== filter.status) return false;
      }
      if(filter.q){
        var hay = (item.original.name||'').toLowerCase() + ' ' + String(item.id);
        if(hay.indexOf(filter.q)===-1) return false;
      }
      return true;
    },

    _bulkVisibleIndexes: function(){
      var filter = this._getBulkFilterState();
      var out = [];
      for(var i=0;i<this.bulk.items.length;i++){
        if(this._itemMatchesFilter(this.bulk.items[i], filter)) out.push(i);
      }
      return out;
    },

    bulkSelectVisible: function(){
      var idxs = this._bulkVisibleIndexes();
      var arr = this._getSelectionArray(this.bulk.level || this.currentLevel);
      idxs.forEach(i => {
        var id = String(this.bulk.items[i].id);
        if(arr.indexOf(id)===-1) arr.push(id);
      });
      this.updateTabsUI();
      this.updateBulkActionBar();
      this.renderTable();
      this.renderBulkEditor();
    },

    bulkDeselectVisible: function(){
      var idxs = this._bulkVisibleIndexes();
      var arr = this._getSelectionArray(this.bulk.level || this.currentLevel);
      var toRemove = {};
      idxs.forEach(i => toRemove[String(this.bulk.items[i].id)] = true);
      var next = arr.filter(id => !toRemove[String(id)]);
      if(this.bulk.level==='campaigns') this.selectedCampaignIds = next;
      else if(this.bulk.level==='adsets') this.selectedAdSetIds = next;
      else this.selectedAdIds = next;

      this.updateTabsUI();
      this.updateBulkActionBar();
      this.renderTable();
      this.renderBulkEditor();
    },

    bulkApplyGlobal: function(){
      var scope = this._getBulkScope();
      var prefix = String((document.getElementById('bulk-global-prefix')||{}).value || '');
      var suffix = String((document.getElementById('bulk-global-suffix')||{}).value || '');
      var status = String((document.getElementById('bulk-global-status')||{}).value || '');
      var budgetStr = String((document.getElementById('bulk-global-budget')||{}).value || '');
      var budget = budgetStr ? Math.round(parseFloat(budgetStr) * 100) : null;

      var visibleIdxs = this._bulkVisibleIndexes();
      var filter = this._getBulkFilterState();

      function inScope(item, idx){
        var eff = adsManager._itemEffectiveStatus(item);
        if(scope==='all') return true;
        if(scope==='active') return eff==='ACTIVE';
        if(scope==='paused') return eff==='PAUSED';
        if(scope==='archived') return eff==='ARCHIVED';
        if(scope==='visible') return adsManager._itemMatchesFilter(item, filter);
        return true;
      }

      for(var i=0;i<this.bulk.items.length;i++){
        var item = this.bulk.items[i];
        if(!inScope(item, i)) continue;

        if(prefix || suffix){
          var base = item.updates.name !== undefined ? item.updates.name : item.original.name;
          // Prevent stacking repeatedly: rebuild from original
          base = item.original.name;
          item.updates.name = prefix + base + suffix;
        }
        if(status){
          item.updates.status = status;
        }
        if(this.bulk.level!=='ads' && budget !== null && !isNaN(budget) && item._budgetField){
          item.updates[item._budgetField] = budget;
        }
      }

      this.renderBulkEditor();
    },

    bulkClearAllUpdates: function(){
      for(var i=0;i<this.bulk.items.length;i++) this.bulk.items[i].updates = {};
      this.renderBulkEditor();
    },

    _bulkResetItem: function(i){
      if(!this.bulk.items[i]) return;
      this.bulk.items[i].updates = {};
      this.renderBulkEditor();
    },

    _bulkSetUpdate: function(i, key, value){
      var item = this.bulk.items[i];
      if(!item) return;
      if(!item.updates) item.updates = {};
      item.updates[key] = value;
      this._renderBulkPreview();
    },

    _bulkSetBudget: function(i, value){
      var item = this.bulk.items[i];
      if(!item || !item._budgetField) return;
      var cents = Math.round(parseFloat(value||'0') * 100);
      if(!item.updates) item.updates = {};
      if(isNaN(cents)) return;
      item.updates[item._budgetField] = cents;
      this._renderBulkPreview();
    },

    _renderBulkEditorList: function(){
      var container = document.getElementById('bulk-editor-list');
      if(!container) return;
      var filter = this._getBulkFilterState();

      var html = '';
      var shown = 0;
      for(var i=0;i<this.bulk.items.length;i++){
        var it = this.bulk.items[i];
        if(!this._itemMatchesFilter(it, filter)) continue;
        shown++;

        var changed = it.updates && Object.keys(it.updates).length>0;
        var active = i===this.bulk.activeIndex;
        var statusVal = (it.updates.status!==undefined) ? it.updates.status : it.original.status;
        var nameVal = (it.updates.name!==undefined) ? it.updates.name : it.original.name;

        var hasBudget = (this.bulk.level!=='ads') && it._budgetField;
        var budgetVal = '';
        if(hasBudget){
          var cents = (it.updates[it._budgetField]!==undefined) ? it.updates[it._budgetField] : it._budgetCents;
          budgetVal = (cents/100).toFixed(2);
        }

        html += `
          <div id="bulk-item-${i}" onclick="adsManager.bulk.activeIndex=${i}; adsManager._applyBulkActiveStyles()" class="group cursor-pointer rounded-2xl border transition-all duration-200 p-4 ${active ? 'bg-blue-900/10 border-blue-500/50' : 'bg-gray-900 border-gray-800 hover:border-gray-600'}">
            <div class="flex items-start justify-between gap-3 mb-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono text-gray-500">#${i+1}</span>
                  <span class="text-sm font-bold text-white truncate max-w-[240px]" title="${this._esc(it.original.name)}">${this._esc(it.original.name)}</span>
                  ${changed ? '<span class="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>' : ''}
                </div>
                <div class="text-[10px] font-mono text-gray-600 mt-0.5">${this._esc(it.id)}</div>
              </div>
              <button onclick="event.stopPropagation(); adsManager._bulkResetItem(${i})" class="text-gray-600 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors" title="Restaurar original"><i class="fas fa-undo"></i></button>
            </div>

            <div class="grid grid-cols-1 gap-3">
              <input type="text" value="${this._escAttr(nameVal)}" oninput="adsManager._bulkSetUpdate(${i},'name',this.value)" class="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-xs text-white focus:border-blue-500 outline-none" placeholder="Nome">
              <div class="grid grid-cols-2 gap-3">
                <select onchange="adsManager._bulkSetUpdate(${i},'status',this.value)" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-xs text-white">
                  <option value="ACTIVE" ${String(statusVal)==='ACTIVE'?'selected':''}>ATIVO</option>
                  <option value="PAUSED" ${String(statusVal)==='PAUSED'?'selected':''}>PAUSADO</option>
                  ${this.bulk.level!=='ads' ? `<option value="ARCHIVED" ${String(statusVal)==='ARCHIVED'?'selected':''}>ARQUIVADO</option>` : ''}
                </select>
                ${hasBudget ? `<div class="relative"><span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">R$</span><input type="number" step="0.01" value="${this._escAttr(budgetVal)}" oninput="adsManager._bulkSetBudget(${i},this.value)" class="w-full bg-gray-950 border border-gray-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white"></div>` : '<div></div>'}
              </div>
            </div>
          </div>
        `;
      }

      container.innerHTML = html || '<div class="p-8 text-center text-gray-500">Nenhum item corresponde aos filtros.</div>';
      this._applyBulkActiveStyles();
    },

    _applyBulkActiveStyles: function(){
      for(var i=0;i<this.bulk.items.length;i++){
        var el = document.getElementById('bulk-item-'+i);
        if(!el) continue;
        if(i===this.bulk.activeIndex) el.classList.add('ring-2','ring-blue-500');
        else el.classList.remove('ring-2','ring-blue-500');
      }
    },

    _renderBulkPreview: function(){
      var sum = document.getElementById('bulk-preview-summary');
      var box = document.getElementById('bulk-preview');
      if(!sum || !box) return;

      var changed = [];
      for(var i=0;i<this.bulk.items.length;i++){
        var it = this.bulk.items[i];
        if(it.updates && Object.keys(it.updates).length) changed.push(it);
      }

      sum.textContent = changed.length + ' item(ns) com alterações';

      if(!changed.length){
        box.innerHTML = '<div class="text-gray-500">Nenhuma alteração para enviar.</div>';
        return;
      }

      // Build a compact list of fields
      var fields = {};
      changed.forEach(it => {
        Object.keys(it.updates).forEach(k => fields[k]=true);
      });
      var fieldList = Object.keys(fields);

      box.innerHTML = `
        <div class="flex flex-wrap gap-2">
          ${fieldList.map(f => `<span class="px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-[10px] font-bold text-gray-300">${this._esc(f)}</span>`).join('')}
        </div>
        <div class="mt-3 text-gray-500">Ao salvar, o sistema enviará apenas os campos alterados.</div>
      `;
    },

    bulkSaveAll: function(){
      if(!this.selectedAccount) return;
      var token = this.selectedAccount.profileToken;

      var toUpdate = [];
      for(var i=0;i<this.bulk.items.length;i++){
        var it = this.bulk.items[i];
        if(it.updates && Object.keys(it.updates).length){
          // Prevent ARCHIVED on ads
          if(this.bulk.level==='ads' && it.updates.status==='ARCHIVED') delete it.updates.status;
          if(Object.keys(it.updates).length) toUpdate.push(it);
        }
      }

      if(!toUpdate.length){
        alert('Nenhuma alteração para salvar.');
        return;
      }

      if(!confirm('Salvar alterações de '+toUpdate.length+' itens na Meta?')) return;

      return this.withActionLoading(() => {
        var tasks = toUpdate.map(it => () => window.fbApi.updateObject(it.id, it.updates, token).then(()=>true).catch(()=>false));
        return this._runPool(tasks, 4)
          .then(()=>{
            this.closeBulkEditor();
            return this.loadData();
          });
      });
    },

    // =====================
    // Rendering helpers
    // =====================
    _renderCell: function(item, ins, col){
      try{
        var v = null;
        if(col.source==='object') v = item[col.key];
        else if(col.source==='insight') v = ins[col.field];
        else if(col.source==='derived') v = this._computeDerived(col, item, ins);
        else if(col.source==='custom') v = this._evalCustomColumn(col, item, ins);
        return this._formatValue(v, col.format);
      } catch(e){
        return '<span class="text-gray-700">-</span>';
      }
    },

    _formatValue: function(v, fmt){
      if(v===undefined || v===null || v==='') return '<span class="text-gray-700">-</span>';

      if(fmt==='badge'){
        var st = String(v);
        var c = st==='ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' : (st==='ARCHIVED'?'bg-red-500/10 text-red-400 border-red-500/20':'bg-yellow-500/10 text-yellow-400 border-yellow-500/20');
        return '<span class="inline-flex px-2 py-0.5 rounded text-[10px] font-bold border '+c+'">'+this._esc(st)+'</span>';
      }

      if(fmt==='currency'){
        // Allow null/undefined to show dash when metric does not exist (ex: CPR without purchases)
        if(v===null) return '<span class="text-gray-700">-</span>';
        var n = parseFloat(v); if(isNaN(n)) n=0;
        return '<span class="font-medium text-white">'+this._esc(this.formatCurrency(n))+'</span>';
      }

      if(fmt==='currency_budget'){
        var nb = parseFloat(v); if(isNaN(nb)) nb=0;
        nb = nb/100;
        return '<span class="font-medium text-white">'+this._esc(this.formatCurrency(nb))+'</span>';
      }

      if(fmt==='number'){
        var nn = parseFloat(v); if(isNaN(nn)) nn=0;
        return this._esc(this.formatNumber(nn));
      }

      if(fmt==='number2'){
        var n2 = parseFloat(v); if(isNaN(n2)) n2=0;
        return this._esc(n2.toFixed(2));
      }

      if(fmt==='percent2'){
        var p = parseFloat(v); if(isNaN(p)) p=0;
        return this._esc(p.toFixed(2)) + '%';
      }

      if(fmt==='date'){
        try{
          return this._esc(new Date(v).toLocaleDateString('pt-BR'));
        } catch(e){ return this._esc(String(v)); }
      }

      return this._esc(String(v));
    },

    _computeDerived: function(col, item, ins){
      if(col.derived==='action_count'){
        var m = this._actionsToMap(ins.actions);
        var sum = 0;
        (col.actionTypes||[]).forEach(t => sum += (m[t]||0));
        return sum;
      }

      // Resultados = "Compras" no Ads Manager.
      // Para ficar 100% determinístico e evitar duplicidade por múltiplos action_types,
      // calculamos exclusivamente via: spend / CPP (cost_per_action_type).
      // Isso assume que a coluna "Custo por Resultado" (CPP) está correta.
      // Se não houver CPP, retorna 0.
      if(col.derived==='purchase_count'){
        var cpa = this._actionsToMap(ins.cost_per_action_type);
        var cpp = null;
        // prioridades (mantidas para bater com CPR)
        if(cpa['purchase'] !== undefined) cpp = cpa['purchase'];
        else if(cpa['offsite_conversion.fb_pixel_purchase'] !== undefined) cpp = cpa['offsite_conversion.fb_pixel_purchase'];
        else if(cpa['omni_purchase'] !== undefined) cpp = cpa['omni_purchase'];
        else if(cpa['onsite_conversion.purchase'] !== undefined) cpp = cpa['onsite_conversion.purchase'];
        else if(cpa['app_custom_event.fb_mobile_purchase'] !== undefined) cpp = cpa['app_custom_event.fb_mobile_purchase'];

        var spend = parseFloat(ins.spend || 0) || 0;
        var cppNum = parseFloat(cpp);
        if(!cppNum || cppNum <= 0) return 0;
        // Quanto mais próximo do Ads Manager, melhor arredondar para inteiro.
        return Math.round(spend / cppNum);
      }

      // Custo por Resultado = custo por compra (purchase) como no Ads Manager
      // Também evita duplicidade: prioriza uma chave principal (não soma).
      if(col.derived==='purchase_cost'){
        var c1 = this._actionsToMap(ins.cost_per_action_type);
        if(c1['purchase'] !== undefined) return c1['purchase'];
        if(c1['offsite_conversion.fb_pixel_purchase'] !== undefined) return c1['offsite_conversion.fb_pixel_purchase'];
        if(c1['omni_purchase'] !== undefined) return c1['omni_purchase'];
        if(c1['onsite_conversion.purchase'] !== undefined) return c1['onsite_conversion.purchase'];
        if(c1['app_custom_event.fb_mobile_purchase'] !== undefined) return c1['app_custom_event.fb_mobile_purchase'];
        return null; // sem compra -> mostra "—"
      }

      // Backward compatibility (se existirem regras/colunas antigas armazenadas)
      if(col.derived==='best_result_count'){
        var a = this._actionsToMap(ins.actions);
        var grps = [['purchase','omni_purchase','offsite_conversion.fb_pixel_purchase'],['lead','omni_lead'],['initiate_checkout','omni_initiated_checkout'],['link_click']];
        for(var i=0;i<grps.length;i++){
          var s = 0;
          for(var j=0;j<grps[i].length;j++) s += (a[grps[i][j]]||0);
          if(s>0) return s;
        }
        return 0;
      }
      if(col.derived==='best_result_cost'){
        var c = this._actionsToMap(ins.cost_per_action_type);
        var order = ['purchase','omni_purchase','offsite_conversion.fb_pixel_purchase','lead','omni_lead','initiate_checkout','omni_initiated_checkout','link_click'];
        for(var k=0;k<order.length;k++){
          if(c[order[k]]!==undefined) return c[order[k]];
        }
        return null;
      }
      return 0;
    },

    _actionsToMap: function(arr){
      var m = {};
      (arr||[]).forEach(x => {
        if(!x || !x.action_type) return;
        m[x.action_type] = parseFloat(x.value||0) || 0;
      });
      return m;
    },

    _evalCustomColumn: function(col, item, ins){
      try{
        var ctx = {
          spend: parseFloat(ins.spend||0) || 0,
          impressions: parseFloat(ins.impressions||0) || 0,
          clicks: parseFloat(ins.clicks||0) || 0,
          ctr: parseFloat(ins.ctr||0) || 0,
          cpc: parseFloat(ins.cpc||0) || 0,
          cpm: parseFloat(ins.cpm||0) || 0,
          reach: parseFloat(ins.reach||0) || 0,
          frequency: parseFloat(ins.frequency||0) || 0,
          actions: this._actionsToMap(ins.actions||[]),
          cost_per_action_type: this._actionsToMap(ins.cost_per_action_type||[])
        };
        // eslint-disable-next-line no-new-func
        var fn = new Function('ctx', 'with(ctx){ return ('+col.formula+'); }');
        var res = fn(ctx);
        if(res===undefined || res===null || res!==res) return 0; // NaN
        return res;
      } catch(e){
        return 0;
      }
    },

    // =====================
    // Empty state
    // =====================
    renderEmptyState: function(msg){
      var tbody = document.getElementById('ads-table-body');
      if(tbody) tbody.innerHTML = '<tr><td colspan="99" class="py-24 text-center text-gray-500">'+this._esc(msg)+'</td></tr>';
    },

    // =====================
    // Events
    // =====================
    bindEvents: function(){
      document.addEventListener('change', (e) => {
        var t = e.target;
        if(!t) return;

        if(t.id==='select-all-header'){
          this.handleSelectAll(t.checked);
          return;
        }

        if(t.hasAttribute('data-row-checkbox')){
          this.handleItemSelect(t.getAttribute('data-level'), t.getAttribute('data-id'), t.checked);
          return;
        }

        if(t.hasAttribute('data-toggle-status')){
          this.toggleStatus(t.getAttribute('data-toggle-status'), t.checked);
          return;
        }
      });

      document.addEventListener('keydown', (e) => {
        if(e.key==='Escape'){
          // close modals/drawer best-effort
          this.closeEditDrawer();
          this.closeColumnsModal();
          this.closeBulkEditor();
          this.closeAccountModal();
        }
      });
    },

    _initColumnsDnD: function(){
      if(this._columnsDnDBound) return;
      var cont = document.getElementById('columns-selected');
      if(!cont) return;
      this._columnsDnDBound = true;
      this._draggingColKey = null;

      cont.addEventListener('dragstart', (e) => {
        var item = e.target && e.target.closest ? e.target.closest('[data-col-key]') : null;
        if(!item) return;
        this._draggingColKey = item.getAttribute('data-col-key');
        item.classList.add('is-dragging');
        try{
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', this._draggingColKey);
        } catch(err){}
      });

      cont.addEventListener('dragover', (e) => {
        if(!this._draggingColKey) return;
        e.preventDefault();
        var over = e.target && e.target.closest ? e.target.closest('[data-col-key]') : null;
        cont.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
        if(over && over.getAttribute('data-col-key') !== this._draggingColKey){
          over.classList.add('is-drag-over');
        }
      });

      cont.addEventListener('drop', (e) => {
        if(!this._draggingColKey) return;
        e.preventDefault();
        var target = e.target && e.target.closest ? e.target.closest('[data-col-key]') : null;
        var dragKey = this._draggingColKey;
        this._draggingColKey = null;

        cont.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
        cont.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));

        if(!target) return;
        var targetKey = target.getAttribute('data-col-key');
        if(!targetKey || targetKey === dragKey) return;

        var from = this.selectedColumnKeys.indexOf(dragKey);
        var to = this.selectedColumnKeys.indexOf(targetKey);
        if(from === -1 || to === -1) return;

        // Decide before/after based on mouse position
        var rect = target.getBoundingClientRect();
        var before = (e.clientY < rect.top + rect.height/2);

        this.selectedColumnKeys.splice(from, 1);
        // When removing earlier index, target index shifts
        if(from < to) to = to - 1;
        var insertAt = before ? to : to + 1;
        if(insertAt < 0) insertAt = 0;
        if(insertAt > this.selectedColumnKeys.length) insertAt = this.selectedColumnKeys.length;
        this.selectedColumnKeys.splice(insertAt, 0, dragKey);

        this._renderColumnsModalLists();
      });

      cont.addEventListener('dragend', (e) => {
        cont.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
        cont.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));
        this._draggingColKey = null;
      });
    },

    // =====================
    // Utilities
    // =====================
    _runPool: function(fns, max){
      max = max || 4;
      var idx = 0;
      var self = this;
      function next(){
        if(idx >= fns.length) return Promise.resolve();
        var fn = fns[idx++];
        return Promise.resolve().then(fn).then(next);
      }
      var workers = [];
      for(var i=0;i<Math.min(max, fns.length);i++) workers.push(next());
      return Promise.all(workers);
    },

    _esc: function(s){
      return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
    },
    _escAttr: function(s){
      return this._esc(String(s)).replace(/'/g,'&#039;');
    }
  };

  // Alias: openBuilder is provided by js/ads-manager/builder.js, but keep a safe stub to avoid console errors.
  if(typeof adsManager.openBuilder !== 'function'){
    adsManager.openBuilder = function(){
      alert('Builder ainda não carregou. Recarregue a página (Ctrl+F5).');
    };
  }

  window.adsManager = adsManager;
})();
