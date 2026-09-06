import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./fileEditorStore', () => ({ useFileEditorStore: { getState: () => ({ openTarget: vi.fn() }) } }));
vi.mock('./archiveTabStore', () => ({ useArchiveTabStore: { getState: () => ({ openArchiveTab: vi.fn() }) } }));
import { useNavigationStore } from './navigationStore';

beforeEach(() => useNavigationStore.setState({ currentView: 'welcome', uiPreviewOpen: false }));

describe('UI Preview navigation', () => {
    it('opens a singleton page and can return to it after another view', () => {
        const nav = useNavigationStore.getState();
        nav.openUiPreview();
        expect(useNavigationStore.getState()).toMatchObject({ currentView: 'ui-preview', uiPreviewOpen: true });
        nav.setView('preview');
        nav.openUiPreview();
        expect(useNavigationStore.getState()).toMatchObject({ currentView: 'ui-preview', uiPreviewOpen: true });
    });
    it('closes the active preview page to the welcome screen', () => {
        useNavigationStore.getState().openUiPreview();
        useNavigationStore.getState().closeUiPreview();
        expect(useNavigationStore.getState()).toMatchObject({ currentView: 'welcome', uiPreviewOpen: false });
    });
    it('keeps the current editor visible when closing an inactive preview tab', () => {
        useNavigationStore.getState().openUiPreview();
        useNavigationStore.getState().setView('file-editor');
        useNavigationStore.getState().closeUiPreview();
        expect(useNavigationStore.getState()).toMatchObject({ currentView: 'file-editor', uiPreviewOpen: false });
    });
});
