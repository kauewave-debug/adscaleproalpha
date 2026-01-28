/**
 * Facebook Graph API Integration Module
 * Handles all communications with Meta APIs
 * Version: 3.2 - Helpers public call() + fetchAllPath() + safer Pages fallback
 */
var FacebookAPI = (function () {
    function FacebookAPI(logger) {
        this.baseUrl = 'https://graph.facebook.com/v19.0';
        this.logger = logger || console;
        this.maxRetries = 3;
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
        var parts = [];
        for (var k in params) {
            if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])));
            }
        }
        return this.baseUrl + path + (parts.length ? '?' + parts.join('&') : '');
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

        // Prefer explicit time_range when provided (custom picker)
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

    /**
     * Get Facebook Pages (ALL pages)
     */
    FacebookAPI.prototype.getPages = function (token, options) {
        var self = this;
        self.log('Fetching pages via /me/accounts...', 'INFO');

        options = options || {};

        // Default fields are intentionally LIGHT. Some fields (fan_count, access_token, ad_limits)
        // may require extra permissions and/or make the response too heavy.
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

                    // Fallback: keep it very light.
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
     * (BETA) Try Meta internal edge to estimate ads usage/volume.
     * Endpoint is not officially documented and may fail depending on permissions.
     * Usage examples:
     *   fbApi.getAdsVolume('act_123', token)
     *   fbApi.getAdsVolume('act_123', token, { page_id: '123456' })
     */
    FacebookAPI.prototype.getAdsVolume = function (adAccountId, token, options) {
        options = options || {};
        var id = String(adAccountId || '');
        // ensure act_ prefix
        if (id && id.indexOf('act_') !== 0) id = 'act_' + id;

        var params = {
            access_token: token
        };

        // some implementations accept page_id
        if (options.page_id) params.page_id = String(options.page_id);
        if (options.fields) params.fields = String(options.fields);

        // call edge
        return this.call('/' + id + '/ads_volume', params);
    };

    FacebookAPI.prototype.updateObject = function (objectId, updateData, token) {
        var self = this;
        self.log('Updating object ' + objectId + '...', 'INFO', updateData);

        var formData = new FormData();
        for (var key in updateData) {
            if (updateData.hasOwnProperty(key)) {
                formData.append(key, String(updateData[key]));
            }
        }
        formData.append('access_token', token);

        return fetch(this.baseUrl + '/' + objectId, {
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
