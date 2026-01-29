/**
 * Facebook Graph API Integration Module
 * Handles all communications with Meta APIs
 * Version: 3.3 - Proxy-per-token support + helpers call()/fetchAllPath()
 */
var FacebookAPI = (function () {
    function FacebookAPI(logger) {
        this.baseUrl = 'https://graph.facebook.com/v19.0';
        this.logger = logger || console;
        this.maxRetries = 3;

        // Proxy routing (per token)
        // tokenProxyMap[token] = proxyBase (example: https://your-proxy.com/https://graph.facebook.com/v19.0)
        this.tokenProxyMap = {};

        this.log('Facebook API Module initialized', 'INFO');
    }

    FacebookAPI.prototype.log = function (msg, type, data) {
        type = type || 'INFO';
        if (this.logger && typeof this.logger.log === 'function') {
            this.logger.log(msg, type, data);
        } else {
            try {
                console.log('[' + type + '] ' + msg, data || '');
            } catch (e) {}
        }
    };

    // =====================
    // Proxy (public)
    // =====================
    FacebookAPI.prototype.setProxyForToken = function (token, proxyBase) {
        try {
            token = String(token || '').trim();
            proxyBase = String(proxyBase || '').trim();
            if (!token) return;
            if (!proxyBase) {
                delete this.tokenProxyMap[token];
                return;
            }
            // Normalize: remove trailing slash
            proxyBase = proxyBase.replace(/\/+$/, '');
            this.tokenProxyMap[token] = proxyBase;
        } catch (e) {}
    };

    FacebookAPI.prototype.clearProxyForToken = function (token) {
        try {
            token = String(token || '').trim();
            if (!token) return;
            delete this.tokenProxyMap[token];
        } catch (e) {}
    };

    FacebookAPI.prototype._proxyForToken = function (token) {
        try {
            token = String(token || '').trim();
            if (!token) return null;
            return this.tokenProxyMap[token] || null;
        } catch (e) {
            return null;
        }
    };

    FacebookAPI.prototype._extractTokenFromUrl = function (url) {
        try {
            var m = String(url || '').match(/[?&]access_token=([^&]+)/);
            if (m && m[1]) return decodeURIComponent(m[1]);
        } catch (e) {}
        return null;
    };

    FacebookAPI.prototype._applyProxyToUrl = function (url, tokenOverride) {
        // Routes a FULL absolute Graph URL through the proxy configured for a token.
        // Supports multiple proxy patterns:
        //  - Base replacement: proxyBase="https://proxy.com/https://graph.facebook.com/v19.0"
        //  - Prefix full URL:  proxyBase="https://proxy.com/" => https://proxy.com/https://graph.facebook.com/v19.0/...
        //  - Query param:      proxyBase="https://proxy.com/?url=" => https://proxy.com/?url=<ENCODED_URL>
        //  - Placeholders:
        //      {url}  -> encodeURIComponent(fullUrl)
        //      {raw}  -> fullUrl
        //      {path} -> path after https://graph.facebook.com/vX.Y
        try {
            url = String(url || '');

            var token = null;
            if (tokenOverride) token = String(tokenOverride || '').trim();
            if (!token) token = this._extractTokenFromUrl(url);

            var proxyBase = token ? this._proxyForToken(token) : null;
            if (!proxyBase) return url;
            proxyBase = String(proxyBase || '').trim();
            if (!proxyBase) return url;

            // Prevent double-proxy for most patterns
            if (proxyBase.indexOf('{') === -1 && url.indexOf(proxyBase) === 0) return url;

            // Detect Graph base + path
            var mGraph = url.match(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+/);
            var graphBase = mGraph && mGraph[0] ? mGraph[0] : null;
            var pathAfter = graphBase ? url.slice(graphBase.length) : null; // includes leading '/'

            // Placeholder patterns
            if (proxyBase.indexOf('{url}') !== -1) {
                return proxyBase.replace(/\{url\}/g, encodeURIComponent(url));
            }
            if (proxyBase.indexOf('{raw}') !== -1) {
                return proxyBase.replace(/\{raw\}/g, url);
            }
            if (proxyBase.indexOf('{path}') !== -1) {
                return proxyBase.replace(/\{path\}/g, (pathAfter !== null ? pathAfter : url));
            }

            // Query-param patterns (common proxy gateways)
            if (/(^|[?&])(url|target|dest|destination|uri)=$/i.test(proxyBase) || /[?&](url|target|dest|destination|uri)=$/i.test(proxyBase)) {
                return proxyBase + encodeURIComponent(url);
            }

            // Base replacement pattern: proxyBase already points to a Graph base.
            // Example: https://proxy.com/https://graph.facebook.com/v19.0
            if (graphBase && proxyBase.indexOf('graph.facebook.com') !== -1) {
                var pb = proxyBase.replace(/\/+$/, '');
                return pb + pathAfter;
            }

            // If proxyBase ends with a version segment (/v19.0), treat it as graphBase replacement.
            if (graphBase && /\/v\d+\.\d+\/?$/i.test(proxyBase)) {
                var pb2 = proxyBase.replace(/\/+$/, '');
                return pb2 + pathAfter;
            }

            // Default: prefix FULL URL after the proxy base
            var pb3 = proxyBase.replace(/\/+$/, '');
            return pb3 + '/' + url;
        } catch (e) {
            return url;
        }
    };

    // =====================
    // Retry helpers
    // =====================
    FacebookAPI.prototype._sleep = function (ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    };

    FacebookAPI.prototype._isRateLimitError = function (errorObj) {
        if (!errorObj) return false;
        var code = errorObj.code;
        var subcode = errorObj.error_subcode;
        if (code === 4 || code === 17 || code === 32 || code === 613) return true;
        if (subcode === 2446079) return true;
        return false;
    };

    FacebookAPI.prototype._requestJson = function (url, attempt) {
        var self = this;
        attempt = attempt || 0;

        // Proxy if needed
        url = self._applyProxyToUrl(url);

        return fetch(url)
            .then(function (response) {
                return response.json().then(function (json) {
                    return { ok: response.ok, status: response.status, json: json };
                });
            })
            .then(function (res) {
                if (res.json && res.json.error) {
                    if (self._isRateLimitError(res.json.error) && attempt < self.maxRetries) {
                        var backoff = Math.pow(2, attempt) * 800;
                        self.log('Rate limit detected. Retrying in ' + backoff + 'ms...', 'WARN', {
                            code: res.json.error.code,
                            subcode: res.json.error.error_subcode,
                            message: res.json.error.message
                        });
                        return self._sleep(backoff).then(function () {
                            return self._requestJson(url, attempt + 1);
                        });
                    }

                    if (res.json.error.code === 190) {
                        self.log('Token error (expired/invalid).', 'ERROR', res.json.error);
                        var te = new Error(res.json.error.message || 'Invalid OAuth access token');
                        te.noRetry = true;
                        te.code = 190;
                        throw te;
                    }

                    if (res.json.error.code === 200 || res.json.error.code === 10 || (res.json.error.code === 100 && res.json.error.error_subcode === 33)) {
                        self.log('Permission error.', 'ERROR', res.json.error);
                        var pe = new Error(res.json.error.message);
                        pe.noRetry = true;
                        throw pe;
                    }

                    throw new Error(res.json.error.message || 'Meta API error');
                }

                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }

                return res.json;
            })
            .catch(function (err) {
                if (err && err.noRetry) {
                    self.log('Request aborted (no-retry error)', 'ERROR', { url: self._safeUrl(url), error: String(err), code: err.code || 'n/a' });
                    throw err;
                }

                if (attempt < self.maxRetries) {
                    var backoff = Math.pow(2, attempt) * 500;
                    self.log('Network/API error. Retrying in ' + backoff + 'ms...', 'WARN', { error: String(err) });
                    return self._sleep(backoff).then(function () {
                        return self._requestJson(url, attempt + 1);
                    });
                }

                self.log('Request failed', 'ERROR', { url: self._safeUrl(url), error: String(err) });
                throw err;
            });
    };

    FacebookAPI.prototype._safeUrl = function (url) {
        try {
            return String(url).replace(/access_token=[^&]+/g, 'access_token=***');
        } catch (e) {
            return '***';
        }
    };

    FacebookAPI.prototype._buildUrl = function (path, params) {
        // Build URL. If token has proxy, support multiple proxy patterns.
        // For placeholder/query proxies we build the normal Graph URL first and then proxy it.
        var base = this.baseUrl;
        var token = null;
        try { token = params && params.access_token ? String(params.access_token) : null; } catch (e0) { token = null; }

        var parts = [];
        params = params || {};
        for (var k in params) {
            if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])));
            }
        }

        var url = base + path + (parts.length ? '?' + parts.join('&') : '');

        // If a proxy is configured for this token, route the URL through it.
        try {
            if (token) {
                var proxyBase = this._proxyForToken(token);
                if (proxyBase) {
                    // If proxyBase looks like a direct base replacement (contains graph...), keep legacy behavior:
                    if (String(proxyBase).indexOf('{') === -1 && String(proxyBase).indexOf('graph.facebook.com') !== -1) {
                        // Use proxyBase as base for graph requests
                        var pb = String(proxyBase).replace(/\/+$/, '');
                        url = pb + path + (parts.length ? '?' + parts.join('&') : '');
                    } else {
                        // Otherwise, proxy the full URL (handles placeholders/query)
                        url = this._applyProxyToUrl(url, token);
                    }
                }
            }
        } catch (e1) {}

        return url;
    };

    /**
     * Public helper: one-shot request using internal retry logic.
     */
    FacebookAPI.prototype.call = function (path, params) {
        var url = this._buildUrl(path, params || {});
        this.log('Calling: ' + this._safeUrl(url), 'INFO');
        return this._requestJson(url, 0);
    };

    /**
     * Public helper: fetch ALL pages for list endpoints, by providing path+params.
     */
    FacebookAPI.prototype.fetchAllPath = function (path, params) {
        var url = this._buildUrl(path, params || {});
        return this.fetchAll(url);
    };

    /**
     * Public helper: fetch ALL pages of a Graph API list response.
     * Accepts a FULL URL (with access_token included).
     */
    FacebookAPI.prototype.fetchAll = function (fullUrl) {
        var self = this;
        var all = [];

        function next(url) {
            url = self._applyProxyToUrl(url);
            self.log('Fetching page: ' + self._safeUrl(url), 'INFO');
            return self._requestJson(url, 0).then(function (data) {
                var chunk = (data && data.data) ? data.data : [];
                for (var i = 0; i < chunk.length; i++) all.push(chunk[i]);

                if (data && data.paging && data.paging.next) {
                    return next(data.paging.next);
                }

                return all;
            });
        }

        return next(fullUrl);
    };

    // =====================
    // Endpoints
    // =====================
    FacebookAPI.prototype.validateToken = function (token) {
        var self = this;
        self.log('Validating access token...', 'INFO');

        var url = this._buildUrl('/me', {
            fields: 'id,name,picture,email',
            access_token: token
        });

        return this._requestJson(url, 0)
            .then(function (data) {
                self.log('Token validated successfully!', 'SUCCESS', { userId: data.id, name: data.name });
                return data;
            })
            .catch(function (error) {
                self.log('Token validation failed', 'ERROR', error);
                throw error;
            });
    };

    FacebookAPI.prototype.getAdAccounts = function (token) {
        var self = this;
        self.log('Fetching ad accounts via /me/adaccounts...', 'INFO');

        var fields = 'id,name,account_id,currency,account_status,amount_spent,balance,business_name';
        var url = this._buildUrl('/me/adaccounts', {
            fields: fields,
            limit: 500,
            access_token: token
        });

        return this.fetchAll(url)
            .then(function (accounts) {
                self.log(accounts.length + ' ad accounts found (all pages)', 'SUCCESS');
                return accounts;
            })
            .catch(function (error) {
                self.log('Error fetching ad accounts', 'ERROR', error);
                throw error;
            });
    };

    FacebookAPI.prototype.getBusinesses = function (token) {
        var self = this;
        self.log('Fetching Business Managers via /me/businesses...', 'INFO');

        var url = this._buildUrl('/me/businesses', {
            fields: 'id,name,verification_status',
            limit: 500,
            access_token: token
        });

        return this.fetchAll(url)
            .then(function (bms) {
                self.log((bms || []).length + ' businesses found', 'SUCCESS');
                return bms || [];
            })
            .catch(function (error) {
                self.log('Could not fetch BMs', 'WARN', error);
                return [];
            });
    };

    FacebookAPI.prototype.getCampaigns = function (accountId, token) {
        var self = this;
        self.log('Fetching campaigns for account ' + accountId + '...', 'INFO');

        var fields = 'id,name,status,objective,buying_type,daily_budget,lifetime_budget,start_time,stop_time,effective_status,configured_status';
        var url = this._buildUrl('/' + accountId + '/campaigns', {
            fields: fields,
            limit: 500,
            access_token: token
        });

        return this.fetchAll(url)
            .then(function (campaigns) {
                self.log(campaigns.length + ' campaigns found (all pages)', 'SUCCESS');
                return campaigns;
            })
            .catch(function (error) {
                self.log('Error fetching campaigns', 'ERROR', error);
                throw error;
            });
    };

    FacebookAPI.prototype.getAdSets = function (accountId, token, options) {
        var self = this;
        self.log('Fetching ad sets...', 'INFO');

        var fields = 'id,name,status,daily_budget,lifetime_budget,campaign_id,start_time,end_time,billing_event,optimization_goal';
        var params = {
            fields: fields,
            limit: 500,
            access_token: token
        };

        if (options) {
            if (options.campaignId) {
                params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: String(options.campaignId) }]);
            } else if (options.campaignIds && options.campaignIds.length > 0) {
                params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: options.campaignIds }]);
            }
        }

        var url = this._buildUrl('/' + accountId + '/adsets', params);

        return this.fetchAll(url)
            .then(function (adsets) {
                self.log(adsets.length + ' ad sets found (all pages)', 'SUCCESS');
                return adsets;
            })
            .catch(function (error) {
                self.log('Error fetching ad sets', 'ERROR', error);
                throw error;
            });
    };

    FacebookAPI.prototype.getAds = function (accountId, token, options) {
        var self = this;
        self.log('Fetching ads...', 'INFO');

        var fields = 'id,name,status,creative,adset_id,campaign_id,preview_shareable_link';
        var params = {
            fields: fields,
            limit: 500,
            access_token: token
        };

        if (options) {
            var filters = [];
            if (options.adsetIds && options.adsetIds.length > 0) {
                filters.push({ field: 'adset.id', operator: 'IN', value: options.adsetIds });
            } else if (options.adsetId) {
                filters.push({ field: 'adset.id', operator: 'EQUAL', value: String(options.adsetId) });
            }

            if (filters.length === 0 && options.campaignIds && options.campaignIds.length > 0) {
                filters.push({ field: 'campaign.id', operator: 'IN', value: options.campaignIds });
            }

            if (filters.length > 0) {
                params.filtering = JSON.stringify(filters);
            }
        }

        var url = this._buildUrl('/' + accountId + '/ads', params);

        return this.fetchAll(url)
            .then(function (ads) {
                self.log(ads.length + ' ads found (all pages)', 'SUCCESS');
                return ads;
            })
            .catch(function (error) {
                self.log('Error fetching ads', 'ERROR', error);
                throw error;
            });
    };

    FacebookAPI.prototype.getInsights = function (objectId, token, datePreset) {
        var self = this;
        datePreset = datePreset || 'last_7d';

        var fields = 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type';
        var url = this._buildUrl('/' + objectId + '/insights', {
            fields: fields,
            date_preset: datePreset,
            access_token: token
        });

        return this._requestJson(url, 0)
            .then(function (data) {
                if (data && data.data && data.data.length > 0) return data.data[0];
                return {};
            })
            .catch(function (error) {
                self.log('Failed to get insights for ' + objectId, 'WARN', error);
                return {};
            });
    };

    FacebookAPI.prototype.getInsightsForAccountLevel = function (accountId, token, level, datePreset, options) {
        var self = this;
        datePreset = datePreset || 'last_7d';

        options = options || {};
        var fields = options.fields || 'campaign_id,adset_id,ad_id,account_currency,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type';

        var params = {
            level: level,
            fields: fields,
            limit: 500,
            access_token: token
        };

        if (options.time_range && options.time_range.since && options.time_range.until) {
            params.time_range = JSON.stringify({
                since: String(options.time_range.since),
                until: String(options.time_range.until)
            });
        } else {
            params.date_preset = datePreset;
        }

        if (options.filtering) {
            params.filtering = JSON.stringify(options.filtering);
        }

        var url = this._buildUrl('/' + accountId + '/insights', params);
        self.log('Fetching insights (level=' + level + ') for account ' + accountId + '...', 'INFO', {
            date_preset: params.date_preset || null,
            time_range: options.time_range || null,
            fields: fields,
            hasFiltering: !!options.filtering
        });

        return this.fetchAll(url)
            .then(function (rows) {
                self.log((rows || []).length + ' insight rows found (all pages)', 'SUCCESS');
                return rows || [];
            })
            .catch(function (error) {
                self.log('Error fetching insights level=' + level, 'ERROR', error);
                return [];
            });
    };

    FacebookAPI.prototype.getPages = function (token, options) {
        var self = this;
        self.log('Fetching pages via /me/accounts...', 'INFO');

        options = options || {};

        var primaryFields = options.fields || 'id,name,category,picture{url}';
        var primaryLimit = options.limit || 100;

        function run(fields, limit) {
            var url = self._buildUrl('/me/accounts', {
                fields: fields,
                limit: limit,
                access_token: token
            });
            return self.fetchAll(url);
        }

        return run(primaryFields, primaryLimit)
            .then(function (pages) {
                self.log(pages.length + ' pages found (all pages)', 'SUCCESS');
                return pages;
            })
            .catch(function (error) {
                var msg = (error && error.message) ? String(error.message) : String(error);

                if (msg && msg.toLowerCase().indexOf('reduce the amount of data') !== -1) {
                    self.log('Pages request too heavy. Retrying with lighter fields/limit...', 'WARN', {
                        previousFields: primaryFields,
                        previousLimit: primaryLimit
                    });

                    var fallbackFields = 'id,name,category,picture{url}';
                    var fallbackLimit = 50;

                    return run(fallbackFields, fallbackLimit)
                        .then(function (pages2) {
                            self.log(pages2.length + ' pages found (fallback, all pages)', 'SUCCESS');
                            return pages2;
                        });
                }

                self.log('Error fetching pages', 'ERROR', { error: msg });
                throw error;
            });
    };

    /**
     * (BETA) Meta internal edge for ads volume
     */
    FacebookAPI.prototype.getAdsVolume = function (adAccountId, token, options) {
        options = options || {};
        var id = String(adAccountId || '');
        if (id && id.indexOf('act_') !== 0) id = 'act_' + id;

        var params = { access_token: token };
        if (options.page_id) params.page_id = String(options.page_id);
        if (options.fields) params.fields = String(options.fields);
        return this.call('/' + id + '/ads_volume', params);
    };

    // =====================
    // Create helpers (POST)
    // =====================
    FacebookAPI.prototype._postForm = function (objectPath, payload, token) {
        // objectPath examples:
        //  - act_123/campaigns
        //  - act_123/adsets
        //  - act_123/adcreatives
        var self = this;
        payload = payload || {};

        var proxyBase = self._proxyForToken(token);
        var base = proxyBase || self.baseUrl;

        var formData = new FormData();
        for (var key in payload) {
            if (payload.hasOwnProperty(key) && payload[key] !== undefined && payload[key] !== null) {
                formData.append(key, String(payload[key]));
            }
        }
        formData.append('access_token', token);

        var postUrl = base + '/' + objectPath;
        // If proxyBase uses placeholders/query, transform postUrl.
        if (proxyBase && String(proxyBase).indexOf('{') !== -1) {
            postUrl = self._applyProxyToUrl(self.baseUrl + '/' + objectPath + '?access_token=' + encodeURIComponent(token), token);
        } else if (proxyBase && String(proxyBase).indexOf('graph.facebook.com') === -1) {
            postUrl = self._applyProxyToUrl(self.baseUrl + '/' + objectPath + '?access_token=' + encodeURIComponent(token), token);
        }

        return fetch(postUrl, {
            method: 'POST',
            body: formData
        })
            .then(function (response) {
                return response.json().then(function (json) {
                    return { ok: response.ok, status: response.status, json: json };
                });
            })
            .then(function (res) {
                var data = res.json;
                if (data && data.error) throw new Error(data.error.message);

                // Accept common success shapes.
                var ok = false;
                if (data === true) ok = true;
                if (data && data.success === true) ok = true;
                if (data && data.id) ok = true;
                if (data && data.result === true) ok = true;

                if (!res.ok && !ok) {
                    throw new Error('HTTP ' + res.status);
                }

                if (!ok) {
                    self.log('POST returned an unexpected response shape. Treating as success.', 'WARN', data);
                } else {
                    self.log('POST success: ' + objectPath, 'SUCCESS', data);
                }

                return data;
            });
    };

    /**
     * Create campaign (POST /{act_id}/campaigns)
     */
    FacebookAPI.prototype.createCampaign = function (adAccountId, payload, token) {
        try {
            var id = String(adAccountId || '');
            if (id && id.indexOf('act_') !== 0) id = 'act_' + id;
            return this._postForm(id + '/campaigns', payload || {}, token);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    /**
     * Create ad set (POST /{act_id}/adsets)
     */
    FacebookAPI.prototype.createAdSet = function (adAccountId, payload, token) {
        try {
            var idA = String(adAccountId || '');
            if (idA && idA.indexOf('act_') !== 0) idA = 'act_' + idA;
            return this._postForm(idA + '/adsets', payload || {}, token);
        } catch (eA) {
            return Promise.reject(eA);
        }
    };

    /**
     * Create ad creative (POST /act_{id}/adcreatives)
     */
    FacebookAPI.prototype.createAdCreative = function (adAccountId, payload, token) {
        try {
            var idC = String(adAccountId || '');
            if (idC && idC.indexOf('act_') !== 0) idC = 'act_' + idC;
            return this._postForm(idC + '/adcreatives', payload || {}, token);
        } catch (eC) {
            return Promise.reject(eC);
        }
    };

    /**
     * Upload ad image by URL (POST /act_{id}/adimages)
     * Returns Meta response (contains image hash).
     */
    FacebookAPI.prototype.createAdImage = function (adAccountId, imageUrl, token) {
        try {
            var idI = String(adAccountId || '');
            if (idI && idI.indexOf('act_') !== 0) idI = 'act_' + idI;
            return this._postForm(idI + '/adimages', { url: String(imageUrl || '') }, token);
        } catch (eI) {
            return Promise.reject(eI);
        }
    };

    /**
     * Create ad (POST /act_{id}/ads)
     */
    FacebookAPI.prototype.createAd = function (adAccountId, payload, token) {
        try {
            var idAd = String(adAccountId || '');
            if (idAd && idAd.indexOf('act_') !== 0) idAd = 'act_' + idAd;
            return this._postForm(idAd + '/ads', payload || {}, token);
        } catch (eAd) {
            return Promise.reject(eAd);
        }
    };

    FacebookAPI.prototype.updateObject = function (objectId, updateData, token) {
        var self = this;
        self.log('Updating object ' + objectId + '...', 'INFO', updateData);

        // For POST, also support non-base proxy patterns by proxying the full URL.
        var proxyBase = self._proxyForToken(token);
        var base = proxyBase || self.baseUrl;

        var formData = new FormData();
        for (var key in updateData) {
            if (updateData.hasOwnProperty(key)) {
                formData.append(key, String(updateData[key]));
            }
        }
        formData.append('access_token', token);

        var postUrl = base + '/' + objectId;
        // If proxyBase uses placeholders/query, transform postUrl.
        if (proxyBase && String(proxyBase).indexOf('{') !== -1) {
            postUrl = self._applyProxyToUrl(self.baseUrl + '/' + objectId + '?access_token=' + encodeURIComponent(token), token);
            // We appended access_token in query to allow proxy routing; real token is still in body.
            // Remove any "?access_token=..." from postUrl if proxy requires only raw/path.
        } else if (proxyBase && String(proxyBase).indexOf('graph.facebook.com') === -1) {
            // Prefix proxy pattern
            postUrl = self._applyProxyToUrl(self.baseUrl + '/' + objectId + '?access_token=' + encodeURIComponent(token), token);
        }

        return fetch(postUrl, {
            method: 'POST',
            body: formData
        })
            .then(function (response) {
                return response.json().then(function (json) {
                    return { ok: response.ok, status: response.status, json: json };
                });
            })
            .then(function (res) {
                var data = res.json;
                if (data && data.error) throw new Error(data.error.message);

                var ok = false;
                if (data === true) ok = true;
                if (data && data.success === true) ok = true;
                if (data && data.id) ok = true;
                if (data && data.result === true) ok = true;

                if (!res.ok && !ok) {
                    throw new Error('HTTP ' + res.status);
                }

                if (!ok) {
                    self.log('Update returned an unexpected response shape. Treating as success.', 'WARN', data);
                } else {
                    self.log('Object ' + objectId + ' updated successfully', 'SUCCESS', data);
                }

                return true;
            })
            .catch(function (error) {
                self.log('Error updating object ' + objectId + 'ERROR', 'ERROR', error);
                throw error;
            });
    };

    return FacebookAPI;
})();

try {
    window.fbApi = new FacebookAPI(window.logger);
    console.log('[FacebookAPI] Module loaded successfully');
} catch (e) {
    console.error('[FacebookAPI] Fatal initialization error:', e);
}
