/**
 * Flint - Welcome Screen Component
 */

import React, { useState, useEffect } from 'react';
import { useAppState } from '../lib/stores';
import { formatRelativeTime } from '../lib/utils';
import * as api from '../lib/api';
import { getIcon } from '../lib/fileIcons';
import type { RecentProject } from '../lib/types';

/**
 * Clock icon for recent projects
 */
const ClockIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);


// =============================================================================
// Welcome Screen
// =============================================================================

/** How many recent projects to show before "Show all" is clicked. */
const RECENT_DEFAULT_LIMIT = 3;

export const WelcomeScreen: React.FC = () => {
    const { state, dispatch, openModal, setWorking, setReady, setError } = useAppState();
    const [greeting, setGreeting] = useState('');
    const [showAllRecent, setShowAllRecent] = useState(false);

    // Calculate time-based greeting
    useEffect(() => {
        const getGreeting = () => {
            const hour = new Date().getHours();
            if (hour >= 7 && hour < 12) return 'Good morning';
            if (hour >= 12 && hour < 18) return 'Good afternoon';
            if (hour >= 18 && hour < 22) return 'Good evening';
            return 'Good night';
        };
        setGreeting(getGreeting());

        // Update greeting if app stays open across time boundaries
        const interval = setInterval(() => setGreeting(getGreeting()), 60000);
        return () => clearInterval(interval);
    }, []);

    const openRecentProject = async (projectPath: string) => {
        try {
            setWorking('Opening project...');

            const project = await api.openProject(projectPath);

            dispatch({
                type: 'SET_PROJECT',
                payload: { project, path: projectPath },
            });

            // Determine project directory
            let projectDir = projectPath;
            if (projectDir.endsWith('project.json')) {
                projectDir = projectDir.replace(/[\\/]project\.json$/, '');
            }

            // Fetch file tree
            try {
                const files = await api.listProjectFiles(projectDir);
                dispatch({ type: 'SET_FILE_TREE', payload: files });
            } catch (filesError) {
                console.error('Failed to load project files:', filesError);
            }

            setReady();

            // Update recent projects
            const recent = state.recentProjects.filter(p => p.path !== projectPath);
            recent.unshift({
                name: project.display_name || project.name,
                champion: project.champion,
                skin: project.skin_id,
                path: projectPath,
                lastOpened: new Date().toISOString(),
            });
            dispatch({ type: 'SET_RECENT_PROJECTS', payload: recent.slice(0, 10) });

        } catch (error) {
            console.error('Failed to open project:', error);
            const flintError = error as api.FlintError;
            setError(flintError.getUserMessage?.() || 'Failed to open project');
        }
    };

    const handleOpenProject = () => {
        openModal('projectList');
    };

    /** Remove a recent project from the list */
    const handleRemoveRecent = (e: React.MouseEvent, projectPath: string) => {
        e.stopPropagation();
        const filtered = state.recentProjects.filter(p => p.path !== projectPath);
        dispatch({ type: 'SET_RECENT_PROJECTS', payload: filtered });
    };

    /** Open the WAD Explorer workspace */
    const handleOpenWadExplorer = () => {
        dispatch({ type: 'OPEN_WAD_EXPLORER' });
    };

    // Get creator name or use default
    const creatorName = state.creatorName || 'Creator';

    return (
        <div className="welcome">
            {/* Header Section with Dynamic Greeting */}
            <div className="welcome__header">
                <h1 className="welcome__greeting">
                    {greeting}, <span className="welcome__creator-name">{creatorName}</span>
                </h1>
                <p className="welcome__subtitle">Create what you imagine</p>
            </div>

            {/* Two Column Layout */}
            <div className="welcome__columns">
                {/* Left Column: Create Workspace */}
                <div className="welcome__column welcome__column--left">
                    <h2 className="welcome__column-title">Folders</h2>
 
                    <div className="welcome__actions">
                        <button className="btn btn--primary btn--large" onClick={handleOpenProject}>
                            <span>Open Folder</span>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                        </button>
 
                        <button className="btn btn--secondary btn--large" onClick={() => openModal('newProject')}>
                            <span>Create Workspace</span>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('plus') }} />
                        </button>
                    </div>
 
                    {/* Recent Projects sub-section — capped to RECENT_DEFAULT_LIMIT
                        unless the user expands. Avoids overwhelming the welcome
                        screen when the list grows. */}
                    {state.recentProjects.length > 0 && (() => {
                        const total = state.recentProjects.length;
                        const limit = showAllRecent ? total : RECENT_DEFAULT_LIMIT;
                        const visible = state.recentProjects.slice(0, limit);
                        const hidden = total - visible.length;
                        return (
                            <div className="welcome__recent">
                                <h3 className="welcome__recent-title">
                                    <ClockIcon />
                                    <span>Recent Folders</span>
                                    <span className="welcome__recent-count">{total}</span>
                                </h3>
                                <div className="welcome__recent-list">
                                    {visible.map((project: RecentProject) => (
                                        <div
                                            key={project.path}
                                            className="welcome__recent-item"
                                            onClick={() => openRecentProject(project.path)}
                                        >
                                            <div className="welcome__recent-info">
                                                <span className="welcome__recent-icon" dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                                                <span className="welcome__recent-name">
                                                    {project.name}
                                                </span>
                                            </div>
                                            <div className="welcome__recent-actions">
                                                <span className="welcome__recent-date">
                                                    {formatRelativeTime(project.lastOpened)}
                                                </span>
                                                <button
                                                    className="welcome__recent-delete"
                                                    onClick={(e) => handleRemoveRecent(e, project.path)}
                                                    title="Remove from recent"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                        <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {(hidden > 0 || showAllRecent) && total > RECENT_DEFAULT_LIMIT && (
                                    <button
                                        type="button"
                                        className="welcome__recent-toggle"
                                        onClick={() => setShowAllRecent((v) => !v)}
                                    >
                                        {showAllRecent
                                            ? `Show fewer`
                                            : `Show all (${hidden} more)`}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ transform: showAllRecent ? 'rotate(180deg)' : 'none', transition: 'transform 220ms ease' }}>
                                            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        );
                    })()}
                </div>
 
                {/* Vertical Divider */}
                <div className="welcome__divider"></div>
 
                {/* Right Column: Explore Files */}
                <div className="welcome__column welcome__column--right">
                    <h2 className="welcome__column-title">Explore Files</h2>
 
                    <div className="welcome__actions">
                        <button className="btn btn--secondary btn--large" onClick={() => openModal('browseWad')}>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                            <span>Browse WAD File</span>
                        </button>
 
                        <button className="btn btn--secondary btn--large" onClick={handleOpenWadExplorer}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                                <path d="M3 9h18M8 5V3m8 2V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                            <span>WAD Explorer</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
