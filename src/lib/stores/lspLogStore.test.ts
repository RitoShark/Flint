import { describe, expect, it } from 'vitest';
import { useLspLogStore } from './lspLogStore';

describe('live LSP ownership', () => {
    it('replaces the snapshot on file switch and ignores late updates or cleanup from the old session', () => {
        const store = useLspLogStore.getState();
        store.begin('old', 'old.bin', () => {});
        store.update('old', { state: 'error', message: 'Old error', output: { message: 'old log', level: 'error' } });
        store.begin('new', 'new.bin', () => {});
        store.update('old', { message: 'Late notification' });
        store.end('old');
        expect(useLspLogStore.getState().live).toMatchObject({ session: 'new', filePath: 'new.bin', state: 'starting', diagnostics: null, output: null, requestErrors: {} });
        store.end('new');
        expect(useLspLogStore.getState().live).toBeNull();
    });
});
