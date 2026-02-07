/**
 * Flint - Tab Bar Component
 * Displays tabs for open projects with switch/close functionality
 */

import React, { useCallback } from 'react';
import { useAppState } from '../lib/state';
import { getIcon } from '../lib/fileIcons';
import type { ProjectTab } from '../lib/types';

/**
 * Individual tab component
 */
interface TabProps {
    tab: ProjectTab;
    isActive: boolean;
    onSwitch: () => void;
    onClose: (e: React.MouseEvent) => void;
}

const Tab: React.FC<TabProps> = ({ tab, isActive, onSwitch, onClose }) => {
    const handleMiddleClick = useCallback((e: React.MouseEvent) => {
        if (e.button === 1) { // Middle click
            e.preventDefault();
            onClose(e);
        }
    }, [onClose]);

    const projectName = tab.project.display_name || tab.project.name;
    const champion = tab.project.champion;

    return (
        <div
            className={`tabbar__tab ${isActive ? 'tabbar__tab--active' : ''}`}
            onClick={onSwitch}
            onMouseDown={handleMiddleClick}
            title={`${champion} - ${projectName}\n${tab.projectPath}`}
        >
            <span
                className="tabbar__tab-icon"
                dangerouslySetInnerHTML={{ __html: getIcon('folder') }}
            />
            <span className="tabbar__tab-name">
                {champion} - {projectName}
            </span>
            <button
                className="tabbar__tab-close"
                onClick={onClose}
                title="Close Tab"
            >
                <svg viewBox="0 0 16 16" width="14" height="14">
                    <path
                        d="M4.5 4.5l7 7m0-7l-7 7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        fill="none"
                    />
                </svg>
            </button>
        </div>
    );
};

/**
 * Tab bar component showing all open project tabs
 */
export const TabBar: React.FC = () => {
    const { state, dispatch } = useAppState();

    const handleSwitchTab = useCallback((tabId: string) => {
        dispatch({ type: 'SWITCH_TAB', payload: tabId });
    }, [dispatch]);

    const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        dispatch({ type: 'REMOVE_TAB', payload: tabId });
    }, [dispatch]);

    // Don't render if no tabs
    if (state.openTabs.length === 0) {
        return null;
    }

    return (
        <div className="tabbar">
            <div className="tabbar__tabs">
                {state.openTabs.map(tab => (
                    <Tab
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === state.activeTabId}
                        onSwitch={() => handleSwitchTab(tab.id)}
                        onClose={(e) => handleCloseTab(e, tab.id)}
                    />
                ))}
            </div>
        </div>
    );
};
