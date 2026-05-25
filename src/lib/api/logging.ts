import { invokeCommand } from './core';

export async function setLogLevel(verbose: boolean): Promise<void> {
    return invokeCommand('set_log_level', { verbose });
}

/** Emit test logs at all levels to verify logging is working. */
export async function testLogging(): Promise<void> {
    return invokeCommand('test_logging', {});
}
