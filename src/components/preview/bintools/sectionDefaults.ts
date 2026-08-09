import { useUxStore } from '../../../lib/stores/uxStore';
import { sectionStartsExpanded } from '../../modals/settings/BinEditorTab';

/**
 * Whether a tools-panel section starts expanded.
 *
 * Read once at mount (each section keeps its own open/closed state after that),
 * so flipping the setting affects the next BIN opened rather than yanking a
 * panel the user is mid-way through using.
 */
export function useSectionDefault(title: string): boolean {
    const stored = useUxStore((s) => s.binEditorExpandedSections);
    return sectionStartsExpanded(title, stored);
}
