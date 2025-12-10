/**
 * Flint - Top Bar Component
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../lib/state';
import { getIcon } from '../lib/fileIcons';

/**
 * Flint flame logo SVG
 */
const FlintLogo: React.FC = () => (
    <svg className="topbar__logo" viewBox="0 0 24 24">
        <path
            d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z"
            fill="currentColor"
        />
        <path
            d="M12 5c-2 3-2.5 5.5-2.5 7 0 2 .8 3.5 2.5 5 1.7-1.5 2.5-3 2.5-5 0-1.5-.5-4-2.5-7z"
            fill="var(--bg-secondary)"
        />
        <path
            d="M12 8c-1 1.5-1.5 3-1.5 4 0 1.2.5 2.2 1.5 3 1-.8 1.5-1.8 1.5-3 0-1-.5-2.5-1.5-4z"
            fill="currentColor"
        />
    </svg>
);

export const TopBar: React.FC = () => {
    const { state, dispatch, openModal } = useAppState();
    const [dropdownOpen, setDropdownOpen] = useState(false);

    const handleCloseProject = useCallback(() => {
        if (!state.currentProject) return;
        dispatch({
            type: 'SET_PROJECT',
            payload: { project: null, path: null },
        });
    }, [state.currentProject, dispatch]);

    const toggleDropdown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setDropdownOpen(prev => !prev);
    }, []);

    const handleExportAs = useCallback((format: 'fantome' | 'modpkg') => {
        setDropdownOpen(false);
        openModal('export', { format });
    }, [openModal]);

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!dropdownOpen) return;

        const handleClickOutside = () => setDropdownOpen(false);
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [dropdownOpen]);

    const projectName = state.currentProject
        ? `${state.currentProject.champion} - ${state.currentProject.display_name || state.currentProject.name}`
        : 'No Project Open';

    return (
        <header className="topbar">
            {/* Brand section */}
            <div
                className="topbar__brand"
                style={{ cursor: 'pointer' }}
                title="Close Project and Return to Home"
                onClick={handleCloseProject}
            >
                <FlintLogo />
                <span className="topbar__title">Flint</span>
            </div>

            {/* Divider */}
            <div className="topbar__divider" />

            {/* Project name */}
            <div className="topbar__project">
                <span className="topbar__project-icon" dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                <span className="topbar__project-name">{projectName}</span>
            </div>

            {/* Spacer */}
            <div className="topbar__spacer" />

            {/* Actions */}
            <div className="topbar__actions">
                {/* Settings button */}
                <button
                    className="btn btn--ghost btn--icon"
                    title="Settings"
                    onClick={() => openModal('settings')}
                    dangerouslySetInnerHTML={{ __html: getIcon('settings') }}
                />

                {/* Export dropdown (only visible when project is open) */}
                {state.currentProject && (
                    <div className={`dropdown ${dropdownOpen ? 'dropdown--open' : ''}`}>
                        <button
                            className="btn btn--primary btn--dropdown"
                            onClick={toggleDropdown}
                        >
                            Export Mod
                        </button>
                        <div className="dropdown__menu">
                            <button
                                className="dropdown__item"
                                onClick={() => handleExportAs('fantome')}
                            >
                                <span dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                                <span>Export as .fantome</span>
                            </button>
                            <button
                                className="dropdown__item"
                                onClick={() => handleExportAs('modpkg')}
                            >
                                <span dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                                <span>Export as .modpkg</span>
                            </button>
                            <div className="dropdown__divider" />
                            <button className="dropdown__item">
                                <span dangerouslySetInnerHTML={{ __html: getIcon('settings') }} />
                                <span>Export Settings...</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </header>
    );
};
