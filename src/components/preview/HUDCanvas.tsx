import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { HudData, HudEntry } from '../../lib/api';
import './HUDCanvas.css';

interface HUDCanvasProps {
    hudData: HudData;
    onPositionChange: (elementId: string, newPosition: { x: number; y: number }) => void;
    onDragEndBatch: (changes: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }>) => void;
    onDeleteElement: (elementId: string) => void;
    visibleGroups: Record<string, boolean>;
    visibleLayers: Set<number>;
    selectedSearchElements: Set<string>;
    determineElementGroup: (key: string, entry: HudEntry) => string;
}

interface ParsedElement {
    id: string;
    name: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    anchor: { x: number; y: number };
    layer: number;
    enabled: boolean;
    group: string;
}

interface DragState {
    elementId: string;
    startX: number;
    startY: number;
    startSvgX: number;
    startSvgY: number;
    startPos: { x: number; y: number };
}

const VIEWPORT_SIZE = { width: 1600, height: 1200 };

export const HUDCanvas: React.FC<HUDCanvasProps> = ({
    hudData,
    onPositionChange,
    onDragEndBatch,
    onDeleteElement,
    visibleGroups,
    visibleLayers,
    selectedSearchElements,
    determineElementGroup,
}) => {
    const [selectedElements, setSelectedElements] = useState<Set<string>>(new Set());
    const [dragState, setDragState] = useState<DragState | null>(null);
    const [dragStartPositions, setDragStartPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
    const [opacity, setOpacity] = useState(0.7);
    const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });

    const canvasRef = useRef<SVGSVGElement>(null);

    const parseElements = useCallback((): ParsedElement[] => {
        const elements: ParsedElement[] = [];

        Object.entries(hudData.entries).forEach(([key, entry]) => {
            if (entry.position?.UIRect) {
                const rect = entry.position.UIRect;
                const anchor = entry.position.Anchors?.Anchor || { x: 0.5, y: 1 };

                if (!rect.position) return;

                elements.push({
                    id: key,
                    name: entry.name,
                    position: { x: rect.position.x, y: rect.position.y },
                    size: { width: rect.Size.x || 0, height: rect.Size.y || 0 },
                    anchor: { x: anchor.x, y: anchor.y },
                    layer: entry.Layer,
                    enabled: entry.enabled,
                    group: determineElementGroup(key, entry),
                });
            }
        });

        return elements.sort((a, b) => a.layer - b.layer);
    }, [hudData, determineElementGroup]);

    const elements = useMemo(() => parseElements(), [parseElements]);

    const filteredElements = useMemo(() => {
        return elements.filter(element => {
            const groupVisible = visibleGroups[element.group] !== false;
            const layerVisible = visibleLayers.size === 0 || visibleLayers.has(element.layer);
            return groupVisible && layerVisible;
        });
    }, [elements, visibleGroups, visibleLayers]);

    const clientToSvg = useCallback((clientX: number, clientY: number) => {
        const svg = canvasRef.current;
        if (!svg || !svg.createSVGPoint) {
            return { x: 0, y: 0 };
        }
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const svgPt = pt.matrixTransform(ctm.inverse());
        return { x: svgPt.x, y: svgPt.y };
    }, []);

    const handleMouseDown = useCallback((e: React.MouseEvent, element: ParsedElement) => {
        e.preventDefault();
        e.stopPropagation();

        const rect = canvasRef.current!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const { x: startSvgX, y: startSvgY } = clientToSvg(e.clientX, e.clientY);

        if (e.altKey) {
            onDeleteElement(element.id);
            return;
        }

        if (selectedSearchElements.size > 0 && selectedSearchElements.has(element.id)) {
            setSelectedElements(selectedSearchElements);
        } else if (selectedElements.size > 0 && selectedElements.has(element.id)) {
            // Continue with existing selection
        } else {
            setSelectedElements(new Set([element.id]));
        }

        const startPositions = new Map<string, { x: number; y: number }>();
        startPositions.set(element.id, { ...element.position });

        if (selectedElements.size > 1) {
            selectedElements.forEach(elementId => {
                if (elementId !== element.id) {
                    const selectedElement = elements.find(el => el.id === elementId);
                    if (selectedElement) {
                        startPositions.set(elementId, { ...selectedElement.position });
                    }
                }
            });
        }

        setDragStartPositions(startPositions);

        setDragState({
            elementId: element.id,
            startX: mouseX,
            startY: mouseY,
            startSvgX,
            startSvgY,
            startPos: { ...element.position },
        });
    }, [selectedElements, selectedSearchElements, elements, clientToSvg, onDeleteElement]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const { x: svgX, y: svgY } = clientToSvg(e.clientX, e.clientY);
        setCursorPosition({ x: Math.round(svgX), y: Math.round(svgY) });

        if (!dragState) return;

        const deltaX = svgX - dragState.startSvgX;
        const deltaY = svgY - dragState.startSvgY;

        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        const draggedNewPos = {
            x: dragState.startPos.x + deltaX,
            y: dragState.startPos.y + deltaY,
        };

        if (selectedElements.size > 1) {
            const draggedElement = elements.find(el => el.id === dragState.elementId);
            if (draggedElement) {
                const offsetX = draggedNewPos.x - draggedElement.position.x;
                const offsetY = draggedNewPos.y - draggedElement.position.y;

                selectedElements.forEach(elementId => {
                    const element = elements.find(el => el.id === elementId);
                    if (element) {
                        const elementNewPos = {
                            x: element.position.x + offsetX,
                            y: element.position.y + offsetY,
                        };
                        onPositionChange(elementId, elementNewPos);
                    }
                });
            }
        } else {
            onPositionChange(dragState.elementId, draggedNewPos);
        }
    }, [dragState, selectedElements, elements, onPositionChange, clientToSvg]);

    const handleMouseUp = useCallback(() => {
        if (dragState && dragStartPositions.size > 0) {
            let hasMovement = false;
            const changes: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }> = [];

            dragStartPositions.forEach((startPos, elementId) => {
                const element = elements.find(el => el.id === elementId);
                if (element && (startPos.x !== element.position.x || startPos.y !== element.position.y)) {
                    changes.push({
                        id: elementId,
                        from: { ...startPos },
                        to: { x: element.position.x, y: element.position.y },
                    });
                    hasMovement = true;
                }
            });

            if (hasMovement) {
                onDragEndBatch(changes);
            }
        }

        setDragState(null);
        setDragStartPositions(new Map());
    }, [dragState, elements, dragStartPositions, onDragEndBatch]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSelectedElements(new Set());
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <div className="hud-canvas">
            <div className="hud-canvas__controls">
                <div className="hud-canvas__control-group">
                    <label>Opacity: {Math.round(opacity * 100)}%</label>
                    <input
                        type="range"
                        min="0.1"
                        max="1"
                        step="0.1"
                        value={opacity}
                        onChange={(e) => setOpacity(parseFloat(e.target.value))}
                    />
                </div>
                <div className="hud-canvas__control-group">
                    <span className="hud-canvas__cursor-pos">
                        Cursor: ({cursorPosition.x}, {cursorPosition.y})
                    </span>
                </div>
                {selectedElements.size > 1 && (
                    <div className="hud-canvas__selection-count">
                        {selectedElements.size} elements selected
                    </div>
                )}
            </div>

            <div className="hud-canvas__viewport">
                <svg
                    ref={canvasRef}
                    viewBox={`0 0 ${VIEWPORT_SIZE.width} ${VIEWPORT_SIZE.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    className="hud-canvas__svg"
                >
                    <defs>
                        <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#374151" strokeWidth="1" opacity="0.3" />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#grid)" />

                    <rect
                        x="0"
                        y="0"
                        width={VIEWPORT_SIZE.width}
                        height={VIEWPORT_SIZE.height}
                        fill="none"
                        stroke="#6B7280"
                        strokeWidth="2"
                    />

                    <g className="pointer-events-none">
                        <circle
                            cx={cursorPosition.x}
                            cy={cursorPosition.y}
                            r="2"
                            fill="#FF0000"
                            stroke="#FFFFFF"
                            strokeWidth="1"
                            opacity="0.9"
                        />
                        <text
                            x={cursorPosition.x + 10}
                            y={cursorPosition.y - 10}
                            fill="#FF0000"
                            fontSize="12"
                            fontWeight="bold"
                        >
                            ({cursorPosition.x}, {cursorPosition.y})
                        </text>
                    </g>

                    {filteredElements.map((element) => (
                        <g key={element.id}>
                            <rect
                                x={element.position.x}
                                y={element.position.y}
                                width={element.size.width}
                                height={element.size.height}
                                fill={
                                    selectedElements.has(element.id)
                                        ? '#3B82F6'
                                        : selectedSearchElements.has(element.id)
                                        ? '#F59E0B'
                                        : '#1F2937'
                                }
                                stroke={
                                    selectedElements.has(element.id)
                                        ? '#60A5FA'
                                        : selectedSearchElements.has(element.id)
                                        ? '#FBBF24'
                                        : element.size.width === 66 && element.size.height === 66
                                        ? '#10B981'
                                        : element.size.width === 48 && element.size.height === 48
                                        ? '#F59E0B'
                                        : '#4B5563'
                                }
                                strokeWidth={selectedElements.has(element.id) || selectedSearchElements.has(element.id) ? '4' : '2'}
                                opacity={opacity}
                                rx="4"
                                className="hud-canvas__element"
                                onMouseDown={(e) => handleMouseDown(e, element)}
                            />
                            <circle
                                cx={element.position.x + element.size.width / 2}
                                cy={element.position.y + element.size.height / 2}
                                r="2"
                                fill="#60A5FA"
                                className="pointer-events-none"
                            />
                        </g>
                    ))}
                </svg>
            </div>

            <div className="hud-canvas__legend">
                <div className="legend-item">
                    <span className="legend-color" style={{ backgroundColor: '#10B981' }}></span>
                    <span>66×66 Abilities</span>
                </div>
                <div className="legend-item">
                    <span className="legend-color" style={{ backgroundColor: '#F59E0B' }}></span>
                    <span>48×48 Summoners</span>
                </div>
                <div className="legend-item">
                    <span className="legend-color" style={{ backgroundColor: '#3B82F6' }}></span>
                    <span>Selected</span>
                </div>
                <div className="hud-canvas__legend-hint">
                    <strong>Controls:</strong> Drag to move • Alt+Click to delete • Esc to deselect
                </div>
            </div>
        </div>
    );
};
