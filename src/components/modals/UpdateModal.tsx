/**
 * Flint - Update Available Modal
 *
 * Polished version that matches the rest of the modal stack: scoped
 * `.modal--update` modifier, icon tile in the header, version-comparison
 * card with arrow + accent-tinted "Latest" pill, release-notes scroll panel,
 * progress bar inline. Install runs silently via NSIS `/S` (configured in
 * tauri.conf.json `plugins.updater.windows.installMode: "quiet"`).
 */

import React, { useState } from 'react';
import { useAppState } from '../../lib/stores';
import * as updater from '../../lib/updater';
import type { UpdateInfo } from '../../lib/types';
import {
    Button,
    Icon,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ProgressBar,
} from '../ui';

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minimal GitHub-flavored markdown → HTML renderer for release notes.
// Handles headings, bold/italic, inline code, links, and simple bullet lists.
const renderReleaseNotes = (md: string): string => {
    const lines = escapeHtml(md).replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let inList = false;

    const inline = (s: string): string =>
        s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
            .replace(
                /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
                '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
            );

    const closeList = () => {
        if (inList) {
            out.push('</ul>');
            inList = false;
        }
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);

        if (heading) {
            closeList();
            const level = Math.min(6, heading[1].length + 2);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (bullet) {
            if (!inList) {
                out.push('<ul>');
                inList = true;
            }
            out.push(`<li>${inline(bullet[1])}</li>`);
        } else if (line.trim() === '') {
            closeList();
        } else {
            closeList();
            out.push(`<p>${inline(line)}</p>`);
        }
    }
    closeList();
    return out.join('');
};

