/**
 * Flint - Logging Service
 * Captures console.log/warn/error and stores them for the log panel
 * This is initialized BEFORE React mounts to capture early logs
 */

import type { LogEntry } from '../types';

// Direct import of the store - no dispatcher pattern needed
let addLogBatchToStore: ((entries: Array<{ level: LogEntry['level']; message: string }>) => void) | null = null;

// Batched log buffer — collects logs and flushes to store at most every 250ms.
// This prevents each console.log/Rust tracing event from triggering a separate
// zustand store update and re-render cascade across all subscribed components.
let logBuffer: Array<{ level: LogEntry['level']; message: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const LOG_FLUSH_INTERVAL = 250; // ms

function flushLogBuffer() {
    flushTimer = null;
    if (logBuffer.length === 0 || !addLogBatchToStore) return;
    const entries = logBuffer;
    logBuffer = [];
    addLogBatchToStore(entries);
}

/**
 * Set the store's log function (called once when store is ready).
 * Accepts either addLogsBatch (preferred, single store update) or addLog (fallback).
 */
export function setLogStore(
    addLog: (level: LogEntry['level'], message: string) => void,
    addLogsBatch?: (entries: Array<{ level: LogEntry['level']; message: string }>) => void,
) {
    addLogBatchToStore = addLogsBatch ?? ((entries) => {
        for (const e of entries) addLog(e.level, e.message);
    });
    // Flush any entries that were buffered before store was ready
    if (logBuffer.length > 0) flushLogBuffer();
}

/**
 * Add a log entry — buffered to reduce re-renders.
 * Flushes at most every LOG_FLUSH_INTERVAL ms.
 */
function addLogEntry(level: LogEntry['level'], message: string) {
    logBuffer.push({ level, message });
    if (!flushTimer) {
        flushTimer = setTimeout(flushLogBuffer, LOG_FLUSH_INTERVAL);
    }
}

// Store original console methods
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

/**
 * Format arguments to a string message
 */
function formatArgs(args: unknown[]): string {
    return args.map(arg => {
        if (arg instanceof Error) {
            return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
        }
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg, null, 2);
            } catch {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');
}

/**
 * Check if a log message should be filtered out (noisy logs)
 */
function shouldFilter(message: string): boolean {
    // IPC trace lines (`[ipc#N ▶/✓]` from this side, `[rust] [rs-ipc#N ▶/✓]`
    // mirrored from the backend) fire on every command. Sending them through
    // the buffered store dump triggers a re-render cascade across every
    // log-panel subscriber per IPC, even with the 250ms flush. They're still
    // visible in devtools — keep them out of the in-app log.
    if (message.startsWith('[ipc#')) return true;
    if (message.startsWith('[rust] [rs-ipc#')) return true;
    const filters = [
        '[HMR]',
        '[vite]',
        'Download the React DevTools',
    ];
    return filters.some(f => message.includes(f));
}

/**
 * Initialize console interception
 * Call this BEFORE React mounts
 */
export function initializeLogger() {
    // Override console.log
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        const message = formatArgs(args);
        if (!shouldFilter(message)) {
            addLogEntry('info', message);
        }
    };

    // Override console.info
    console.info = (...args: unknown[]) => {
        originalConsole.info(...args);
        const message = formatArgs(args);
        if (!shouldFilter(message)) {
            addLogEntry('info', message);
        }
    };

    // Override console.warn
    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        const message = formatArgs(args);
        addLogEntry('warning', message);
    };

    // Override console.error
    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        const message = formatArgs(args);
        addLogEntry('error', message);
    };

    // Log initialization
    addLogEntry('info', 'Flint frontend logger initialized');
}

/**
 * Restore original console methods
 */
export function restoreConsole() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
}

/**
 * Initialize Tauri event listener for backend logs
 * Call this after the app is ready
 */
export async function initBackendLogListener() {
    try {
        const { listen } = await import('@tauri-apps/api/event');

        await listen<{ timestamp: number; level: string; target: string; message: string }>(
            'log-event',
            (event) => {
                const { level, message } = event.payload;

                // Map Rust log levels to our levels
                let logLevel: 'info' | 'warning' | 'error' = 'info';
                const levelLower = level.toLowerCase();
                if (levelLower === 'warn' || levelLower === 'warning') {
                    logLevel = 'warning';
                } else if (levelLower === 'error') {
                    logLevel = 'error';
                } else if (levelLower === 'debug') {
                    // Map debug to info for frontend display
                    logLevel = 'info';
                }

                // Format message - include [rust] prefix to distinguish from frontend logs
                const formattedMessage = `[rust] ${message}`;
                addLogEntry(logLevel, formattedMessage);
            }
        );

        originalConsole.log('Backend log listener initialized');
        addLogEntry('info', 'Backend log listener connected');
    } catch (error) {
        originalConsole.error('✗ Failed to initialize backend log listener:', error);
        addLogEntry('error', '✗ Failed to initialize backend log listener');
    }
}
