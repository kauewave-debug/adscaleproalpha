/**
 * Ads Manager – Builder UI (Campaign/AdSet/Ad)
 * UI-first wizard: stepper + live preview + draft persistence
 * + Create Campaign (v6.1)
 * + Create AdSet (v7.1)
 * + Create Ad Creative (v8.1)
 * Version: 1.4
 */
(function(){
  function $(id){ return document.getElementById(id); }

  function ensureAdsManager(){
    if(!window.adsManager){
      console.warn('[builder] window.adsManager not found');
      return null;
    }
    return window.adsManager;
  }

  function setText(el, txt){ if(el) el.textContent = String(txt || '—'); }

  function toIsoFromDatetimeLocal(v){
    try{
      v = String(v||'').trim();
      if(!v) return null;
      var dt = new Date(v);
      if(String(dt) === 'Invalid Date') return null;
      return dt.toISOString();
    } catch(e){
      return null;
    }
  }

  function clamp(n, a, b){
    n = parseInt(n,10);
    if(isNaN(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

  function parseCountriesFromGeoInput(s){
    // Very light heuristic.
    // Accepts: "BR", "Brasil", "Brazil", "US", "USA", "Portugal" etc.
    // Returns array of ISO2 country codes.
    s = String(s||'').trim();
    if(!s) return ['BR'];

    var parts = s.split(',').map(function(x){ return String(x||'').trim(); }).filter(Boolean);
    if(!parts.length) parts = [s];

    var map = {
      'brasil':'BR','brazil':'BR','br':'BR',
      'portugal':'PT','pt':'PT',
      'estados unidos':'US','usa':'US','united states':'US','us':'US',
      'mexico':'MX','méxico':'MX','mx':'MX',
      'argentina':'AR','ar':'AR'
    };

    var out = [];
    for(var i=0;i<parts.length;i++){
      var p = parts[i];
      var low = p.toLowerCase();
      if(map[low]){ out.push(map[low]); continue; }
      if(/^[A-Za-z]{2}$/.test(p)) out.push(p.toUpperCase());
    }

    if(!out.length) out = ['BR'];
    // de-dup
    var seen = {};
    var dedup = [];
    out.forEach(function(c){ if(!seen[c]){ seen[c]=true; dedup.push(c);} });
    return dedup;
  }

  var builder = {
    _builder: {
      isOpen: false,
      mode: 'create',
      level: 'campaign',
      step: 0,
      previewOpen: true,
      _listenersBound: false,
      _draftKey: 'ads_builder_draft_v1',
      editContext: null, // { level, item }
      // cache
      _campaignOptionsCache: {}, // key: actId|token => [{id,name}]
      _adsetOptionsCache: {} // key: actId|token => [{id,name}]
    },

    // =========
    // Public API
    // =========
    openBuilder: function(mode, level, opts){
      var self = this;
      mode = (String(mode||'create').toLowerCase()==='edit') ? 'edit' : 'create';
      level = String(level||'campaign');
      opts = opts || {};

      this._builder.mode = mode;
      this._builder.level = level;
      this._builder.step = (level==='adset') ? 1 : (level==='ad' ? 2 : 0);
      this._builder.editContext = (mode==='edit' && opts.item) ? { level: level, item: opts.item } : null;

      var modal = $('modal-campaign-builder');
      if(modal) modal.classList.remove('hidden');
      this._builder.isOpen = true;

      // chips
      var modeChip = $('builder-mode-chip');
      if(modeChip) modeChip.textContent = (mode==='edit') ? 'EDITAR' : 'CRIAR';

      // title/subtitle
      var title = $('builder-title');
      var subtitle = $('builder-subtitle');
      if(title){
        var t = (level==='adset') ? 'conjunto' : (level==='ad' ? 'anúncio' : 'campanha');
        title.textContent = (mode==='edit') ? ('Editar ' + t) : ('Criar ' + t);
      }
      if(subtitle){
        subtitle.textContent = 'Configure sua estrutura como no Gerenciador de Anúncios da Meta';
      }

      this._bindBuilderInputsOnce();
      this._syncAdsetConversionsVisibility();

      if(mode==='edit' && opts.item){
        this._resetBuilderForm();
        // Ensure dropdowns exist
        Promise.all([this._ensureCampaignOptions(), this._ensureAdSetOptions()]).then(function(){
          self._prefillFromItem(level, opts.item);
          self.builderGoStep(self._builder.step);
          self._syncPreview();
        });
      } else {
        // Create
        this._loadDraftIfAny();
        // Preload dropdowns
        this._ensureCampaignOptions();
        this._ensureAdSetOptions();
        this.builderGoStep(this._builder.step);
        this._syncPreview();
      }

      setTimeout(function(){
        var focusId = (self._builder.step===0) ? 'builder-campaign-name' : (self._builder.step===1 ? 'builder-adset-name' : 'builder-ad-name');
        var el = $(focusId);
        if(el) el.focus();
      }, 50);

      if(window.logger) window.logger.info('Builder aberto (UI)', { mode: mode, level: level, hasItem: !!opts.item });
    },

    closeBuilder: function(){
      var modal = $('modal-campaign-builder');
      if(modal) modal.classList.add('hidden');
      this._builder.isOpen = false;
      this._builder.editContext = null;
    },

    builderTogglePreview: function(){
      this._builder.previewOpen = !this._builder.previewOpen;
      var preview = $('builder-preview');
      if(preview){
        preview.classList.toggle('hidden', !this._builder.previewOpen);
      }
    },

    builderGoStep: function(step){
      step = parseInt(step, 10);
      if(isNaN(step) || step < 0) step = 0;
      if(step > 2) step = 2;
      this._builder.step = step;

      for(var i=0;i<3;i++){
        var p = $('builder-step-panel-'+i);
        if(p) p.classList.toggle('hidden', i!==step);
      }

      this._syncStepperUI();
      this._syncLevelChip();
      this._syncPreview();
      this._syncAdsetConversionsVisibility();

      // When user navigates to adset step, ensure campaigns list exists
      if(step === 1) this._ensureCampaignOptions();
      // When user navigates to ad step, ensure adsets list exists
      if(step === 2) this._ensureAdSetOptions();
    },

    _ensureAdSetOptions: function(){
      var am = window.adsManager;
      if(!am || !am.selectedAccount || !am.selectedAccount.profileToken || !window.fbApi) return Promise.resolve([]);

      var actId = String(am.selectedAccount.id || '');
      var token = String(am.selectedAccount.profileToken || '');
      var cacheKey = actId + '|' + token;

      var sel = $('builder-ad-adset-id');
      if(!sel) return Promise.resolve([]);

      if(sel.options && sel.options.length > 1 && this._builder._adsetOptionsCache[cacheKey]){
        return Promise.resolve(this._builder._adsetOptionsCache[cacheKey]);
      }

      if(sel.options.length <= 1){
        sel.innerHTML = '<option value="">Carregando conjuntos...</option>';
      }

      var self = this;
      return window.fbApi.getAdSets(actId, token, null)
        .then(function(list){
          list = list || [];
          var options = list.map(function(a){ return { id: String(a.id), name: String(a.name||a.id), campaign_id: String(a.campaign_id||'') }; });
          self._builder._adsetOptionsCache[cacheKey] = options;

          var html = '<option value="">Selecione um conjunto...</option>';
          for(var i=0;i<options.length;i++){
            html += '<option value="' + self._escAttr(options[i].id) + '">' + self._esc(options[i].name) + '</option>';
          }
          sel.innerHTML = html;
          return options;
        })
        .catch(function(err){
          sel.innerHTML = '<option value="">(Falha ao carregar conjuntos)</option>';
          if(window.logger) window.logger.warn('Falha ao carregar adsets no builder', { error: String(err) });
          return [];
        });
    },

    builderNext: function(){ this.builderGoStep(this._builder.step + 1); },

    builderBack: function(){
      if(this._builder.step === 0){
        this.closeBuilder();
        return;
      }
      this.builderGoStep(this._builder.step - 1);
    },

    builderOnBudgetTypeChange: function(){ this._syncPreview(); },

    builderSaveDraft: function(){
      if(this._builder.mode === 'edit'){
        if(window.logger) window.logger.warn('Rascunho ignorado (modo editar)');
        return;
      }
      var draft = this._readBuilderForm();
      try{
        localStorage.setItem(this._builder._draftKey, JSON.stringify({ savedAt: new Date().toISOString(), draft: draft }));
        if(window.logger) window.logger.success('Rascunho salvo', { savedAt: new Date().toLocaleString('pt-BR') });
      } catch(e){
        if(window.logger) window.logger.warn('Falha ao salvar rascunho', { error: String(e) });
      }
    },

    builderPrimaryAction: function(){
      var mode = this._builder.mode;
      var ctx = this._builder.editContext;

      var am = window.adsManager;
      if(!am || !am.selectedAccount || !am.selectedAccount.profileToken){
        alert('Selecione uma conta de anúncios antes de continuar.');
        return;
      }
      if(!window.fbApi){
        alert('API não carregada. Recarregue a página (Ctrl+F5).');
        return;
      }

      var token = am.selectedAccount.profileToken;
      var d = this._readBuilderForm();

      // ==========================
      // CREATE
      // ==========================
      if(mode === 'create'){
        var levelCreate = String(this._builder.level || 'campaign');

        // CREATE: Campaign (can also publish full structure Campaign → AdSet → Ad)
        if(levelCreate === 'campaign'){
          if(typeof window.fbApi.createCampaign !== 'function'){
            alert('Função createCampaign não disponível na API. Recarregue a página (Ctrl+F5).');
            return;
          }

          var name = String(d.campaign.name||'').trim();
          if(!name){
            alert('Informe o nome da campanha.');
            var nEl = document.getElementById('builder-campaign-name');
            if(nEl) nEl.focus();
            return;
          }

          // Heuristic: if user is on step 3 and filled AdSet+Ad basics, publish full structure.
          var wantsFull = (this._builder.step === 2) && String(d.adset.name||'').trim() && String(d.ad.name||'').trim();

          var payload = {
            name: name,
            status: String(d.campaign.status||'PAUSED'),
            objective: String(d.campaign.objective||'OUTCOME_SALES'),
            special_ad_categories: '[]'
          };

          var bType = String(d.campaign.budget_type||'daily_budget');
          var bVal = String(d.campaign.budget||'').trim();
          if(bVal){
            var cents = Math.round(parseFloat(bVal) * 100);
            if(!isNaN(cents) && cents > 0){
              if(bType === 'lifetime_budget') payload.lifetime_budget = cents;
              else payload.daily_budget = cents;
            }
          }

          // Helpers for full structure
          function addUtm(baseUrl, utmSource, utmCampaign){
            try{
              var u2 = new URL(baseUrl);
              if(utmSource) u2.searchParams.set('utm_source', utmSource);
              if(utmCampaign) u2.searchParams.set('utm_campaign', utmCampaign);
              return u2.toString();
            } catch(e){
              var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
              var parts = [];
              if(utmSource) parts.push('utm_source=' + encodeURIComponent(utmSource));
              if(utmCampaign) parts.push('utm_campaign=' + encodeURIComponent(utmCampaign));
              return parts.length ? (baseUrl + sep + parts.join('&')) : baseUrl;
            }
          }
          function extractFirstImageHash(res){
            try{
              if(!res) return null;
              if(res.images && typeof res.images === 'object'){
                for(var k in res.images){
                  if(res.images[k] && res.images[k].hash) return String(res.images[k].hash);
                }
              }
              if(res.hash) return String(res.hash);
            } catch(e){}
            return null;
          }

          var self = this;
          return am.withActionLoading(function(){
            var actId = am.selectedAccount.id;

            // 1) Create campaign
            return window.fbApi.createCampaign(actId, payload, token)
              .then(function(cRes){
                var campaignId = cRes && cRes.id ? String(cRes.id) : null;
                if(!campaignId) throw new Error('Campanha criada mas ID não retornou.');

                if(window.logger) window.logger.success('Campanha criada', { id: campaignId, name: payload.name, objective: payload.objective });

                if(!wantsFull){
                  // Only campaign
                  try{ localStorage.removeItem(self._builder._draftKey); } catch(e) {}
                  if(am && typeof am.setViewLevel === 'function') am.setViewLevel('campaigns');
                  if(am && typeof am.loadData === 'function') return am.loadData().then(function(){ self.closeBuilder(); });
                  self.closeBuilder();
                  return;
                }

                // Validate AdSet minimal
                if(typeof window.fbApi.createAdSet !== 'function') throw new Error('createAdSet indisponível.');

                var adsetName = String(d.adset.name||'').trim();
                if(!adsetName) throw new Error('Informe o nome do conjunto.');

                var optimization = String(d.adset.optimization_goal||'OFFSITE_CONVERSIONS');
                var billing = String(d.adset.billing_event||'IMPRESSIONS');
                var adsetStatus = String(d.adset.status||'PAUSED');

                var startIso = toIsoFromDatetimeLocal(d.adset.start_time);
                if(!startIso) startIso = new Date(Date.now() + 5*60*1000).toISOString();
                var endIso = toIsoFromDatetimeLocal(d.adset.end_time);

                var countries = parseCountriesFromGeoInput(d.adset.geo);
                var ageMin = clamp(d.adset.age_min || 18, 13, 65);
                var ageMax = clamp(d.adset.age_max || 65, 13, 65);
                if(ageMax < ageMin){ var tmp = ageMin; ageMin = ageMax; ageMax = tmp; }

                var targeting = {
                  geo_locations: { countries: countries },
                  age_min: ageMin,
                  age_max: ageMax
                };

                var adsetPayload = {
                  name: adsetName,
                  campaign_id: campaignId,
                  status: adsetStatus,
                  optimization_goal: optimization,
                  billing_event: billing,
                  start_time: startIso,
                  targeting: JSON.stringify(targeting)
                };
                if(endIso) adsetPayload.end_time = endIso;

                var abType = String(d.adset.budget_type||'daily_budget');
                var abVal = String(d.adset.budget||'').trim();
                if(abVal){
                  var cents2 = Math.round(parseFloat(abVal) * 100);
                  if(!isNaN(cents2) && cents2 > 0){
                    if(abType === 'lifetime_budget') adsetPayload.lifetime_budget = cents2;
                    else adsetPayload.daily_budget = cents2;
                  }
                }

                var pixelId = String(d.adset.pixel_id||'').trim();
                var evt = String(d.adset.event||'PURCHASE').trim();
                if(optimization === 'OFFSITE_CONVERSIONS' && pixelId){
                  adsetPayload.promoted_object = JSON.stringify({ pixel_id: pixelId, custom_event_type: evt });
                }

                // 2) Create AdSet
                return window.fbApi.createAdSet(actId, adsetPayload, token)
                  .then(function(aRes){
                    var adsetId = aRes && aRes.id ? String(aRes.id) : null;
                    if(!adsetId) throw new Error('Conjunto criado mas ID não retornou.');
                    if(window.logger) window.logger.success('Conjunto criado', { id: adsetId, name: adsetPayload.name });

                    // Validate Ad minimal
                    if(typeof window.fbApi.createAdImage !== 'function' || typeof window.fbApi.createAdCreative !== 'function' || typeof window.fbApi.createAd !== 'function'){
                      throw new Error('Funções de criação de anúncio indisponíveis.');
                    }

                    var adName = String(d.ad.name||'').trim();
                    if(!adName) throw new Error('Informe o nome do anúncio.');
                    var pageId = String(d.ad.page_id||'').trim();
                    if(!pageId) throw new Error('Informe o ID da Página (page_id).');
                    var primaryText = String(d.ad.primary_text||'').trim();
                    if(!primaryText) throw new Error('Informe o texto principal do anúncio.');
                    var headline = String(d.ad.headline||'').trim();
                    if(!headline) throw new Error('Informe a headline do anúncio.');
                    var cta = String(d.ad.cta||'SHOP_NOW').trim();
                    var url = String(d.ad.url||'').trim();
                    if(!url) throw new Error('Informe a URL do site.');
                    var imgUrl = String(d.ad.image_url||'').trim();
                    if(!imgUrl) throw new Error('Informe a URL pública da imagem.');

                    var statusAd = String(d.ad.status||'PAUSED').trim();
                    var finalUrl = addUtm(url, String(d.ad.utm_source||'').trim(), String(d.ad.utm_campaign||'').trim());

                    // 3) Image → hash
                    return window.fbApi.createAdImage(actId, imgUrl, token)
                      .then(function(imgRes){
                        var imageHash = extractFirstImageHash(imgRes);
                        if(!imageHash) throw new Error('Não foi possível obter image_hash da imagem.');

                        // 4) Creative
                        var creativePayload = {
                          name: 'Creative - ' + adName,
                          object_story_spec: JSON.stringify({
                            page_id: pageId,
                            link_data: {
                              message: primaryText,
                              link: finalUrl,
                              name: headline,
                              image_hash: imageHash,
                              call_to_action: {
                                type: cta,
                                value: { link: finalUrl }
                              }
                            }
                          })
                        };

                        return window.fbApi.createAdCreative(actId, creativePayload, token)
                          .then(function(crRes){
                            var creativeId = crRes && crRes.id ? String(crRes.id) : null;
                            if(!creativeId) throw new Error('Não foi possível obter creative_id.');

                            // 5) Ad
                            var adPayload = {
                              name: adName,
                              adset_id: adsetId,
                              status: statusAd,
                              creative: JSON.stringify({ creative_id: creativeId })
                            };

                            return window.fbApi.createAd(actId, adPayload, token)
                              .then(function(adRes){
                                var adId = adRes && adRes.id ? String(adRes.id) : null;
                                if(window.logger) window.logger.success('Estrutura completa criada', { campaign_id: campaignId, adset_id: adsetId, ad_id: adId });

                                try{ localStorage.removeItem(self._builder._draftKey); } catch(e2) {}

                                // Focus the UI on what was created
                                try{
                                  am.selectedCampaignIds = [campaignId];
                                  am.selectedAdSetIds = [adsetId];
                                  if(adId) am.selectedAdIds = [adId];
                                } catch(e3){}

                                if(am && typeof am.setViewLevel === 'function') am.setViewLevel('ads');
                                if(am && typeof am.loadData === 'function') return am.loadData();
                              })
                              .then(function(){ self.closeBuilder(); });
                          });
                      });
                  });
              })
              .catch(function(err){
                throw err;
              });
          }).catch(function(err){
            alert('Erro ao publicar: ' + (err && err.message ? err.message : String(err)));
          });
        }

        // CREATE: AdSet
        if(levelCreate === 'adset'){
          if(typeof window.fbApi.createAdSet !== 'function'){
            alert('Função createAdSet não disponível na API. Recarregue a página (Ctrl+F5).');
            return;
          }

          var campaignId = String(d.adset.campaign_id||'').trim();
          if(!campaignId){
            alert('Selecione uma campanha para criar o conjunto.');
            var cSel = document.getElementById('builder-adset-campaign-id');
            if(cSel) cSel.focus();
            return;
          }

          var adsetName = String(d.adset.name||'').trim();
          if(!adsetName){
            alert('Informe o nome do conjunto.');
            var an = document.getElementById('builder-adset-name');
            if(an) an.focus();
            return;
          }

          var optimization = String(d.adset.optimization_goal||'OFFSITE_CONVERSIONS');
          var billing = String(d.adset.billing_event||'IMPRESSIONS');
          var status = String(d.adset.status||'PAUSED');

          var startIso = toIsoFromDatetimeLocal(d.adset.start_time);
          if(!startIso){
            // Meta often requires start_time; default to now + 5min
            startIso = new Date(Date.now() + 5*60*1000).toISOString();
          }
          var endIso = toIsoFromDatetimeLocal(d.adset.end_time);

          // Targeting (minimal viable)
          var countries = parseCountriesFromGeoInput(d.adset.geo);
          var ageMin = clamp(d.adset.age_min || 18, 13, 65);
          var ageMax = clamp(d.adset.age_max || 65, 13, 65);
          if(ageMax < ageMin){ var tmp = ageMin; ageMin = ageMax; ageMax = tmp; }

          var targeting = {
            geo_locations: { countries: countries },
            age_min: ageMin,
            age_max: ageMax
          };

          var payload2 = {
            name: adsetName,
            campaign_id: campaignId,
            status: status,
            optimization_goal: optimization,
            billing_event: billing,
            start_time: startIso,
            targeting: JSON.stringify(targeting)
          };

          if(endIso) payload2.end_time = endIso;

          // Budget optional
          var abType = String(d.adset.budget_type||'daily_budget');
          var abVal = String(d.adset.budget||'').trim();
          if(abVal){
            var cents2 = Math.round(parseFloat(abVal) * 100);
            if(!isNaN(cents2) && cents2 > 0){
              if(abType === 'lifetime_budget') payload2.lifetime_budget = cents2;
              else payload2.daily_budget = cents2;
            }
          }

          // Promoted object when conversions (optional; best-effort)
          var pixelId = String(d.adset.pixel_id||'').trim();
          var evt = String(d.adset.event||'PURCHASE').trim();
          if(optimization === 'OFFSITE_CONVERSIONS' && pixelId){
            payload2.promoted_object = JSON.stringify({ pixel_id: pixelId, custom_event_type: evt });
          }

          var self2 = this;
          return am.withActionLoading(function(){
            return window.fbApi.createAdSet(am.selectedAccount.id, payload2, token)
              .then(function(){
                if(window.logger) window.logger.success('Conjunto criado', { name: payload2.name, campaign_id: payload2.campaign_id });
                try{ localStorage.removeItem(self2._builder._draftKey); } catch(e) {}

                // help user: filter by this campaign
                try{ am.selectedCampaignIds = [campaignId]; } catch(e2) {}
                if(am && typeof am.setViewLevel === 'function') am.setViewLevel('adsets');
                if(am && typeof am.loadData === 'function') return am.loadData();
              })
              .then(function(){ self2.closeBuilder(); });
          }).catch(function(err){
            alert('Erro ao criar conjunto: ' + (err && err.message ? err.message : String(err)));
          });
        }

        // CREATE: Ad (Creative -> Ad)
        if(levelCreate === 'ad'){
          if(typeof window.fbApi.createAdImage !== 'function' || typeof window.fbApi.createAdCreative !== 'function' || typeof window.fbApi.createAd !== 'function'){
            alert('Funções de criação de anúncio não disponíveis na API. Recarregue a página (Ctrl+F5).');
            return;
          }

          var adsetId = String(d.ad.adset_id||'').trim();
          if(!adsetId){
            alert('Selecione um Conjunto (AdSet) para criar o anúncio.');
            var asSel = document.getElementById('builder-ad-adset-id');
            if(asSel) asSel.focus();
            return;
          }

          var pageId = String(d.ad.page_id||'').trim();
          if(!pageId){
            alert('Informe o ID da Página (page_id).');
            var pg = document.getElementById('builder-ad-page-id');
            if(pg) pg.focus();
            return;
          }

          var adName = String(d.ad.name||'').trim();
          if(!adName){
            alert('Informe o nome do anúncio.');
            var anm = document.getElementById('builder-ad-name');
            if(anm) anm.focus();
            return;
          }

          var primaryText = String(d.ad.primary_text||'').trim();
          if(!primaryText){
            alert('Informe o texto principal do anúncio.');
            var pt = document.getElementById('builder-ad-primary-text');
            if(pt) pt.focus();
            return;
          }

          var headline = String(d.ad.headline||'').trim();
          if(!headline){
            alert('Informe a headline do anúncio.');
            var hl = document.getElementById('builder-ad-headline');
            if(hl) hl.focus();
            return;
          }

          var cta = String(d.ad.cta||'SHOP_NOW').trim();

          var url = String(d.ad.url||'').trim();
          if(!url){
            alert('Informe a URL do site.');
            var u = document.getElementById('builder-ad-url');
            if(u) u.focus();
            return;
          }

          var imgUrl = '';
          try{ imgUrl = String((document.getElementById('builder-ad-image-url')||{}).value||'').trim(); } catch(e0){ imgUrl = ''; }
          if(!imgUrl){
            alert('Informe a URL pública da imagem para criar o criativo.');
            var iu = document.getElementById('builder-ad-image-url');
            if(iu) iu.focus();
            return;
          }

          var statusAd = String(d.ad.status||'PAUSED').trim();

          function addUtm(baseUrl, utmSource, utmCampaign){
            try{
              var u2 = new URL(baseUrl);
              if(utmSource) u2.searchParams.set('utm_source', utmSource);
              if(utmCampaign) u2.searchParams.set('utm_campaign', utmCampaign);
              return u2.toString();
            } catch(e){
              // fallback naive
              var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
              var parts = [];
              if(utmSource) parts.push('utm_source=' + encodeURIComponent(utmSource));
              if(utmCampaign) parts.push('utm_campaign=' + encodeURIComponent(utmCampaign));
              return parts.length ? (baseUrl + sep + parts.join('&')) : baseUrl;
            }
          }

          var finalUrl = addUtm(url, String(d.ad.utm_source||'').trim(), String(d.ad.utm_campaign||'').trim());

          function extractFirstImageHash(res){
            try{
              if(!res) return null;
              // common: { images: { <key>: { hash } } }
              if(res.images && typeof res.images === 'object'){
                for(var k in res.images){
                  if(res.images[k] && res.images[k].hash) return String(res.images[k].hash);
                }
              }
              // alternative shapes
              if(res.hash) return String(res.hash);
            } catch(e){}
            return null;
          }

          var selfAd = this;
          return am.withActionLoading(function(){
            var actId = am.selectedAccount.id;

            if(window.logger) window.logger.info('Criando anúncio (8.1/8.2)...', { adset_id: adsetId, page_id: pageId });

            // 8.1 - Create image hash
            return window.fbApi.createAdImage(actId, imgUrl, token)
              .then(function(imgRes){
                var imageHash = extractFirstImageHash(imgRes);
                if(!imageHash) throw new Error('Não foi possível obter image_hash da imagem.');

                if(window.logger) window.logger.success('Imagem enviada (hash)', { image_hash: imageHash });

                // 8.1 - Create creative
                var creativePayload = {
                  name: 'Creative - ' + adName,
                  object_story_spec: JSON.stringify({
                    page_id: pageId,
                    link_data: {
                      message: primaryText,
                      link: finalUrl,
                      name: headline,
                      image_hash: imageHash,
                      call_to_action: {
                        type: cta,
                        value: { link: finalUrl }
                      }
                    }
                  })
                };

                return window.fbApi.createAdCreative(actId, creativePayload, token)
                  .then(function(crRes){
                    var creativeId = crRes && crRes.id ? String(crRes.id) : null;
                    if(!creativeId) throw new Error('Não foi possível obter creative_id.');
                    if(window.logger) window.logger.success('Criativo criado', { creative_id: creativeId });

                    // 8.2 - Create ad
                    var adPayload = {
                      name: adName,
                      adset_id: adsetId,
                      status: statusAd,
                      creative: JSON.stringify({ creative_id: creativeId })
                    };

                    return window.fbApi.createAd(actId, adPayload, token)
                      .then(function(adRes){
                        if(window.logger) window.logger.success('Anúncio criado', adRes);
                        try{ localStorage.removeItem(selfAd._builder._draftKey); } catch(e2) {}
                        if(am && typeof am.setViewLevel === 'function') am.setViewLevel('ads');
                        if(am && typeof am.loadData === 'function') return am.loadData();
                      })
                      .then(function(){ selfAd.closeBuilder(); });
                  });
              });
          }).catch(function(err){
            alert('Erro ao criar anúncio: ' + (err && err.message ? err.message : String(err)));
          });
        }

        alert('Criação: nível inválido.');
        return;
      }

      // ==========================
      // EDIT
      // ==========================
      if(mode !== 'edit'){
        alert('Modo inválido.');
        return;
      }

      if(!ctx || !ctx.item || !ctx.item.id){
        alert('Nada para editar.');
        return;
      }

      if(typeof window.fbApi.updateObject !== 'function'){
        alert('API não carregada. Recarregue a página (Ctrl+F5).');
        return;
      }

      var level = String(ctx.level||'campaign');
      var item = ctx.item;

      var updates = {};
      var successMsg = 'Atualizado';

      if(level === 'campaign'){
        successMsg = 'Campanha atualizada';
        var newName = String(d.campaign.name||'').trim();
        if(newName && newName !== String(item.name||'')) updates.name = newName;
        var newStatus = String(d.campaign.status||'').trim();
        if(newStatus && newStatus !== String(item.status||'')) updates.status = newStatus;

        var bType2 = String(d.campaign.budget_type||'').trim();
        var bVal2 = String(d.campaign.budget||'').trim();
        if(bVal2){
          var cents3 = Math.round(parseFloat(bVal2) * 100);
          if(!isNaN(cents3)){
            if(bType2 === 'lifetime_budget') updates.lifetime_budget = cents3;
            else updates.daily_budget = cents3;
          }
        }
      } else if(level === 'adset'){
        successMsg = 'Conjunto atualizado';
        var aName2 = String(d.adset.name||'').trim();
        if(aName2 && aName2 !== String(item.name||'')) updates.name = aName2;

        var newStatus2 = String(d.adset.status||'').trim();
        if(newStatus2 && newStatus2 !== String(item.status||'')) updates.status = newStatus2;

        var opt2 = String(d.adset.optimization_goal||'').trim();
        if(opt2 && opt2 !== String(item.optimization_goal||'')) updates.optimization_goal = opt2;

        var bill2 = String(d.adset.billing_event||'').trim();
        if(bill2 && bill2 !== String(item.billing_event||'')) updates.billing_event = bill2;

        var stIso2 = toIsoFromDatetimeLocal(d.adset.start_time);
        if(stIso2 && stIso2 !== String(item.start_time||'')) updates.start_time = stIso2;

        var enIso2 = toIsoFromDatetimeLocal(d.adset.end_time);
        if(enIso2){
          if(enIso2 !== String(item.end_time||'')) updates.end_time = enIso2;
        }

        var abType2 = String(d.adset.budget_type||'').trim();
        var abVal2 = String(d.adset.budget||'').trim();
        if(abVal2){
          var cents4 = Math.round(parseFloat(abVal2) * 100);
          if(!isNaN(cents4)){
            if(abType2 === 'lifetime_budget') updates.lifetime_budget = cents4;
            else updates.daily_budget = cents4;
          }
        }
      } else if(level === 'ad'){
        successMsg = 'Anúncio atualizado';
        var adName3 = String(d.ad.name||'').trim();
        if(adName3 && adName3 !== String(item.name||'')) updates.name = adName3;
        var adStatus2 = String(d.ad.status||'').trim();
        if(adStatus2 && adStatus2 !== String(item.status||'')) updates.status = adStatus2;

        // Optional: update creative (Meta-like flow)
        // If user filled creative fields, we create a NEW creative and point the Ad to it.
        var wantsCreativeUpdate = false;
        var pageId2 = String(d.ad.page_id||'').trim();
        var primaryText2 = String(d.ad.primary_text||'').trim();
        var headline2 = String(d.ad.headline||'').trim();
        var cta2 = String(d.ad.cta||'SHOP_NOW').trim();
        var url2 = String(d.ad.url||'').trim();
        var imgUrl2 = String(d.ad.image_url||'').trim();

        // We consider a creative update if any of these fields is provided.
        if(pageId2 || primaryText2 || headline2 || url2 || imgUrl2) wantsCreativeUpdate = true;

        var selfAdEdit = this;

        function addUtm(baseUrl, utmSource, utmCampaign){
          try{
            var u2 = new URL(baseUrl);
            if(utmSource) u2.searchParams.set('utm_source', utmSource);
            if(utmCampaign) u2.searchParams.set('utm_campaign', utmCampaign);
            return u2.toString();
          } catch(e){
            var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
            var parts = [];
            if(utmSource) parts.push('utm_source=' + encodeURIComponent(utmSource));
            if(utmCampaign) parts.push('utm_campaign=' + encodeURIComponent(utmCampaign));
            return parts.length ? (baseUrl + sep + parts.join('&')) : baseUrl;
          }
        }

        function extractFirstImageHash(res){
          try{
            if(!res) return null;
            if(res.images && typeof res.images === 'object'){
              for(var k in res.images){
                if(res.images[k] && res.images[k].hash) return String(res.images[k].hash);
              }
            }
            if(res.hash) return String(res.hash);
          } catch(e){}
          return null;
        }

        // Replace the default update flow below if creative update is required.
        if(wantsCreativeUpdate){
          // Validate minimum creative fields
          if(!pageId2){ alert('Para editar o criativo, informe o ID da Página (page_id).'); return; }
          if(!primaryText2){ alert('Para editar o criativo, informe o Texto principal.'); return; }
          if(!headline2){ alert('Para editar o criativo, informe a Headline.'); return; }
          if(!url2){ alert('Para editar o criativo, informe a URL do site.'); return; }
          if(!imgUrl2){ alert('Para editar o criativo, informe a URL pública da imagem.'); return; }

          if(typeof window.fbApi.createAdImage !== 'function' || typeof window.fbApi.createAdCreative !== 'function'){
            alert('Funções de criativo não disponíveis. Recarregue a página (Ctrl+F5).');
            return;
          }

          // We'll run the full chain inside withActionLoading later.
          updates._wantsCreativeUpdate = true;
          updates._creativePayload = {
            page_id: pageId2,
            primary_text: primaryText2,
            headline: headline2,
            cta: cta2,
            url: url2,
            image_url: imgUrl2,
            utm_source: String(d.ad.utm_source||'').trim(),
            utm_campaign: String(d.ad.utm_campaign||'').trim()
          };
        }
      } else {
        alert('Nível inválido para edição.');
        return;
      }

      if(!Object.keys(updates).length){
        alert('Nenhuma alteração detectada.');
        return;
      }

      var self3 = this;
      return am.withActionLoading(function(){
        // Handle creative update chain for Ads
        if(level === 'ad' && updates._wantsCreativeUpdate){
          var actId = am.selectedAccount.id;
          var cp = updates._creativePayload;
          // Cleanup helper-only keys before final update
          delete updates._wantsCreativeUpdate;
          delete updates._creativePayload;

          var finalUrl2 = addUtm(cp.url, cp.utm_source, cp.utm_campaign);

          // 1) upload image by URL -> hash
          return window.fbApi.createAdImage(actId, cp.image_url, token)
            .then(function(imgRes){
              var imageHash = extractFirstImageHash(imgRes);
              if(!imageHash) throw new Error('Não foi possível obter image_hash da imagem.');

              // 2) create creative
              var creativePayload2 = {
                name: 'Creative (edit) - ' + (adName3 || String(item.name||'Anúncio')),
                object_story_spec: JSON.stringify({
                  page_id: cp.page_id,
                  link_data: {
                    message: cp.primary_text,
                    link: finalUrl2,
                    name: cp.headline,
                    image_hash: imageHash,
                    call_to_action: {
                      type: cp.cta,
                      value: { link: finalUrl2 }
                    }
                  }
                })
              };

              return window.fbApi.createAdCreative(actId, creativePayload2, token)
                .then(function(crRes){
                  var creativeId = crRes && crRes.id ? String(crRes.id) : null;
                  if(!creativeId) throw new Error('Não foi possível obter creative_id.');

                  // 3) update ad to point to new creative
                  updates.creative = JSON.stringify({ creative_id: creativeId });
                  return window.fbApi.updateObject(item.id, updates, token);
                });
            });
        }

        // Default update
        return window.fbApi.updateObject(item.id, updates, token);
      }).then(function(){
        if(window.logger) window.logger.success(successMsg, { id: item.id, updates: Object.keys(updates) });
        if(am && typeof am.loadData === 'function') return am.loadData();
      }).then(function(){
        self3.closeBuilder();
      }).catch(function(err){
        alert('Erro ao salvar: ' + (err && err.message ? err.message : String(err)));
      });
    },

    // =========
    // Internals
    // =========
    _ensureCampaignOptions: function(){
      var am = window.adsManager;
      if(!am || !am.selectedAccount || !am.selectedAccount.profileToken || !window.fbApi) return Promise.resolve([]);

      var actId = String(am.selectedAccount.id || '');
      var token = String(am.selectedAccount.profileToken || '');
      var cacheKey = actId + '|' + token;

      var sel = $('builder-adset-campaign-id');
      if(!sel) return Promise.resolve([]);

      // If we already loaded and the select has options, skip.
      if(sel.options && sel.options.length > 1 && this._builder._campaignOptionsCache[cacheKey]){
        return Promise.resolve(this._builder._campaignOptionsCache[cacheKey]);
      }

      // Placeholder
      if(sel.options.length <= 1){
        sel.innerHTML = '<option value="">Carregando campanhas...</option>';
      }

      var self = this;
      return window.fbApi.getCampaigns(actId, token)
        .then(function(list){
          list = list || [];
          // Keep only id+name
          var options = list.map(function(c){ return { id: String(c.id), name: String(c.name||c.id) }; });
          self._builder._campaignOptionsCache[cacheKey] = options;

          var html = '<option value="">Selecione uma campanha...</option>';
          for(var i=0;i<options.length;i++){
            html += '<option value="' + self._escAttr(options[i].id) + '">' + self._esc(options[i].name) + '</option>';
          }
          sel.innerHTML = html;
          return options;
        })
        .catch(function(err){
          sel.innerHTML = '<option value="">(Falha ao carregar campanhas)</option>';
          if(window.logger) window.logger.warn('Falha ao carregar campanhas no builder', { error: String(err) });
          return [];
        });
    },

    _bindBuilderInputsOnce: function(){
      if(this._builder._listenersBound) return;
      this._builder._listenersBound = true;

      var self = this;
      var ids = [
        'builder-campaign-name','builder-campaign-objective','builder-campaign-status','builder-campaign-budget-type','builder-campaign-budget','builder-campaign-abtest','builder-campaign-advplus',
        'builder-adset-campaign-id','builder-adset-name','builder-adset-optimization','builder-adset-billing','builder-adset-status','builder-adset-pixel-id','builder-adset-event','builder-adset-start','builder-adset-end','builder-adset-budget-type','builder-adset-budget','builder-adset-age-min','builder-adset-age-max','builder-adset-geo',
        'builder-ad-name','builder-ad-status','builder-ad-adset-id','builder-ad-page-id','builder-ad-primary-text','builder-ad-headline','builder-ad-cta','builder-ad-url','builder-ad-image-url','builder-utm-source','builder-utm-campaign'
      ];

      ids.forEach(function(id){
        var el = $(id);
        if(!el) return;
        el.addEventListener('input', function(){ self._syncPreview(); });
        el.addEventListener('change', function(){ self._syncPreview(); self._syncAdsetConversionsVisibility(); });
      });

      document.addEventListener('keydown', function(e){
        if(e.key === 'Escape' && self._builder.isOpen){
          self.closeBuilder();
        }
      });
    },

    _syncAdsetConversionsVisibility: function(){
      var opt = ($('builder-adset-optimization')||{}).value || '';
      var group = $('builder-adset-conversions');
      if(!group) return;
      // Show only when OFFSITE_CONVERSIONS
      group.classList.toggle('hidden', String(opt) !== 'OFFSITE_CONVERSIONS');
    },

    _syncStepperUI: function(){
      var step = this._builder.step;
      var steps = [
        { id: 'builder-step-campaign', num: 1 },
        { id: 'builder-step-adset', num: 2 },
        { id: 'builder-step-ad', num: 3 }
      ];

      for(var i=0;i<steps.length;i++){
        var btn = $(steps[i].id);
        if(!btn) continue;

        btn.className = 'builder-step w-full text-left rounded-2xl border transition-all px-4 py-3 ' +
          (i===step
            ? 'bg-blue-500/10 border-blue-500/30 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]'
            : 'bg-gray-900/40 border-gray-800 hover:border-gray-600 hover:bg-gray-800/30');

        try{
          var pill = btn.querySelector('div.w-9.h-9');
          if(pill){
            pill.className = 'w-9 h-9 rounded-xl flex items-center justify-center font-extrabold ' +
              (i===step
                ? 'bg-blue-500/10 border border-blue-500/20 text-blue-300'
                : 'bg-gray-800 border border-gray-700 text-gray-300');
          }
        } catch(e){}
      }
    },

    _syncLevelChip: function(){
      var chip = $('builder-level-chip');
      if(!chip) return;
      var step = this._builder.step;
      chip.textContent = step===0 ? 'CAMPANHA' : (step===1 ? 'CONJUNTO' : 'ANÚNCIO');
    },

    _resetBuilderForm: function(){
      try{
        var ids = [
          'builder-campaign-name','builder-campaign-objective','builder-campaign-status','builder-campaign-budget-type','builder-campaign-budget',
          'builder-adset-campaign-id','builder-adset-name','builder-adset-optimization','builder-adset-billing','builder-adset-status','builder-adset-pixel-id','builder-adset-event','builder-adset-start','builder-adset-end','builder-adset-budget-type','builder-adset-budget','builder-adset-age-min','builder-adset-age-max','builder-adset-geo',
          'builder-ad-name','builder-ad-status','builder-ad-adset-id','builder-ad-page-id','builder-ad-primary-text','builder-ad-headline','builder-ad-cta','builder-ad-url','builder-ad-image-url','builder-utm-source','builder-utm-campaign'
        ];
        ids.forEach(function(id){
          var el = $(id);
          if(!el) return;
          if(el.type === 'checkbox') el.checked = false;
          else el.value = '';
        });

        // defaults
        if($('builder-campaign-objective')) $('builder-campaign-objective').value = 'OUTCOME_SALES';
        if($('builder-campaign-status')) $('builder-campaign-status').value = 'PAUSED';
        if($('builder-campaign-budget-type')) $('builder-campaign-budget-type').value = 'daily_budget';

        if($('builder-adset-optimization')) $('builder-adset-optimization').value = 'OFFSITE_CONVERSIONS';
        if($('builder-adset-billing')) $('builder-adset-billing').value = 'IMPRESSIONS';
        if($('builder-adset-status')) $('builder-adset-status').value = 'PAUSED';
        if($('builder-adset-budget-type')) $('builder-adset-budget-type').value = 'daily_budget';
        if($('builder-adset-age-min')) $('builder-adset-age-min').value = '18';
        if($('builder-adset-age-max')) $('builder-adset-age-max').value = '65';

        if($('builder-ad-cta')) $('builder-ad-cta').value = 'SHOP_NOW';
        if($('builder-ad-status')) $('builder-ad-status').value = 'PAUSED';
      } catch(e){}
    },

    _prefillFromItem: function(level, item){
      item = item || {};

      if(level === 'campaign'){
        if($('builder-campaign-name')) $('builder-campaign-name').value = item.name || '';
        if($('builder-campaign-status')) $('builder-campaign-status').value = item.status || 'PAUSED';
        var cents = item.daily_budget || item.lifetime_budget;
        if(cents){
          if(item.daily_budget && $('builder-campaign-budget-type')) $('builder-campaign-budget-type').value = 'daily_budget';
          if(item.lifetime_budget && $('builder-campaign-budget-type')) $('builder-campaign-budget-type').value = 'lifetime_budget';
          if($('builder-campaign-budget')) $('builder-campaign-budget').value = (parseInt(cents,10)/100).toFixed(2);
        }
      }

      if(level === 'adset'){
        if($('builder-adset-name')) $('builder-adset-name').value = item.name || '';
        if($('builder-adset-status')) $('builder-adset-status').value = item.status || 'PAUSED';
        if($('builder-adset-optimization')) $('builder-adset-optimization').value = item.optimization_goal || 'OFFSITE_CONVERSIONS';
        if($('builder-adset-billing')) $('builder-adset-billing').value = item.billing_event || 'IMPRESSIONS';

        if($('builder-adset-campaign-id')) {
          // Campaign might not be in options yet. Ensure options are loaded before setting.
          try{ $('builder-adset-campaign-id').value = item.campaign_id || ''; } catch(e0){}
        }

        if(item.start_time && $('builder-adset-start')) {
          try{ $('builder-adset-start').value = String(item.start_time).slice(0,16); } catch(e){}
        }
        if(item.end_time && $('builder-adset-end')) {
          try{ $('builder-adset-end').value = String(item.end_time).slice(0,16); } catch(e2){}
        }
        var cents2 = item.daily_budget || item.lifetime_budget;
        if(cents2){
          if(item.daily_budget && $('builder-adset-budget-type')) $('builder-adset-budget-type').value = 'daily_budget';
          if(item.lifetime_budget && $('builder-adset-budget-type')) $('builder-adset-budget-type').value = 'lifetime_budget';
          if($('builder-adset-budget')) $('builder-adset-budget').value = (parseInt(cents2,10)/100).toFixed(2);
        }
      }

      if(level === 'ad'){
        if($('builder-ad-name')) $('builder-ad-name').value = item.name || '';
        if($('builder-ad-status')) $('builder-ad-status').value = item.status || 'PAUSED';
        if($('builder-ad-adset-id')) {
          try{ $('builder-ad-adset-id').value = item.adset_id || ''; } catch(e3){}
        }
      }

      this._syncAdsetConversionsVisibility();
      this._syncPreview();
    },

    _readBuilderForm: function(){
      function val(id){ var e=$(id); return e ? e.value : ''; }
      function chk(id){ var e=$(id); return e ? !!e.checked : false; }

      return {
        campaign: {
          name: val('builder-campaign-name'),
          objective: val('builder-campaign-objective'),
          status: val('builder-campaign-status'),
          budget_type: val('builder-campaign-budget-type'),
          budget: val('builder-campaign-budget'),
          abtest: chk('builder-campaign-abtest'),
          advplus: chk('builder-campaign-advplus')
        },
        adset: {
          campaign_id: val('builder-adset-campaign-id'),
          name: val('builder-adset-name'),
          status: val('builder-adset-status'),
          optimization_goal: val('builder-adset-optimization'),
          billing_event: val('builder-adset-billing'),
          pixel_id: val('builder-adset-pixel-id'),
          event: val('builder-adset-event'),
          start_time: val('builder-adset-start'),
          end_time: val('builder-adset-end'),
          budget_type: val('builder-adset-budget-type'),
          budget: val('builder-adset-budget'),
          age_min: val('builder-adset-age-min'),
          age_max: val('builder-adset-age-max'),
          geo: val('builder-adset-geo')
        },
        ad: {
          name: val('builder-ad-name'),
          status: val('builder-ad-status'),
          adset_id: val('builder-ad-adset-id'),
          page_id: val('builder-ad-page-id'),
          primary_text: val('builder-ad-primary-text'),
          headline: val('builder-ad-headline'),
          cta: val('builder-ad-cta'),
          url: val('builder-ad-url'),
          image_url: val('builder-ad-image-url'),
          utm_source: val('builder-utm-source'),
          utm_campaign: val('builder-utm-campaign')
        }
      };
    },

    _syncPreview: function(){
      var d = this._readBuilderForm();

      // Campaign
      var cName = d.campaign.name || '—';
      setText($('builder-preview-campaign'), cName);
      setText($('builder-preview-campaign-meta'),
        (d.campaign.objective ? ('Objetivo: ' + d.campaign.objective) : '—') +
        (d.campaign.budget ? (' • Orçamento: R$ ' + d.campaign.budget + ' (' + (d.campaign.budget_type||'') + ')') : '')
      );

      // Adset
      var aName = d.adset.name || '—';
      setText($('builder-preview-adset'), aName);
      var sched = [];
      if(d.adset.start_time) sched.push('Início: ' + d.adset.start_time);
      if(d.adset.end_time) sched.push('Fim: ' + d.adset.end_time);
      var adsetMeta = [];
      if(d.adset.campaign_id) adsetMeta.push('Campanha: ' + d.adset.campaign_id);
      if(d.adset.status) adsetMeta.push('Status: ' + d.adset.status);
      if(d.adset.optimization_goal) adsetMeta.push('Otimização: ' + d.adset.optimization_goal);
      if(d.adset.budget) adsetMeta.push('Orçamento: R$ ' + d.adset.budget);
      if(sched.length) adsetMeta.push(sched.join(' | '));
      setText($('builder-preview-adset-meta'), adsetMeta.length ? adsetMeta.join(' • ') : '—');

      // Ad
      var adName = d.ad.name || '—';
      setText($('builder-preview-ad'), adName);
      var adMeta = [];
      if(d.ad.status) adMeta.push('Status: ' + d.ad.status);
      if(d.ad.adset_id) adMeta.push('AdSet: ' + d.ad.adset_id);
      if(d.ad.page_id) adMeta.push('Page: ' + d.ad.page_id);
      if(d.ad.url) adMeta.push('URL: ' + d.ad.url);
      if(d.ad.image_url) adMeta.push('Imagem: OK');
      if(d.ad.cta) adMeta.push('CTA: ' + d.ad.cta);
      setText($('builder-preview-ad-meta'), adMeta.length ? adMeta.join(' • ') : '—');
    },

    _loadDraftIfAny: function(){
      try{
        var raw = localStorage.getItem(this._builder._draftKey);
        if(!raw) return;
        var obj = JSON.parse(raw);
        if(!obj || !obj.draft) return;

        var hasTyped = false;
        var keyFields = ['builder-campaign-name','builder-adset-name','builder-ad-name'];
        for(var i=0;i<keyFields.length;i++){
          var el = $(keyFields[i]);
          if(el && String(el.value||'').trim()) { hasTyped = true; break; }
        }
        if(hasTyped) return;

        this._applyDraft(obj.draft);
        if(window.logger) window.logger.info('Rascunho carregado', { savedAt: obj.savedAt || null });
      } catch(e){}
    },

    _applyDraft: function(d){
      if(!d) return;
      function setVal(id, v){ var e=$(id); if(e && v!==undefined && v!==null) e.value = String(v); }
      function setChk(id, v){ var e=$(id); if(e && v!==undefined && v!==null) e.checked = !!v; }

      if(d.campaign){
        setVal('builder-campaign-name', d.campaign.name);
        setVal('builder-campaign-objective', d.campaign.objective);
        setVal('builder-campaign-status', d.campaign.status);
        setVal('builder-campaign-budget-type', d.campaign.budget_type);
        setVal('builder-campaign-budget', d.campaign.budget);
        setChk('builder-campaign-abtest', d.campaign.abtest);
        setChk('builder-campaign-advplus', d.campaign.advplus);
      }

      if(d.adset){
        setVal('builder-adset-campaign-id', d.adset.campaign_id);
        setVal('builder-adset-name', d.adset.name);
        setVal('builder-adset-status', d.adset.status);
        setVal('builder-adset-optimization', d.adset.optimization_goal);
        setVal('builder-adset-billing', d.adset.billing_event);
        setVal('builder-adset-pixel-id', d.adset.pixel_id);
        setVal('builder-adset-event', d.adset.event);
        setVal('builder-adset-start', d.adset.start_time);
        setVal('builder-adset-end', d.adset.end_time);
        setVal('builder-adset-budget-type', d.adset.budget_type);
        setVal('builder-adset-budget', d.adset.budget);
        setVal('builder-adset-age-min', d.adset.age_min);
        setVal('builder-adset-age-max', d.adset.age_max);
        setVal('builder-adset-geo', d.adset.geo);
      }

      if(d.ad){
        setVal('builder-ad-name', d.ad.name);
        setVal('builder-ad-status', d.ad.status);
        setVal('builder-ad-adset-id', d.ad.adset_id);
        setVal('builder-ad-page-id', d.ad.page_id);
        setVal('builder-ad-primary-text', d.ad.primary_text);
        setVal('builder-ad-headline', d.ad.headline);
        setVal('builder-ad-cta', d.ad.cta);
        setVal('builder-ad-url', d.ad.url);
        setVal('builder-utm-source', d.ad.utm_source);
        setVal('builder-utm-campaign', d.ad.utm_campaign);
      }

      this._syncAdsetConversionsVisibility();
      this._syncPreview();
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

  var am = ensureAdsManager();
  if(!am) return;

  // Attach/override methods onto adsManager (important: override any stub)
  am.openBuilder = builder.openBuilder;
  am.closeBuilder = builder.closeBuilder;
  am.builderTogglePreview = builder.builderTogglePreview;
  am.builderGoStep = builder.builderGoStep;
  am.builderNext = builder.builderNext;
  am.builderBack = builder.builderBack;
  am.builderOnBudgetTypeChange = builder.builderOnBudgetTypeChange;
  am.builderSaveDraft = builder.builderSaveDraft;
  am.builderPrimaryAction = builder.builderPrimaryAction;

  // Internal helpers
  am._builderImpl = builder;

  setTimeout(function(){
    try{
      var preview = $('builder-preview');
      if(preview && window.innerWidth >= 1024){
        builder._builder.previewOpen = true;
        preview.classList.remove('hidden');
      }
    } catch(e){}
  }, 0);

  console.log('[adsManager/builder] Loaded v1.2 (create campaign + create adset)');
})();
