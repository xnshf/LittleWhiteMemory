// ═══════════════════════════════════════════════════════════════════════════
// TauriTavern extension-store backed JSON storage
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_NAMESPACE = 'LittleWhiteMemory';
const STORAGE_TABLE = 'storage-files';
const STORAGE_SCHEMA_VERSION = 1;

const defaultDebounce = (func, timeout) => {
    let timer = null;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(func, timeout);
    };
};

const isPlainRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const canonicalizeRecord = value => {
    if (!isPlainRecord(value)) throw new TypeError('存储文件内容必须是对象');

    let parsed;
    try {
        parsed = JSON.parse(JSON.stringify(value));
    } catch (error) {
        throw new TypeError(`存储文件内容无法序列化：${error?.message || error}`);
    }

    if (!isPlainRecord(parsed)) throw new TypeError('存储文件内容必须是对象');
    return Object.assign(Object.create(null), parsed);
};

const cloneJsonValue = value => JSON.parse(JSON.stringify(value));

const canonicalJson = value => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const parseStoreDocument = value => {
    if (!isPlainRecord(value) || value.schemaVersion !== STORAGE_SCHEMA_VERSION) {
        throw new Error('扩展存储版本无效');
    }
    return canonicalizeRecord(value.data);
};

export class StorageFile {
    constructor(filename, opts = {}) {
        this.filename = filename;
        this.key = String(filename).replace(/\.json$/i, '');
        this._cache = null;
        this._loading = null;
        this._dirty = false;
        this._saving = false;
        this._writeQueue = Promise.resolve();
        this._store = opts.store || null;
        this._fetch = typeof opts.fetch === 'function' ? opts.fetch : (...args) => globalThis.fetch(...args);
        this._getRequestHeaders = typeof opts.getRequestHeaders === 'function' ? opts.getRequestHeaders : () => ({});
        const debounce = typeof opts.debounce === 'function' ? opts.debounce : defaultDebounce;
        const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 2000;
        this._saveDebounced = debounce(() => this.saveNow({ silent: true }), debounceMs);
    }

    _getStore() {
        const store = this._store || globalThis.window?.__TAURITAVERN__?.api?.extension?.store;
        if (typeof store?.tryGetJson !== 'function' || typeof store?.setJson !== 'function') {
            throw new Error('TauriTavern api.extension.store is unavailable');
        }
        return store;
    }

    _storeOptions() {
        return { namespace: STORAGE_NAMESPACE, table: STORAGE_TABLE, key: this.key };
    }

