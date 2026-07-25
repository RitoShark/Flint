import { useAction } from './hooks';
import { cycleTab, jumpToTabSlot } from './tabActions';

/**
 * Bind the tab-navigation actions.
 *
 * Registrations are written out one per line rather than generated in a loop:
 * hooks must be called in a stable order, and an explicit list also keeps each
 * action id greppable back to its manifest entry.
 */
export function useTabShortcuts(): void {
    useAction('tab.next', () => cycleTab(1));
    useAction('tab.prev', () => cycleTab(-1));

    useAction('tab.slot1', () => jumpToTabSlot(1));
    useAction('tab.slot2', () => jumpToTabSlot(2));
    useAction('tab.slot3', () => jumpToTabSlot(3));
    useAction('tab.slot4', () => jumpToTabSlot(4));
    useAction('tab.slot5', () => jumpToTabSlot(5));
    useAction('tab.slot6', () => jumpToTabSlot(6));
    useAction('tab.slot7', () => jumpToTabSlot(7));
    useAction('tab.slot8', () => jumpToTabSlot(8));
    useAction('tab.last', () => jumpToTabSlot(9));
}
