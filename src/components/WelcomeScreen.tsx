/**
 * Flint - Welcome Screen Component
 */

import React from 'react';
import { useAppState } from '../lib/state';
import { formatRelativeTime } from '../lib/utils';
import * as api from '../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon } from '../lib/fileIcons';
import type { RecentProject } from '../lib/types';

/**
 * Flint flame logo SVG (larger version for welcome screen)
 */
const FlintLogoLarge: React.FC = () => (
    <svg className="welcome__logo" viewBox="0 0 24 24">
        <path
            d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z"
            fill="currentColor"
        />
        <path
            d="M12 5c-2 3-2.5 5.5-2.5 7 0 2 .8 3.5 2.5 5 1.7-1.5 2.5-3 2.5-5 0-1.5-.5-4-2.5-7z"
            fill="var(--bg-primary)"
        />
        <path
            d="M12 8c-1 1.5-1.5 3-1.5 4 0 1.2.5 2.2 1.5 3 1-.8 1.5-1.8 1.5-3 0-1-.5-2.5-1.5-4z"
            fill="currentColor"
        />
    </svg>
);

export const WelcomeScreen: React.FC = () => {
    const { state, dispatch, openModal, setWorking, setReady, setError } = useAppState();

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

            dispatch({ type: 'SET_STATE', payload: { currentView: 'project' } });
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

    const handleOpenProject = async () => {
        try {
            const selected = await open({
                title: 'Open Flint Project',
                filters: [{ name: 'Flint Project', extensions: ['json'] }],
                multiple: false,
            });

            if (selected) {
                await openRecentProject(selected as string);
            }
        } catch (error) {
            console.error('Failed to open project:', error);
        }
    };

    return (
        <div className="welcome">
            <FlintLogoLarge />
            <h1 className="welcome__title">FLINT</h1>
            <p className="welcome__subtitle">League of Legends Modding IDE</p>

            <div className="welcome__actions">
                <button className="btn btn--primary" onClick={() => openModal('newProject')}>
                    <span dangerouslySetInnerHTML={{ __html: getIcon('plus') }} />
                    <span>Create New Project</span>
                </button>
                <button className="btn btn--secondary" onClick={handleOpenProject}>
                    <span dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                    <span>Open Existing Project</span>
                </button>
            </div>

            {state.recentProjects.length > 0 && (
                <div className="welcome__recent">
                    <h3 className="welcome__recent-title">Recent Projects</h3>
                    {state.recentProjects.slice(0, 5).map((project: RecentProject) => (
                        <div
                            key={project.path}
                            className="welcome__recent-item"
                            onClick={() => openRecentProject(project.path)}
                        >
                            <span className="welcome__recent-icon" dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                            <span className="welcome__recent-name">
                                {project.champion} - {project.name}
                            </span>
                            <span className="welcome__recent-date">
                                {formatRelativeTime(project.lastOpened)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
