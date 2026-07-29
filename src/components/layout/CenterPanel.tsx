import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useProjectTabStore, useNavigationStore, useAppMetadataStore, useWadExtractStore, useArchiveTabStore } from '../../lib/stores';
import { WelcomeScreen } from '../browser/WelcomeScreen';
import { PreviewPanel } from '../editor/PreviewPanel';
import { CheckpointTimeline } from '../editor/CheckpointTimeline';
import { WadPreviewPanel } from '../editor/WadPreviewPanel';
import { WadBrowserPanel } from '../browser/WadBrowser';
import { FileEditorPage } from '../editor/FileEditorPage';
import { ArchiveEditor } from '../editor/ArchiveEditor';
import { getIcon, icons } from '../../lib/ui-helpers/fileIcons';

interface QuickActionCardProps {
    icon: keyof typeof icons;
    title: string;
    description: string;
}

const QuickActionCard: React.FC<QuickActionCardProps> = ({ icon, title, description }) => {
    const [isHovered, setIsHovered] = React.useState(false);

    return (
        <div
            className="quick-action-card"
            style={{
                backgroundColor: 'var(--bg-secondary)',
                padding: '20px',
                borderRadius: '8px',
                border: `1px solid ${isHovered ? 'var(--accent-primary)' : 'var(--border)'}`,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div style={{ marginBottom: '12px' }} dangerouslySetInnerHTML={{ __html: getIcon(icon) }} />
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>{title}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{description}</div>
        </div>
    );
};

const ProjectView: React.FC = () => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const activeTab = activeTabId ? openTabs.find(t => t.id === activeTabId) : null;
    const project = activeTab?.project || null;

    return (
        <div className="project-view" style={{ padding: '24px' }}>
            <h2 style={{ marginBottom: '16px' }}>
                {project ? (project.display_name || project.name) : 'Folder'}
            </h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
                Select a file from the tree on the left to preview or edit it.
            </p>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '16px',
                }}
            >
                <QuickActionCard icon="picture" title="Textures" description="View and replace textures" />
                <QuickActionCard icon="bin" title="BIN Files" description="Edit particle and data files" />
                <QuickActionCard icon="file" title="Audio" description="Preview and replace sounds" />
                <QuickActionCard icon="package" title="Export" description="Build your mod package" />
            </div>
        </div>
    );
};

const WadExtractMainView: React.FC = () => {
    const extractSessions = useWadExtractStore((s) => s.extractSessions);
    const activeExtractId = useWadExtractStore((s) => s.activeExtractId);
    const session = extractSessions.find(s => s.id === activeExtractId);

    const [splitPercent, setSplitPercent] = useState(60);
    const containerRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);

    const handleMouseDown = useCallback(() => {
        isDraggingRef.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDraggingRef.current || !containerRef.current) return;
            const containerRect = containerRef.current.getBoundingClientRect();
            const containerWidth = containerRect.width;

            const minBrowserWidth = 200; // minimum pixels for the file list
            const minPreviewWidth = 380; // minimum pixels for the preview (fits buttons)

            const minX = minBrowserWidth;
            const maxX = Math.max(minBrowserWidth, containerWidth - minPreviewWidth);

            const relativeX = e.clientX - containerRect.left;
            const clampedX = Math.min(maxX, Math.max(minX, relativeX));
            const newPercent = (clampedX / containerWidth) * 100;

            setSplitPercent(newPercent);
        };

        const handleMouseUp = () => {
            if (isDraggingRef.current) {
                isDraggingRef.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    if (!session) {
        return <WadPreviewPanel />;
    }

    const hasPreview = !!session.previewHash;

    return (
        <div ref={containerRef} style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
            {/* The standalone viewer owns the whole window, so it navigates one
                folder at a time behind a path bar rather than indenting. The
                archive editor's narrow embedded pane keeps the tree. */}
            <WadBrowserPanel mode="browse" style={{
                width: hasPreview ? `${splitPercent}%` : '100%',
                height: '100%',
                minWidth: hasPreview ? '200px' : 'unset',
                maxWidth: 'none',
                borderRight: 'none'
            }} />
            {hasPreview && (
                <>
                    <div 
                        className="panel-resizer" 
                        onMouseDown={handleMouseDown}
                        style={{ 
                            width: '4px', 
                            cursor: 'col-resize', 
                            flexShrink: 0
                        }} 
                    />
                    <WadPreviewPanel style={{ 
                        width: `${100 - splitPercent}%`, 
                        height: '100%', 
                        minWidth: '380px' 
                    }} />
                </>
            )}
        </div>
    );
};

export const CenterPanel: React.FC = () => {
    const currentView = useNavigationStore((s) => s.currentView);
    const openArchiveTabs = useArchiveTabStore((s) => s.openArchiveTabs);
    const activeArchiveTabId = useArchiveTabStore((s) => s.activeArchiveTabId);
    const activeArchiveTab = activeArchiveTabId
        ? openArchiveTabs.find((t) => t.id === activeArchiveTabId) ?? null
        : null;
    const status = useAppMetadataStore((s) => s.status);
    const statusMessage = useAppMetadataStore((s) => s.statusMessage);

    const renderView = () => {
        switch (currentView) {
            case 'welcome':
                return <WelcomeScreen />;
            case 'preview':
            case 'editor':
                return <PreviewPanel />;
            case 'project':
                return <ProjectView />;
            case 'checkpoints':
                return <CheckpointTimeline />;
            case 'extract':
                return <WadExtractMainView />;
            case 'file-editor':
                return <FileEditorPage />;
            case 'archive-editor':
                return activeArchiveTab
                    ? <ArchiveEditor key={activeArchiveTab.filePath} filePath={activeArchiveTab.filePath} />
                    : <WelcomeScreen />;
            default:
                return <WelcomeScreen />;
        }
    };

    return (
        <main className="center-panel" id="center-panel" style={{ position: 'relative' }}>
            <style>{`
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
            `}</style>
            {renderView()}
            {status === 'working' && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundColor: 'rgba(17, 17, 17, 0.85)',
                    backdropFilter: 'blur(4px)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '16px',
                    zIndex: 100,
                    animation: 'fadeIn 0.2s ease-in-out',
                }}>
                    <div className="spinner" style={{ width: '40px', height: '40px' }} />
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>
                        {statusMessage || 'Working...'}
                    </div>
                </div>
            )}
        </main>
    );
};