export const UpdateModal: React.FC = () => {
    const { state, dispatch, closeModal, showToast } = useAppState();
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    const isVisible = state.activeModal === 'updateAvailable';
    const updateInfo = state.modalOptions as UpdateInfo | null;

    const handleUpdateNow = async () => {
        setIsDownloading(true);
        setDownloadProgress(0);

        try {
            await updater.downloadAndInstallUpdate((downloaded, total) => {
                if (total > 0) {
                    setDownloadProgress(Math.round((downloaded / total) * 100));
                }
            });
            // The app relaunches automatically after a successful silent install.
        } catch (err) {
            setIsDownloading(false);
            setDownloadProgress(0);
            const message = err instanceof Error ? err.message : 'Download failed';
            showToast('error', `Update failed: ${message}`);
        }
    };

    const handleSkip = () => {
        if (updateInfo?.latest_version) {
            dispatch({
                type: 'SET_STATE',
                payload: { skippedUpdateVersion: updateInfo.latest_version },
            });
        }
        closeModal();
    };

    const handleRemindLater = () => {
        if (isDownloading) return;
        closeModal();
    };

    if (!updateInfo) return null;

    const publishedDate = updateInfo.published_at
        ? new Date(updateInfo.published_at).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
          })
        : '';

    return (
        <Modal
            open={isVisible}
            onClose={handleRemindLater}
            modifier="modal--update"
            closeOnOverlay={!isDownloading}
            closeOnEscape={!isDownloading}
        >
            <style>{`
                .modal--update { max-width: 580px !important; width: 90vw !important; border-radius: 16px !important; overflow: hidden !important; }
                .modal--update .um-title { display: inline-flex; align-items: center; gap: 12px; }
                .modal--update .um-title__icon {
                    width: 36px; height: 36px;
                    display: grid; place-items: center;
                    background: linear-gradient(135deg,
                        color-mix(in oklab, var(--accent-primary) 22%, var(--bg-tertiary)),
                        var(--bg-tertiary));
                    border: 1px solid color-mix(in oklab, var(--accent-primary) 35%, var(--border));
                    border-radius: 10px;
                    color: var(--accent-primary);
                    box-shadow: 0 0 12px color-mix(in oklab, var(--accent-primary) 25%, transparent);
                    flex: none;
                }
                .modal--update .um-title__icon svg { width: 18px; height: 18px; display: block; }
                .modal--update .um-title__text { display: flex; flex-direction: column; gap: 2px; }
                .modal--update .um-title__name {
                    font-size: 14px; font-weight: 600; color: var(--text-primary); line-height: 1.2;
                }
                .modal--update .um-title__sub {
                    font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); line-height: 1.3;
                }

                .modal--update .um-body { display: flex; flex-direction: column; gap: 16px; }

                .modal--update .um-versions {
                    display: grid;
                    grid-template-columns: 1fr auto 1fr;
                    align-items: center;
                    gap: 12px;
                    padding: 18px 20px;
                    background:
                        radial-gradient(circle at top right,
                            color-mix(in oklab, var(--accent-primary) 6%, transparent) 0%,
                            transparent 50%),
                        var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                }
                .modal--update .um-vp { display: flex; flex-direction: column; align-items: center; gap: 4px; }
                .modal--update .um-vp__label {
                    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
                    color: var(--text-muted);
                }
                .modal--update .um-vp__value {
                    font-size: 20px; font-weight: 700; font-family: var(--font-mono);
                    color: var(--text-secondary); letter-spacing: -0.01em;
                }
                .modal--update .um-vp--latest .um-vp__value { color: var(--accent-primary); }
                .modal--update .um-vp__badge {
                    display: inline-flex; align-items: center; padding: 1px 7px; height: 16px;
                    font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
                    background: color-mix(in oklab, var(--accent-primary) 18%, transparent);
                    border: 1px solid color-mix(in oklab, var(--accent-primary) 35%, transparent);
                    color: var(--accent-primary);
                    border-radius: 4px; margin-top: 2px;
                }

                .modal--update .um-arrow {
                    display: grid; place-items: center;
                    width: 32px; height: 32px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: 50%;
                    color: var(--accent-primary);
                }
                .modal--update .um-arrow svg { width: 14px; height: 14px; display: block; }

                .modal--update .um-meta {
                    display: inline-flex; align-items: center; gap: 6px;
                    font-size: 12px; color: var(--text-muted);
                }
                .modal--update .um-meta svg { width: 12px; height: 12px; }

                .modal--update .um-notes {
                    display: flex; flex-direction: column; gap: 8px;
                }
                .modal--update .um-notes__label {
                    font-size: 11px; font-weight: 600; color: var(--text-muted);
                    text-transform: uppercase; letter-spacing: 0.08em;
                }
                .modal--update .um-notes__panel {
                    max-height: 220px;
                    overflow-y: auto;
                    padding: 14px 16px;
                    background: var(--bg-primary);
                    border: 1px solid var(--border);
                    border-radius: 10px;
                    font-size: 13px;
                    line-height: 1.6;
                    color: var(--text-secondary);
                }
                .modal--update .um-notes__panel h3,
                .modal--update .um-notes__panel h4,
                .modal--update .um-notes__panel h5,
                .modal--update .um-notes__panel h6 {
                    margin: 12px 0 6px;
                    font-size: 13px; font-weight: 600;
                    color: var(--text-primary);
                }
                .modal--update .um-notes__panel h3:first-child,
                .modal--update .um-notes__panel h4:first-child {
                    margin-top: 0;
                }
                .modal--update .um-notes__panel p { margin: 0 0 8px; }
                .modal--update .um-notes__panel ul { margin: 4px 0 8px; padding-left: 20px; }
                .modal--update .um-notes__panel li { margin: 2px 0; }
                .modal--update .um-notes__panel strong { color: var(--text-primary); }
                .modal--update .um-notes__panel code {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    padding: 1px 6px;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: color-mix(in oklab, var(--accent-primary) 30%, var(--text-primary));
                }
                .modal--update .um-notes__panel a { color: var(--accent-primary); text-decoration: none; }
                .modal--update .um-notes__panel a:hover { text-decoration: underline; }

                .modal--update .um-progress {
                    display: flex; flex-direction: column; gap: 6px;
                    padding: 14px 16px;
                    background: color-mix(in oklab, var(--accent-primary) 8%, var(--bg-tertiary));
                    border: 1px solid color-mix(in oklab, var(--accent-primary) 30%, var(--border));
                    border-radius: 12px;
                }
                .modal--update .um-progress__row {
                    display: flex; justify-content: space-between; align-items: center;
                    font-size: 12px;
                }
                .modal--update .um-progress__label { color: var(--text-secondary); font-weight: 500; }
                .modal--update .um-progress__pct {
                    color: var(--accent-primary); font-weight: 700; font-family: var(--font-mono);
                }

                .modal--update .um-silent-hint {
                    display: inline-flex; align-items: center; gap: 6px;
                    font-size: 11px; color: var(--text-muted);
                }
                .modal--update .um-silent-hint svg { width: 12px; height: 12px; }
            `}</style>

            <ModalHeader
                title={
                    <span className="um-title">
                        <span className="um-title__icon"><Icon name="download" /></span>
                        <span className="um-title__text">
                            <span className="um-title__name">Update Available</span>
                            <span className="um-title__sub">
                                {isDownloading
                                    ? `Downloading… ${downloadProgress}%`
                                    : `v${updateInfo.current_version} → v${updateInfo.latest_version}`}
                            </span>
                        </span>
                    </span>
                }
                onClose={!isDownloading ? handleRemindLater : undefined}
            />

            <ModalBody className="um-body">
                <div className="um-versions">
                    <div className="um-vp um-vp--current">
                        <span className="um-vp__label">Current</span>
                        <span className="um-vp__value">v{updateInfo.current_version}</span>
                    </div>
                    <div className="um-arrow" aria-hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                    </div>
                    <div className="um-vp um-vp--latest">
                        <span className="um-vp__label">Latest</span>
                        <span className="um-vp__value">v{updateInfo.latest_version}</span>
                        <span className="um-vp__badge">New</span>
                    </div>
                </div>

                {publishedDate && (
                    <span className="um-meta">
                        <Icon name="info" />
                        Released {publishedDate}
                    </span>
                )}

                {updateInfo.release_notes && (
                    <div className="um-notes">
                        <span className="um-notes__label">What's new</span>
                        <div
                            className="um-notes__panel"
                            dangerouslySetInnerHTML={{ __html: renderReleaseNotes(updateInfo.release_notes) }}
                        />
                    </div>
                )}

                {isDownloading && (
                    <div className="um-progress">
                        <div className="um-progress__row">
                            <span className="um-progress__label">Downloading update</span>
                            <span className="um-progress__pct">{downloadProgress}%</span>
                        </div>
                        <ProgressBar value={downloadProgress} />
                    </div>
                )}

                <span className="um-silent-hint">
                    <Icon name="info" />
                    Install runs silently — Flint will relaunch automatically when finished.
                </span>
            </ModalBody>

            <ModalFooter>
                <Button variant="ghost" onClick={handleSkip} disabled={isDownloading}>
                    Skip This Version
                </Button>
                <Button variant="secondary" onClick={handleRemindLater} disabled={isDownloading}>
                    Remind Me Later
                </Button>
                <Button variant="primary" icon="download" onClick={handleUpdateNow} disabled={isDownloading}>
                    {isDownloading ? `Updating… ${downloadProgress}%` : 'Update Now'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
