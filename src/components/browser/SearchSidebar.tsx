import React from 'react';
import { WorkspaceSearch } from './WorkspaceSearch';

interface SearchSidebarProps {
    projectPath: string;
    seedBin?: string | null;
    style?: React.CSSProperties;
}

/**
 * The workspace search on its own, for the standalone file editor.
 *
 * No header of its own: the editor toolbar's search chip is what opens and
 * closes it, and a second control that does the same thing is redundant. That
 * view deliberately has no `LeftPanel` — showing the open project's file tree
 * beside a file from somewhere else was misleading. Search has no such problem;
 * it is scoped to the project the OPEN FILE belongs to.
 */
export const SearchSidebar: React.FC<SearchSidebarProps> = ({ projectPath, seedBin, style }) => (
    <aside className="left-panel" style={style}>
        <WorkspaceSearch projectPath={projectPath} seedBin={seedBin} />
    </aside>
);
