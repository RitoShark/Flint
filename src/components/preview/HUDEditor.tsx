import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { HUDCanvas } from './HUDCanvas';
import * as api from '../../lib/api';
import type { HudData, HudEntry } from '../../lib/api';
import './HUDEditor.css';

interface HUDEditorProps {
    filePath: string;
}

interface HistoryEntry {
    action: string;
    data: {
        hudData: HudData;
        deletedElements: string[];
    };
    timestamp: number;
}

interface VisibleGroups {
    abilities: boolean;
    summoners: boolean;
    levelUp: boolean;
    effects: boolean;
    text: boolean;
    icons: boolean;
    regions: boolean;
    animations: boolean;
    cooldowns: boolean;
    desaturate: boolean;
    ammo: boolean;
    [key: string]: boolean;
}

const UNDO_HISTORY_LIMIT = 200;

const determineElementGroup = (key: string, entry: HudEntry): string => {
    if (entry.type === 'UiElementTextData') return 'text';
    if (entry.type === 'UiElementIconData') return 'icons';
    if (entry.type === 'UiElementRegionData') return 'regions';
    if (entry.type === 'UiElementEffectAnimationData') return 'animations';
    if (entry.type === 'UiElementEffectCooldownRadialData') return 'cooldowns';
    if (entry.type === 'UiElementEffectDesaturateData') return 'desaturate';
    if (entry.type === 'UiElementEffectAmmoData') return 'ammo';

    if (key.includes('Ability')) return 'abilities';
    if (key.includes('Summoner')) return 'summoners';
    if (key.includes('LevelUp')) return 'levelUp';
    return 'effects';
};

