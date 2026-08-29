/**
 * Logger Utility
 *
 * Provides structured logging with colors, debug support, and request context tracking.
 * Uses AsyncLocalStorage so the current request ID is automatically included in every log line.
 */

import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import util from 'util';

export const logContext = new AsyncLocalStorage();

const COLORS = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',

    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    GRAY: '\x1b[90m'
};

class Logger extends EventEmitter {
    constructor() {
        super();
        this.isDebugEnabled = false;
        this.history = [];
        this.maxHistory = 1000;
    }

    /**
     * Set debug mode
     * @param {boolean} enabled
     */
    setDebug(enabled) {
        this.isDebugEnabled = !!enabled;
    }

    /**
     * Get current timestamp string
     */
    getTimestamp() {
        return new Date().toISOString();
    }

    /**
     * Get log history
     */
    getHistory() {
        return this.history;
    }

    /**
     * Get active request ID if available in context
     * @returns {string|null}
     */
    getRequestId() {
        const ctx = logContext.getStore();
        return ctx?.requestId || null;
    }

    /**
     * Format and print a log message
     * @param {string} level
     * @param {string} color
     * @param {string} message
     * @param  {...any} args
     */
    print(level, color, message, ...args) {
        const timestampStr = this.getTimestamp();
        const timestamp = `${COLORS.GRAY}[${timestampStr}]${COLORS.RESET}`;
        const levelTag = `${color}[${level}]${COLORS.RESET}`;

        // Extract request ID from AsyncLocalStorage context if present
        const ctx = logContext.getStore();
        const reqTag = ctx?.requestId ? `${COLORS.CYAN}[${ctx.requestId}]${COLORS.RESET} ` : '';

        // Format the message with args similar to console.log
        const formattedMessage = util.format(message, ...args);

        console.log(`${timestamp} ${levelTag} ${reqTag}${formattedMessage}`);

        // Store structured log
        const logEntry = {
            timestamp: timestampStr,
            level,
            requestId: ctx?.requestId || null,
            message: formattedMessage
        };

        this.history.push(logEntry);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        this.emit('log', logEntry);
    }

    /**
     * Standard info log
     */
    info(message, ...args) {
        this.print('INFO', COLORS.BLUE, message, ...args);
    }

    /**
     * Success log
     */
    success(message, ...args) {
        this.print('SUCCESS', COLORS.GREEN, message, ...args);
    }

    /**
     * Warning log
     */
    warn(message, ...args) {
        this.print('WARN', COLORS.YELLOW, message, ...args);
    }

    /**
     * Error log
     */
    error(message, ...args) {
        this.print('ERROR', COLORS.RED, message, ...args);
    }

    /**
     * Debug log - only prints if debug mode is enabled
     */
    debug(message, ...args) {
        if (this.isDebugEnabled) {
            this.print('DEBUG', COLORS.MAGENTA, message, ...args);
        }
    }

    /**
     * Direct log (for raw output usually) - proxied to console.log but can be enhanced
     */
    log(message, ...args) {
        console.log(message, ...args);
    }

    /**
     * Print a section header
     */
    header(title) {
        console.log(`\n${COLORS.BRIGHT}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}\n`);
    }
}

// Export a singleton instance
export const logger = new Logger();

