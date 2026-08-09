import React from 'react';
import { Icon } from '../ui';
import { WorkspaceSearch } from './WorkspaceSearch';

interface SearchSidebarProps {
    projectPath: string;
    seedBin?: string | null;
    onClose: () => void;
    style?: React.CSSProperties;
}

/**
 * The workspace search on its own, for the standalone file editor.
 *
 * That view deliberately has no `LeftPanel` — showing the open project's file
 * tree beside a file from somewhere else was misleading. Search has no such
 * problem: it is scoped to the project the OPEN FILE belongs to.
 */
export const SearchSidebar: React.FC<SearchSidebarProps> = ({
    projectPath,
    seedBin,
    onClose,
    style,
}) => (
    <aside className="left-panel" style={style}>
        <div className="left-panel__views">
            <button className="left-panel__view is-active" onClick={onClose}>
                <Icon name="search" className="left-panel__view-icon" />
                <span>Search</span>
            </button>
            <button className="left-panel__view" onClick={onClose} title="Hide search">
                <Icon name="close" className="left-panel__view-icon" />
            </button>
        </div>
        <WorkspaceSearch projectPath={projectPath} seedBin={seedBin} />
    </aside>
);
