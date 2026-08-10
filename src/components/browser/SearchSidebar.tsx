import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceSearch } from './WorkspaceSearch';

interface SearchSidebarProps {
    projectPath: string;
    seedBin?: string | null;
}

const MIN_WIDTH = 220;
const MAX_WIDTH = 620;
const DEFAULT_WIDTH = 300;

/**
 * The workspace search on its own, for the standalone file editor.
 *
 * No header of its own: the editor toolbar's search chip is what opens and
 * closes it, and a second control that does the same thing is redundant. That
 * view deliberately has no `LeftPanel` — showing the open project's file tree
 * beside a file from somewhere else was misleading. Search has no such problem;
 * it is scoped to the project the OPEN FILE belongs to.
 *
 * It owns its own width + resizer because the file editor has no `LeftPanel`
 * and therefore never reaches `App`'s.
 */
export const SearchSidebar: React.FC<SearchSidebarProps> = ({ projectPath, seedBin }) => {
    const [width, setWidth] = useState(DEFAULT_WIDTH);
    const draggingRef = useRef(false);

    const beginDrag = useCallback(() => {
        draggingRef.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX)));
        };
        const onUp = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
    }, []);

    return (
        <>
            <aside className="left-panel" style={{ width, flexShrink: 0 }}>
                <WorkspaceSearch projectPath={projectPath} seedBin={seedBin} />
            </aside>
            <div
                className="panel-resizer"
                onMouseDown={beginDrag}
                onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
            />
        </>
    );
};
