import type { LogEntry } from '../types';

let addLogBatchToStore: ((entries: Array<{ level: LogEntry['level']; message: string }>) => void) | null = null;

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

export function setLogStore(
    addLog: (level: LogEntry['level'], message: string) => void,
    addLogsBatch?: (entries: Array<{ level: LogEntry['level']; message: string }>) => void,
) {
    addLogBatchToStore = addLogsBatch ?? ((entries) => {
        for (const e of entries) addLog(e.level, e.message);
    });
    if (logBuffer.length > 0) flushLogBuffer();
}

function addLogEntry(level: LogEntry['level'], message: string) {
    logBuffer.push({ level, message });
    if (!flushTimer) {
        flushTimer = setTimeout(flushLogBuffer, LOG_FLUSH_INTERVAL);
    }
}

const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
};

// Whether console.debug diagnostics are captured into the in-app log store.
// Mirrors the "Verbose logging" setting (appMetadataStore keeps it in sync via
// setVerboseCapture; seeded from the same localStorage key so a restart keeps
// the choice). console.debug always still reaches DevTools regardless.
export const VERBOSE_STORAGE_KEY = 'flint_verbose_logging';

let verboseCapture = (() => {
    try {
        return localStorage.getItem(VERBOSE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
})();

export function setVerboseCapture(on: boolean) {
    verboseCapture = on;
}

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

function shouldFilter(message: string): boolean {
    if (message.startsWith('[ipc#')) return true;
    if (message.startsWith('[rust] [rs-ipc#')) return true;
    const filters = [
        '[HMR]',
        '[vite]',
        'Download the React DevTools',
    ];
    return filters.some(f => message.includes(f));
}

/** Call this BEFORE React mounts. */
export function initializeLogger() {
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        const message = formatArgs(args);
        if (!shouldFilter(message)) {
            addLogEntry('info', message);
        }
    };

    console.info = (...args: unknown[]) => {
        originalConsole.info(...args);
        const message = formatArgs(args);
        if (!shouldFilter(message)) {
            addLogEntry('info', message);
        }
    };

    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        const message = formatArgs(args);
        addLogEntry('warning', message);
    };

    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        const message = formatArgs(args);
        addLogEntry('error', message);
    };

    // Verbose diagnostics: only captured into the log store when the user
    // enabled Verbose logging — otherwise they stay DevTools-only, keeping
    // the normal log clean.
    console.debug = (...args: unknown[]) => {
        originalConsole.debug(...args);
        if (!verboseCapture) return;
        const message = formatArgs(args);
        if (!shouldFilter(message)) {
            addLogEntry('info', message);
        }
    };

    addLogEntry('info', 'Flint frontend logger initialized');
}

export function restoreConsole() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
}

export async function initBackendLogListener() {
    try {
        const { listen } = await import('@tauri-apps/api/event');

        await listen<{ timestamp: number; level: string; target: string; message: string }>(
            'log-event',
            (event) => {
                const { level, message } = event.payload;

                let logLevel: 'info' | 'warning' | 'error' = 'info';
                const levelLower = level.toLowerCase();
                if (levelLower === 'warn' || levelLower === 'warning') {
                    logLevel = 'warning';
                } else if (levelLower === 'error') {
                    logLevel = 'error';
                } else if (levelLower === 'debug') {
                    logLevel = 'info';
                }

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
