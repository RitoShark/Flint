import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotificationStore } from '../../../lib/stores';
import {
    configFromDraft,
    draftFromConfig,
    draftsMatch,
    type ModConfig,
    type ModInfoDraft,
} from '../../../lib/editor/modInfo';
import * as api from '../../../lib/api';

export interface ModInfoState {
    draft: ModInfoDraft | null;
    slug: string;
    dirty: boolean;
    saving: boolean;
    update: (patch: Partial<ModInfoDraft>) => void;
    save: () => Promise<boolean>;
}

export function useModInfo(filePath: string | null, active: boolean, onLoadError: () => void): ModInfoState {
    const showToast = useNotificationStore((s) => s.showToast);
    const [config, setConfig] = useState<ModConfig | null>(null);
    const [draft, setDraft] = useState<ModInfoDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const savedRef = useRef<ModInfoDraft | null>(null);
    const errorRef = useRef(onLoadError);
    errorRef.current = onLoadError;

    useEffect(() => {
        if (!active || !filePath) return;
        let cancelled = false;
        (async () => {
            try {
                const parsed = JSON.parse(await api.readTextFile(filePath)) as ModConfig;
                if (cancelled) return;
                const next = draftFromConfig(parsed);
                setConfig(parsed);
                setDraft(next);
                savedRef.current = next;
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to load mod.config.json:', err);
                showToast('error', 'Failed to load mod.config.json');
                errorRef.current();
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [active, filePath, showToast]);

    const update = useCallback((patch: Partial<ModInfoDraft>) => {
        setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    }, []);

    const save = useCallback(async () => {
        if (!config || !draft || !filePath) return false;
        setSaving(true);
        try {
            const updated = configFromDraft(config, draft);
            await api.writeTextFile(filePath, JSON.stringify(updated, null, 2));
            setConfig(updated);
            savedRef.current = draft;
            showToast('success', 'Project info saved');
            return true;
        } catch (err) {
            console.error('Failed to save mod.config.json:', err);
            showToast('error', 'Failed to save project info');
            return false;
        } finally {
            setSaving(false);
        }
    }, [config, draft, filePath, showToast]);

    const dirty = !!draft && !!savedRef.current && !draftsMatch(draft, savedRef.current);

    return { draft, slug: (config?.name as string) || '', dirty, saving, update, save };
}
