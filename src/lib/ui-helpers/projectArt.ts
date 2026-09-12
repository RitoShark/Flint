import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { liveChampionAlias } from '../data/datadragon';
import type { ProjectKind } from '../types';

const DDRAGON_ALIAS_OVERRIDES: Record<string, string> = {
    aurelionsol: 'AurelionSol',
    belveth: 'BelVeth',
    chogath: 'ChoGath',
    drmundo: 'DrMundo',
    jarvaniv: 'JarvanIV',
    kaisa: 'KaiSa',
    khazix: 'KhaZix',
    kogmaw: 'KogMaw',
    ksante: 'KSante',
    leblanc: 'LeBlanc',
    leesin: 'LeeSin',
    masteryi: 'MasterYi',
    missfortune: 'MissFortune',
    nunu: 'Nunu',
    reksai: 'RekSai',
    renata: 'Renata',
    renataglasc: 'Renata',
    tahmkench: 'TahmKench',
    twistedfate: 'TwistedFate',
    velkoz: 'VelKoz',
    xinzhao: 'XinZhao',
    monkeyking: 'MonkeyKing',
    wukong: 'MonkeyKing',
};

export function normalizeChampionAlias(alias: string): string {
    if (!alias) return '';
    const lower = alias.toLowerCase().replace(/['\s]/g, '');
    return DDRAGON_ALIAS_OVERRIDES[lower] ?? alias.charAt(0).toUpperCase() + alias.slice(1).toLowerCase();
}

export function championSplashUrl(alias: string): string {
    const normalized = normalizeChampionAlias(liveChampionAlias(alias));
    return `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${normalized}_0.jpg`;
}

export const thumbnailCache = new Map<string, string | null>();

export interface ProjectArtSource {
    path: string;
    champion?: string | null;
    kind?: ProjectKind;
    thumbnail?: string | null;
}

export function useProjectArtUrl(project: ProjectArtSource, visible: boolean) {
    const [thumb, setThumb] = useState<string | null>(() => project.thumbnail ?? thumbnailCache.get(project.path) ?? null);
    const [thumbFailed, setThumbFailed] = useState(thumbnailCache.get(project.path) === null && !project.thumbnail);
    const cancelled = useRef(false);

    useEffect(() => {
        cancelled.current = false;
        if (project.thumbnail) {
            setThumb(project.thumbnail);
            return;
        }
        if (!visible) return;
        if (thumbnailCache.has(project.path)) return;
        (async () => {
            try {
                const folder = project.path.replace(/[\\/](mod\.config|flint|project)\.json$/, '');
                const thumbPath = `${folder}/thumbnail.webp`;
                const bytes = await api.readFileBytes(thumbPath, { silent: true });
                if (cancelled.current) return;
                const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
                const url = URL.createObjectURL(blob);
                thumbnailCache.set(project.path, url);
                setThumb(url);
            } catch {
                if (cancelled.current) return;
                thumbnailCache.set(project.path, null);
                setThumbFailed(true);
            }
        })();
        return () => { cancelled.current = true; };
    }, [project.path, visible, project.thumbnail]);

    const hasSplashFallback = (project.kind ?? 'skin') === 'skin' && !!project.champion;
    return {
        url: thumb ?? (thumbFailed && hasSplashFallback ? championSplashUrl(project.champion!) : null),
        isLoading: visible && !thumb && !thumbFailed,
        usingFallback: thumbFailed,
    };
}
