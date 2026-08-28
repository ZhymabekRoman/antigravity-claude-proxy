/**
 * Logs Viewer Component
 * High-performance async log viewer with micro-batching and tab-aware stream lifecycle
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    eventSource: null,
    searchQuery: '',
    filters: {
        INFO: true,
        WARN: true,
        ERROR: true,
        SUCCESS: true,
        DEBUG: false
    },

    // Internal batching queue
    _pendingLogs: [],
    _batchTimer: null,
    _rafId: null,

    get filteredLogs() {
        const query = this.searchQuery.trim();
        if (!query) {
            return this.logs.filter(log => this.filters[log.level]);
        }

        // Fast case-insensitive search
        const lowerQuery = query.toLowerCase();
        return this.logs.filter(log => {
            if (!this.filters[log.level]) return false;
            return (log._search || log.message.toLowerCase()).includes(lowerQuery);
        });
    },

    init() {
        // Only stream logs when Logs tab is active
        this.$watch('$store.global.activeTab', (tab) => {
            if (tab === 'logs') {
                this.startLogStream();
            } else {
                this.stopLogStream();
            }
        });

        if (Alpine.store('global')?.activeTab === 'logs') {
            this.startLogStream();
        }

        // Sync DEBUG filter with debugLogging sub-toggle
        const settings = Alpine.store('settings');
        if (settings) {
            this.filters.DEBUG = !!settings.debugLogging;
            this.$watch('$store.settings.debugLogging', (val) => {
                this.filters.DEBUG = !!val;
            });
        }

        this.$watch('isAutoScroll', (val) => {
            if (val) this.scrollToBottom();
        });

        // Watch filters to maintain auto-scroll if enabled
        this.$watch('searchQuery', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
        this.$watch('filters', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
    },

    _formatLog(log) {
        // Pre-compute formatted string & HTML once at ingestion
        try {
            const d = new Date(log.timestamp);
            log._time = d.toLocaleTimeString([], { hour12: false });
        } catch {
            log._time = '--:--:--';
        }

        const rawMsg = log.message || '';
        log._search = rawMsg.toLowerCase();

        const cleanMsg = window.Redact ? window.Redact.logMessage(rawMsg) : rawMsg;
        log._html = cleanMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        return log;
    },

    _flushBatch() {
        if (this._pendingLogs.length === 0) return;

        const newLogs = this._pendingLogs;
        this._pendingLogs = [];

        const limit = Alpine.store('settings')?.logLimit || window.AppConstants.LIMITS.DEFAULT_LOG_LIMIT;
        const combined = this.logs.concat(newLogs);
        this.logs = combined.length > limit ? combined.slice(-limit) : combined;

        if (this.isAutoScroll) {
            this.scrollToBottom();
        }
    },

    startLogStream() {
        if (this.eventSource) return;

        const password = Alpine.store('global')?.webuiPassword;
        const url = password
            ? `/api/logs/stream?history=true&password=${encodeURIComponent(password)}`
            : '/api/logs/stream?history=true';

        this.eventSource = new EventSource(url);

        this.eventSource.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                this._pendingLogs.push(this._formatLog(log));

                // Micro-batch via requestAnimationFrame (max 60 updates/sec, never blocks UI thread)
                if (!this._rafId) {
                    this._rafId = requestAnimationFrame(() => {
                        this._rafId = null;
                        this._flushBatch();
                    });
                }
            } catch (e) {
                if (window.UILogger) window.UILogger.debug('Log parse error:', e.message);
            }
        };

        this.eventSource.onerror = () => {
            if (this.eventSource) {
                this.eventSource.close();
                this.eventSource = null;
                // Reconnect only if still on logs tab
                if (Alpine.store('global')?.activeTab === 'logs') {
                    setTimeout(() => this.startLogStream(), 3000);
                }
            }
        };
    },

    stopLogStream() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._flushBatch();
    },

    scrollToBottom() {
        requestAnimationFrame(() => {
            const container = document.getElementById('logs-container');
            if (container) container.scrollTop = container.scrollHeight;
        });
    },

    clearLogs() {
        this.logs = [];
        this._pendingLogs = [];
    },

    exportLogs() {
        if (this.logs.length === 0) return;

        const shouldRedact = Alpine.store('settings')?.redactMode && window.Redact;
        const lines = this.logs.map(log => {
            const ts = new Date(log.timestamp).toISOString();
            const message = shouldRedact ? window.Redact.logMessage(log.message) : log.message;
            return `[${ts}] [${log.level}] ${message}`;
        });

        const text = lines.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `proxy-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});