    async _loadLegacy() {
        const res = await this._fetch(`/user/files/${this.filename}`, {
            headers: this._getRequestHeaders(),
            cache: 'no-cache',
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`旧存储文件读取失败（HTTP ${res.status}）`);
        const text = await res.text();
        return canonicalizeRecord(text ? JSON.parse(text) : {});
    }

    async _persist(candidate) {
        const store = this._getStore();
        const options = this._storeOptions();
        await store.setJson({
            ...options,
            value: { schemaVersion: STORAGE_SCHEMA_VERSION, data: candidate },
        });
        const confirmed = await store.tryGetJson(options);
        if (!confirmed?.found) throw new Error('扩展存储写入后不存在');
        const saved = parseStoreDocument(confirmed.value);
        if (canonicalJson(saved) !== canonicalJson(candidate)) {
            throw new Error('扩展存储写入后校验失败');
        }
        return saved;
    }

    async _loadInternal() {
        if (this._cache !== null) return this._cache;

        if (!this._loading) {
            const loading = (async () => {
                const stored = await this._getStore().tryGetJson(this._storeOptions());
                if (stored?.found) {
                    this._cache = parseStoreDocument(stored.value);
                    return this._cache;
                }

                const legacy = await this._loadLegacy();
                this._cache = legacy === null ? Object.create(null) : await this._persist(legacy);
                return this._cache;
            })();
            this._loading = loading;
            loading.finally(() => {
                if (this._loading === loading) this._loading = null;
            }).catch(() => {});
        }

        return await this._loading;
    }

    async load({ strict = false } = {}) {
        try {
            return cloneJsonValue(await this._loadInternal());
        } catch (error) {
            if (strict) throw error;
            return {};
        }
    }

    async get(key, defaultValue = null) {
        try {
            return await this._getValue(key, defaultValue);
        } catch {
            return defaultValue;
        }
    }

    async getStrict(key, defaultValue = null) {
        return await this._getValue(key, defaultValue);
    }

    async _getValue(key, defaultValue) {
        const data = await this._loadInternal();
        if (!Object.prototype.hasOwnProperty.call(data, key) || data[key] == null) return defaultValue;
        return cloneJsonValue(data[key]);
    }

    async set(key, value) {
        const valueSnapshot = structuredClone(value);
        return this._enqueueWrite(async () => {
            const draft = canonicalizeRecord(await this._loadInternal());
            Object.defineProperty(draft, key, {
                value: valueSnapshot,
                enumerable: true,
                configurable: true,
                writable: true,
            });
            this._cache = canonicalizeRecord(draft);
            this._dirty = true;
            this._saveDebounced();
        });
    }

    async delete(key) {
        return this._enqueueWrite(async () => {
            const current = await this._loadInternal();
            if (!Object.prototype.hasOwnProperty.call(current, key)) return;
            const draft = canonicalizeRecord(current);
            delete draft[key];
            this._cache = draft;
            this._dirty = true;
            this._saveDebounced();
        });
    }

    async setAndSave(key, value, { silent = true } = {}) {
        const valueSnapshot = structuredClone(value);
        return this.updateAndSave(draft => {
            Object.defineProperty(draft, key, {
                value: valueSnapshot,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }, { silent });
    }

    async replaceAndSave(value, { silent = true } = {}) {
        const candidate = canonicalizeRecord(value);
        return this._enqueueWrite(() => this._replaceAndSave(candidate, silent));
    }

    async updateAndSave(updater, { silent = true } = {}) {
        if (typeof updater !== 'function') throw new TypeError('存储更新器必须是函数');

        return this._enqueueWrite(async () => {
            const draft = canonicalizeRecord(await this._loadInternal());
            const result = await updater(draft);
            return this._replaceAndSave(canonicalizeRecord(result === undefined ? draft : result), silent);
        });
    }

    async _replaceAndSave(candidate, silent) {
        await this._loadInternal();
        this._saving = true;
        try {
            this._cache = await this._persist(candidate);
            this._dirty = false;
            return true;
        } catch (error) {
            console.error('[StorageFile] 保存失败:', error);
            if (!silent) throw error;
            return false;
        } finally {
            this._saving = false;
        }
    }

    _enqueueWrite(operation) {
        const result = this._writeQueue.then(operation, operation);
        this._writeQueue = result.catch(() => {});
        return result;
    }

    async waitForQueuedWrites() {
        while (true) {
            const pending = this._writeQueue;
            await pending;
            if (pending !== this._writeQueue) continue;
            if (this._dirty) {
                await this.saveNow({ silent: false });
                continue;
            }
            if (pending === this._writeQueue && !this._saving) return;
        }
    }

    async saveNow({ silent = true } = {}) {
        return this._enqueueWrite(() => this._saveNow(silent));
    }

    async _saveNow(silent) {
        if (!this._cache || !this._dirty) return true;
        return this._replaceAndSave(canonicalizeRecord(this._cache), silent);
    }

    clearCache() {
        if (this._loading || this._saving || this._dirty) return false;
        this._cache = null;
        return true;
    }

    getCacheSize() {
        return this._cache ? Object.keys(this._cache).length : 0;
    }

    getCacheBytes() {
        if (!this._cache) return 0;
        try {
            return JSON.stringify(this._cache).length * 2;
        } catch {
            return 0;
        }
    }
}
