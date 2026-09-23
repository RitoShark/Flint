/**
 * Hand a BIN to RubyRe (or just start it when `binPath` is null) and report the outcome as
 * a toast. Shared by the title bar's RubyRe button and the BIN chooser it opens.
 */
import * as api from './api';
import { useNotificationStore } from './stores';

export async function sendToRuby(binPath: string | null): Promise<void> {
    const { showToast } = useNotificationStore.getState();
    try {
        const result = await api.launchRuby(binPath);
        if (result.warning) showToast('warning', result.warning);
    } catch (err) {
        const flintError = err as api.FlintError;
        showToast('error', flintError.getUserMessage?.() || 'Failed to launch RubyRe');
    }
}
