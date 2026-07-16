import React from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './update-showcase.css';

interface GithubRelease {
    tag_name: string;
    body: string | null;
    html_url: string;
    published_at: string | null;
    author: { login: string; html_url: string } | null;
}

interface ShowcaseRelease {
    version: string;
    markdown: string;
    url: string;
    publishedAt: string | null;
    author: { login: string; url: string } | null;
}

const REPOSITORY = 'RitoShark/Flint';
const PENDING_KEY = 'flint_update_showcase_pending';
const SEEN_KEY = 'flint_update_showcase_seen';

async function fetchRelease(version: string, signal: AbortSignal): Promise<ShowcaseRelease> {
    const normalized = version.replace(/^v/i, '');
    const endpoints = [
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${normalized}`,
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/${normalized}`,
        `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
    ];
    for (const endpoint of endpoints) {
        const response = await fetch(endpoint, { signal, headers: { Accept: 'application/vnd.github+json' } });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const release = await response.json() as GithubRelease;
        return {
            version: release.tag_name.replace(/^v/i, '') || normalized,
            markdown: release.body?.trim() || 'This update does not include detailed release notes.',
            url: release.html_url,
            publishedAt: release.published_at,
            author: release.author ? { login: release.author.login, url: release.author.html_url } : null,
        };
    }
    throw new Error(`No GitHub release was found for Flint ${normalized}`);
}

export const UpdateShowcase: React.FC = () => {
    const [currentVersion, setCurrentVersion] = React.useState('');
    const [release, setRelease] = React.useState<ShowcaseRelease | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [visible, setVisible] = React.useState(false);

    React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        void Promise.all([
            getVersion(),
            invoke<string | null>('startup_take_installed_update').catch(() => null),
        ]).then(async ([version, nativePending]) => {
            if (cancelled) return;
            const normalized = version.replace(/^v/i, '');
            setCurrentVersion(normalized);
            let browserPending: string | null = null;
            try { browserPending = localStorage.getItem(PENDING_KEY)?.replace(/^v/i, '') || null; } catch { /* ignore */ }
            const pending = nativePending?.replace(/^v/i, '') || browserPending;
            if (pending !== normalized) return;

            setVisible(true);
            setLoading(true);
            try {
                setRelease(await fetchRelease(normalized, controller.signal));
            } catch (reason) {
                if (!controller.signal.aborted) {
                    console.error('[Updater] Release showcase failed:', reason);
                    setError('Release notes could not be loaded. You can still view this release on GitHub.');
                }
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        });
        return () => { cancelled = true; controller.abort(); };
    }, []);

    const close = React.useCallback(() => {
        try {
            localStorage.setItem(SEEN_KEY, currentVersion);
            localStorage.removeItem(PENDING_KEY);
        } catch { /* ignore */ }
        setVisible(false);
    }, [currentVersion]);

    React.useEffect(() => {
        if (!visible) return;
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [close, visible]);

    if (!visible) return null;
    const releaseUrl = release?.url || `https://github.com/${REPOSITORY}/releases/latest`;

    return (
        <div className="flint-update-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
            <section className="flint-update" role="dialog" aria-modal="true" aria-labelledby="flint-update-title">
                <header className="flint-update__head">
                    <img className="flint-update__logo" src="/flint-logo.svg" alt="Flint" />
                    <div className="flint-update__heading">
                        <h2 id="flint-update-title">Flint {release?.version || currentVersion}</h2>
                        <div className="flint-update__details">
                            {release?.publishedAt && <time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleDateString('en-GB')}</time>}
                            {release?.author && <button type="button" onClick={() => void openUrl(release.author!.url)}>Posted by {release.author.login}</button>}
                        </div>
                    </div>
                    <button type="button" className="flint-update__close" onClick={close} title="Close" aria-label="Close">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </header>
                <div className="flint-update__body">
                    {loading && <div className="flint-update__loading"><span className="flint-update__spinner" />Loading release notes…</div>}
                    {error && <div className="flint-update__error">{error}</div>}
                    {release && (
                        <article className="flint-update__markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                                a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void openUrl(href); }}>{children}</a>,
                            }}>{release.markdown}</ReactMarkdown>
                        </article>
                    )}
                </div>
                <footer className="flint-update__foot">
                    <button type="button" className="flint-update__button" onClick={() => void openUrl(releaseUrl)}>View on GitHub</button>
                    <button type="button" className="flint-update__button flint-update__button--primary" onClick={close}>Continue</button>
                </footer>
            </section>
        </div>
    );
};