export const HUDEditor: React.FC<HUDEditorProps> = ({ filePath }) => {
    const [hudData, setHudData] = useState<HudData | null>(null);
    const [originalData, setOriginalData] = useState<HudData | null>(null);
    const [originalContent, setOriginalContent] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [deletedElements, setDeletedElements] = useState<Set<string>>(new Set());
    const [undoHistory, setUndoHistory] = useState<HistoryEntry[]>([]);
    const [undoIndex, setUndoIndex] = useState(-1);
    const [visibleGroups, setVisibleGroups] = useState<VisibleGroups>({
        abilities: true,
        summoners: true,
        levelUp: true,
        effects: true,
        text: true,
        icons: true,
        regions: true,
        animations: true,
        cooldowns: true,
        desaturate: true,
        ammo: true,
    });
    const [visibleLayers, setVisibleLayers] = useState<Set<number>>(new Set());
    const [statsPanelExpanded, setStatsPanelExpanded] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedSearchElements, setSelectedSearchElements] = useState<Set<string>>(new Set());

    useEffect(() => {
        const loadHudFile = async () => {
            setIsLoading(true);
            setError(null);

            try {
                const content = await api.readTextFile(filePath);
                setOriginalContent(content);

                const jsonData = JSON.parse(content);

                const hudData: HudData = {
                    type: jsonData.type || 'PROP',
                    version: jsonData.version || 1,
                    linked: jsonData.linked || [],
                    entries: {},
                };

                Object.entries(jsonData).forEach(([key, value]: [string, any]) => {
                    if (key.startsWith('#') && typeof value === 'object') {
                        const hash = key.substring(1);
                        hudData.entries[hash] = {
                            name: value.name || hash,
                            type: value.type || 'Unknown',
                            enabled: value.enabled !== false,
                            Layer: value.Layer || 0,
                            position: value.position,
                            TextureData: value.TextureData,
                            Scene: value.Scene,
                            extra: value,
                        };
                    }
                });

                console.log(`[HUDEditor] Loaded ${Object.keys(hudData.entries).length} elements`);

                setHudData(hudData);
                const parsedDataClone = JSON.parse(JSON.stringify(hudData));
                setOriginalData(parsedDataClone);
                setHasChanges(false);

                const initSnapshot: HistoryEntry = {
                    action: 'init',
                    data: { hudData: parsedDataClone, deletedElements: [] },
                    timestamp: Date.now(),
                };
                setUndoHistory([initSnapshot]);
                setUndoIndex(0);

            } catch (err) {
                console.error('[HUDEditor] Error loading file:', err);
                setError(`Failed to load HUD file: ${(err as Error).message}`);
            } finally {
                setIsLoading(false);
            }
        };

        loadHudFile();
    }, [filePath]);

    const uniqueLayers = useMemo(() => {
        if (!hudData) return [];
        const layers = new Set<number>();
        Object.values(hudData.entries).forEach(entry => {
            layers.add(entry.Layer);
        });
        return Array.from(layers).sort((a, b) => a - b);
    }, [hudData]);

    useEffect(() => {
        if (hudData && uniqueLayers.length > 0) {
            setVisibleLayers(new Set(uniqueLayers));
        }
    }, [hudData, uniqueLayers]);

    const searchResults = useMemo(() => {
        if (!hudData || !searchTerm.trim()) return [];

        const results: Array<{ id: string; name: string; type: string; layer: number }> = [];
        Object.entries(hudData.entries).forEach(([key, entry]) => {
            if (entry.name.toLowerCase().includes(searchTerm.toLowerCase())) {
                results.push({
                    id: key,
                    name: entry.name,
                    type: entry.type,
                    layer: entry.Layer,
                });
            }
        });
        return results;
    }, [hudData, searchTerm]);

    const saveToUndoHistory = useCallback((action: string, data: { hudData: HudData; deletedElements: string[] }) => {
        const historyEntry: HistoryEntry = {
            action,
            data: JSON.parse(JSON.stringify(data)),
            timestamp: Date.now(),
        };

        setUndoHistory(prevHistory => {
            const newHistory = prevHistory.slice(0, undoIndex + 1);
            newHistory.push(historyEntry);

            if (newHistory.length > UNDO_HISTORY_LIMIT) {
                newHistory.splice(0, newHistory.length - UNDO_HISTORY_LIMIT);
            }
            return newHistory;
        });

        setUndoIndex(prev => prev + 1);
    }, [undoIndex]);

    const handlePositionChange = useCallback((elementId: string, newPosition: { x: number; y: number }) => {
        if (!hudData) return;

        setHudData(prevData => {
            if (!prevData) return prevData;

            const updatedData = { ...prevData };
            const entry = updatedData.entries[elementId];

            if (entry?.position?.UIRect) {
                updatedData.entries[elementId] = {
                    ...entry,
                    position: {
                        ...entry.position,
                        UIRect: {
                            ...entry.position.UIRect,
                            position: {
                                x: Math.round(newPosition.x),
                                y: Math.round(newPosition.y),
                            },
                        },
                    },
                };
            }
            return updatedData;
        });
    }, [hudData]);

    const handleDragEndBatch = useCallback((changes: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }>) => {
        if (!hudData || changes.length === 0) return;

        const hasMovement = changes.some(({ from, to }) => from.x !== to.x || from.y !== to.y);
        if (!hasMovement) return;

        const historyData = {
            hudData: JSON.parse(JSON.stringify(hudData)),
            deletedElements: Array.from(deletedElements),
        };

        saveToUndoHistory('move', historyData);
        setHasChanges(true);
    }, [hudData, deletedElements, saveToUndoHistory]);

    const handleDeleteElement = useCallback((elementId: string) => {
        if (!hudData || !originalData) return;

        const newDeleted = new Set([...deletedElements, elementId]);
        const newHudData = JSON.parse(JSON.stringify(hudData));

        if (newHudData.entries && newHudData.entries[elementId]) {
            delete newHudData.entries[elementId];
        }

        setDeletedElements(newDeleted);
        setHudData(newHudData);
        setHasChanges(true);

        saveToUndoHistory('delete', {
            hudData: newHudData,
            deletedElements: Array.from(newDeleted),
        });
    }, [hudData, originalData, deletedElements, saveToUndoHistory]);

    const handleUndo = useCallback(() => {
        if (undoIndex <= 0) return;

        const newIndex = undoIndex - 1;
        const historyEntry = undoHistory[newIndex];

        if (historyEntry?.data) {
            setHudData(historyEntry.data.hudData);
            setDeletedElements(new Set(historyEntry.data.deletedElements || []));
            setUndoIndex(newIndex);
            setHasChanges(true);
        }
    }, [undoHistory, undoIndex]);

    const handleRedo = useCallback(() => {
        if (undoIndex >= undoHistory.length - 1) return;

        const newIndex = undoIndex + 1;
        const historyEntry = undoHistory[newIndex];

        if (historyEntry?.data) {
            setHudData(historyEntry.data.hudData);
            setDeletedElements(new Set(historyEntry.data.deletedElements || []));
            setUndoIndex(newIndex);
            setHasChanges(true);
        }
    }, [undoHistory, undoIndex]);

    const handleExport = useCallback(async () => {
        if (!hudData || !originalContent) return;

        try {
            await api.saveHudRitobinFile(filePath, hudData, originalContent);
            setHasChanges(false);
            console.log('[HUDEditor] Successfully saved HUD file');
        } catch (err) {
            console.error('[HUDEditor] Error saving file:', err);
            setError(`Failed to save file: ${(err as Error).message}`);
        }
    }, [hudData, originalContent, filePath]);

    const handleReset = useCallback(() => {
        if (originalData) {
            setHudData(JSON.parse(JSON.stringify(originalData)));
            setDeletedElements(new Set());
            setUndoHistory([]);
            setUndoIndex(-1);
            setHasChanges(false);
        }
    }, [originalData]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey) {
                switch (e.key.toLowerCase()) {
                    case 'z':
                        e.preventDefault();
                        handleUndo();
                        break;
                    case 'y':
                        e.preventDefault();
                        handleRedo();
                        break;
                    case 's':
                        e.preventDefault();
                        handleExport();
                        break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleUndo, handleRedo, handleExport]);

    const stats = useMemo(() => {
        if (!hudData) return null;

        const groups: Record<keyof VisibleGroups, string[]> = {
            abilities: [],
            summoners: [],
            levelUp: [],
            effects: [],
            text: [],
            icons: [],
            regions: [],
            animations: [],
            cooldowns: [],
            desaturate: [],
            ammo: [],
        };

        Object.entries(hudData.entries).forEach(([key, entry]) => {
            const group = determineElementGroup(key, entry);
            groups[group].push(key);
        });

        return {
            total: Object.keys(hudData.entries).length,
            abilities: groups.abilities.length,
            summoners: groups.summoners.length,
            levelUp: groups.levelUp.length,
            effects: groups.effects.length,
            text: groups.text.length,
            icons: groups.icons.length,
            regions: groups.regions.length,
            animations: groups.animations.length,
            cooldowns: groups.cooldowns.length,
            desaturate: groups.desaturate.length,
            ammo: groups.ammo.length,
        };
    }, [hudData]);

    if (isLoading) {
        return (
            <div className="hud-editor__loading">
                <div className="spinner" />
                <span>Loading HUD file...</span>
            </div>
        );
    }

    if (error || !hudData) {
        return (
            <div className="hud-editor__error">
                <span className="error-icon">⚠️</span>
                <span>{error || 'Failed to load HUD file'}</span>
            </div>
        );
    }

    return (
        <div className="hud-editor">
            <div className="hud-editor__sidebar">
                <div className="hud-editor__panel">
                    <div
                        className="hud-editor__panel-header"
                        onClick={() => setStatsPanelExpanded(!statsPanelExpanded)}
                    >
                        <h3>Element Statistics</h3>
                        <span>{statsPanelExpanded ? '▼' : '▶'}</span>
                    </div>
                    {statsPanelExpanded && stats && (
                        <div className="hud-editor__stats-grid">
                            <div className="stat-item">
                                <span className="stat-value">{stats.total}</span>
                                <span className="stat-label">Total</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-value">{stats.abilities}</span>
                                <span className="stat-label">Abilities</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-value">{stats.summoners}</span>
                                <span className="stat-label">Summoners</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-value">{stats.text}</span>
                                <span className="stat-label">Text</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="hud-editor__panel">
                    <h3>Search Elements</h3>
                    <input
                        type="text"
                        placeholder="Search by name..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="hud-editor__search-input"
                    />
                    {searchResults.length > 0 && (
                        <div className="hud-editor__search-results">
                            <div className="hud-editor__search-header">
                                {searchResults.length} results
                            </div>
                            <div className="hud-editor__search-list">
                                {searchResults.map(result => (
                                    <div
                                        key={result.id}
                                        className={`hud-editor__search-item ${selectedSearchElements.has(result.id) ? 'selected' : ''}`}
                                        onClick={() => {
                                            setSelectedSearchElements(prev => {
                                                const newSet = new Set(prev);
                                                if (newSet.has(result.id)) {
                                                    newSet.delete(result.id);
                                                } else {
                                                    newSet.add(result.id);
                                                }
                                                return newSet;
                                            });
                                        }}
                                    >
                                        <span className="search-name">{result.name}</span>
                                        <span className="search-layer">Layer {result.layer}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="hud-editor__panel">
                    <h3>Visibility</h3>
                    <div className="hud-editor__visibility-controls">
                        {Object.keys(visibleGroups).map(group => (
                            <label key={group}>
                                <input
                                    type="checkbox"
                                    checked={visibleGroups[group as keyof VisibleGroups]}
                                    onChange={(e) => setVisibleGroups({
                                        ...visibleGroups,
                                        [group]: e.target.checked,
                                    })}
                                />
                                <span>{group.charAt(0).toUpperCase() + group.slice(1)}</span>
                            </label>
                        ))}
                    </div>
                </div>

                <div className="hud-editor__panel">
                    <h3>Layers</h3>
                    <div className="hud-editor__layer-list">
                        {uniqueLayers.map(layer => (
                            <label key={layer}>
                                <input
                                    type="checkbox"
                                    checked={visibleLayers.has(layer)}
                                    onChange={(e) => {
                                        const newLayers = new Set(visibleLayers);
                                        if (e.target.checked) {
                                            newLayers.add(layer);
                                        } else {
                                            newLayers.delete(layer);
                                        }
                                        setVisibleLayers(newLayers);
                                    }}
                                />
                                <span>Layer {layer}</span>
                            </label>
                        ))}
                    </div>
                </div>

                <div className="hud-editor__actions">
                    <button
                        onClick={handleUndo}
                        disabled={undoIndex <= 0}
                        className="btn btn--sm"
                        title="Ctrl+Z"
                    >
                        ↶ Undo
                    </button>
                    <button
                        onClick={handleRedo}
                        disabled={undoIndex >= undoHistory.length - 1}
                        className="btn btn--sm"
                        title="Ctrl+Y"
                    >
                        ↷ Redo
                    </button>
                    <button
                        onClick={handleReset}
                        disabled={!hasChanges}
                        className="btn btn--sm btn--secondary"
                    >
                        Reset
                    </button>
                    <button
                        onClick={handleExport}
                        className="btn btn--sm btn--primary"
                        title="Ctrl+S"
                    >
                        Save Changes
                    </button>
                </div>

                {hasChanges && (
                    <div className="hud-editor__changes-indicator">
                        <span>●</span> Unsaved changes
                    </div>
                )}
            </div>

            <div className="hud-editor__canvas-container">
                <HUDCanvas
                    hudData={hudData}
                    onPositionChange={handlePositionChange}
                    onDragEndBatch={handleDragEndBatch}
                    onDeleteElement={handleDeleteElement}
                    visibleGroups={visibleGroups}
                    visibleLayers={visibleLayers}
                    selectedSearchElements={selectedSearchElements}
                    determineElementGroup={determineElementGroup}
                />
            </div>
        </div>
    );
};
