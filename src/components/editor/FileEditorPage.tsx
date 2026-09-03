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
import { MOD_INFO_SECTIONS, ModInfoForm, type ModInfoSection } from '../modals/modinfo/ModInfoForm';
import { useModInfo } from '../modals/modinfo/useModInfo';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { projectRootFromFilePath } from '../../lib/wadPath';
import { useSearchPanelStore } from '../../lib/stores/searchPanelStore';

const ModConfigEditor: React.FC<{ target: FileEditorTarget }> = ({ target }) => {
    const setDirty = useFileEditorStore((s) => s.setDirty);
    const [section, setSection] = useState<ModInfoSection>('details');
    const close = useCallback(() => navigationCoordinator.closeFileEditorWithFallback(), []);
    const { draft, slug, dirty, saving, update, save } = useModInfo(target.filePath, true, close);

    useEffect(() => {
        setDirty(dirty);
    }, [dirty, setDirty]);

    if (!draft) {
        return <div className="mi-page__loading">Loading project info…</div>;
    }

    return (
        <div className="mi-page">
            <nav className="mi-nav" role="tablist" aria-orientation="vertical">
                {MOD_INFO_SECTIONS.map((entry) => (
                    <button
                        key={entry.id}
                        role="tab"
                        aria-selected={section === entry.id}
                        className={`mi-nav__item${section === entry.id ? ' is-active' : ''}`}
                        onClick={() => setSection(entry.id)}
                    >
                        <span
                            className="mi-nav__icon"
                            dangerouslySetInnerHTML={{ __html: getIcon(entry.icon) }}
                        />
                        <span className="mi-nav__label">{entry.label}</span>
                    </button>
                ))}
            </nav>

            <div className="mi-page__main">
                <div className="mi-body" role="tabpanel">
                    <ModInfoForm section={section} draft={draft} slug={slug} onChange={update} />
                </div>
                <div className="mi-page__foot">
                    <span className="mi-foot__path">mod.config.json</span>
                    <button className="dl-btn dl-btn--secondary" onClick={close} disabled={saving}>
                        {dirty ? 'Discard' : 'Close'}
                    </button>
                    <button className="dl-btn dl-btn--primary" onClick={() => void save()} disabled={!dirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
};

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
    const ownsScroll = isBin || target.kind === 'modConfig';
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
                    overflowY: ownsScroll ? 'hidden' : 'auto',
                    backgroundColor: 'var(--bg-primary)',
                }}
            >
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    {target.kind === 'modConfig' && <ModConfigEditor key={target.filePath} target={target} />}
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
