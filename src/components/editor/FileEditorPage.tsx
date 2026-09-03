import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import {
    useFileEditorStore,
    useNotificationStore,
} from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import type { FileEditorTarget } from '../../lib/types';
import { BinEditor } from '../preview/BinEditor';
import { LuaBin64Editor } from '../preview/LuaBin64Editor';
import { TroybinViewer } from '../preview/TroybinViewer';
import { Button, Textarea } from '../ui';
import { SearchSidebar } from '../browser/SearchSidebar';
import { projectRootFromFilePath } from '../../lib/wadPath';
import { useSearchPanelStore } from '../../lib/stores/searchPanelStore';

// ─── Raw text fallback ─────────────────────────────────────────────────

const RawTextEditor: React.FC<{ target: FileEditorTarget }> = ({ target }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const setDirty = useFileEditorStore((s) => s.setDirty);

    const [content, setContent] = useState<string>('');
    const [localDirty, setLocalDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const text = await api.readTextFile(target.filePath);
                setContent(text);
                setLocalDirty(false);
                setDirty(false);
            } catch {
                showToast('error', 'Failed to load file');
                navigationCoordinator.closeFileEditorWithFallback();
            }
        })();
    }, [target.filePath, showToast, setDirty]);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await api.writeTextFile(target.filePath, content);
            setLocalDirty(false);
            setDirty(false);
            showToast('success', 'File saved');
        } catch {
            showToast('error', 'Failed to save file');
        } finally {
            setSaving(false);
        }
    }, [target.filePath, content, showToast, setDirty]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', padding: '16px 24px 24px', height: '100%', minHeight: 0 }}>
            <Textarea
                value={content}
                onChange={(e) => { setContent(e.target.value); setLocalDirty(true); setDirty(true); }}
                rows={28}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'none' }}
            />
            <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 16,
                paddingTop: 16,
                borderTop: '1px solid var(--border)',
            }}>
                <Button variant="secondary" onClick={() => navigationCoordinator.closeFileEditorWithFallback()} disabled={saving}>
                    {localDirty ? 'Discard' : 'Close'}
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={!localDirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </div>
    );
};

// ─── Page shell ────────────────────────────────────────────────────────

export const FileEditorPage: React.FC = () => {
    const target = useFileEditorStore((s) => s.target);
    const searchOpen = useSearchPanelStore((s) => s.open);

    if (!target) {
        return (
            <div style={{ padding: 32, color: 'var(--text-secondary)' }}>
                No file is currently being edited.
            </div>
        );
    }

    const isBin = target.kind === 'binText';
    const searchRoot = isBin
        ? (target.projectPath ?? projectRootFromFilePath(target.filePath))
        : null;

    return (
        <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
            {searchOpen && searchRoot && (
                <SearchSidebar projectPath={searchRoot} seedBin={target.filePath} />
            )}
            <div
                className="file-editor-page"
                style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    overflowY: isBin ? 'hidden' : 'auto',
                    backgroundColor: 'var(--bg-primary)',
                }}
            >
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    {target.kind === 'raw' && <RawTextEditor key={target.filePath} target={target} />}
                    {isBin && (
                        <BinEditor key={target.filePath} filePath={target.filePath} hideFilename />
                    )}
                    {target.kind === 'luaBin64' && (
                        <LuaBin64Editor key={target.filePath} filePath={target.filePath} hideFilename />
                    )}
                    {target.kind === 'troybin' && (
                        <TroybinViewer key={target.filePath} filePath={target.filePath} />
                    )}
                </div>

            </div>
        </div>
    );
};
