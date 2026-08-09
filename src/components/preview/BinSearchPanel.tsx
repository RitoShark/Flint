import React, { useCallback, useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import * as api from '../../lib/api';
import { Icon } from '../ui';
import {
    compileQuery,
    replaceAll,
    searchText,
    totalHits,
    type SearchGroup,
    type SearchHit,
    type SearchOptions,
} from '../../lib/editor/binSearch';
import { applyContentToEditor } from '../../lib/editor/applyContent';

interface BinSearchPanelProps {
    filePath: string;
    content: string;
    onContentChange: (text: string) => void;
    editorRef: React.RefObject<monacoNs.editor.IStandaloneCodeEditor | null>;
    onOpenLinked: (path: string, line: number) => void;
    onClose: () => void;
}

function fileName(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export const BinSearchPanel: React.FC<BinSearchPanelProps> = ({
    filePath,
    content,
    onContentChange,
    editorRef,
    onOpenLinked,
    onClose,
}) => {
    const [query, setQuery] = useState('');
    const [replacement, setReplacement] = useState('');
    const [options, setOptions] = useState<SearchOptions>({
        caseSensitive: false,
        wholeWord: false,
        regex: false,
    });
    const [groups, setGroups] = useState<SearchGroup[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchedContent, setSearchedContent] = useState<string | null>(null);

    const toggle = (key: keyof SearchOptions) =>
        setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

    const runSearch = useCallback(async () => {
        const pattern = compileQuery(query, options);
        if (!pattern) {
            setError(query ? 'Invalid regular expression' : null);
            setGroups(null);
            return;
        }
        setError(null);
        setSearching(true);
        try {
            const found: SearchGroup[] = [{
                path: filePath,
                label: fileName(filePath),
                editable: true,
                hits: searchText(content, pattern),
            }];

            let linked: api.LinkedBinText[] = [];
            try {
                linked = await api.listLinkedBinTexts(filePath);
            } catch {
                // A BIN with no resolvable links still searches its own text.
            }
            for (const bin of linked) {
                const hits = searchText(bin.text, compileQuery(query, options)!);
                if (hits.length > 0) {
                    found.push({ path: bin.path, label: fileName(bin.path), editable: false, hits });
                }
            }

            setSearchedContent(content);
            setGroups(found);
        } finally {
            setSearching(false);
        }
    }, [query, options, content, filePath]);

    const stale = groups !== null && searchedContent !== content;

    const reveal = (group: SearchGroup, hit: SearchHit) => {
        if (!group.editable) {
            onOpenLinked(group.path, hit.line);
            return;
        }
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(hit.line);
        ed.setSelection({
            startLineNumber: hit.line,
            startColumn: hit.column,
            endLineNumber: hit.line,
            endColumn: hit.column + hit.length,
        });
        ed.focus();
    };

    const handleReplaceAll = () => {
        const pattern = compileQuery(query, options);
        if (!pattern) return;
        const next = replaceAll(content, pattern, replacement);
        if (next === content) return;
        const ed = editorRef.current;
        if (ed) applyContentToEditor(ed, next);
        else onContentChange(next);
        void runSearch();
    };

    const openHits = groups?.[0]?.hits.length ?? 0;

    return (
        <div className="bin-search">
            <div className="bin-search__head">
                <span className="bin-search__title">Search</span>
                <button className="bin-search__close" onClick={onClose} title="Close">
                    <Icon className="bin-tools__glyph" name="close" />
                </button>
            </div>

            <div className="bin-search__body">
                <input
                    className="dl-input"
                    placeholder="Find"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void runSearch(); }}
                />
                <input
                    className="dl-input"
                    placeholder="Replace (open file only)"
                    value={replacement}
                    onChange={e => setReplacement(e.target.value)}
                />

                <div className="bin-search__toggles">
                    <button
                        className={`dl-btn dl-btn--sm${options.caseSensitive ? ' dl-btn--active' : ''}`}
                        onClick={() => toggle('caseSensitive')}
                        title="Match case"
                    >Aa</button>
                    <button
                        className={`dl-btn dl-btn--sm${options.wholeWord ? ' dl-btn--active' : ''}`}
                        onClick={() => toggle('wholeWord')}
                        title="Whole word"
                    >W</button>
                    <button
                        className={`dl-btn dl-btn--sm${options.regex ? ' dl-btn--active' : ''}`}
                        onClick={() => toggle('regex')}
                        title="Regular expression"
                    >.*</button>
                    <button
                        className="dl-btn dl-btn--sm dl-btn--primary"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => void runSearch()}
                        disabled={searching || !query}
                    >
                        {searching ? 'Searching…' : 'Search'}
                    </button>
                </div>

                <button
                    className="dl-btn dl-btn--sm"
                    style={{ width: '100%' }}
                    onClick={handleReplaceAll}
                    disabled={!query || openHits === 0}
                    title="Replaces in the open file only — linked BINs are read-only here"
                >
                    Replace all in this file ({openHits})
                </button>

                {error && <div className="bin-search__error">{error}</div>}
                {stale && <div className="bin-search__stale">Results are out of date — search again.</div>}

                {groups && (
                    <div className="bin-search__results">
                        <div className="bin-tools__hint">
                            {totalHits(groups)} in {groups.length} file{groups.length === 1 ? '' : 's'}
                        </div>
                        {groups.map((group) => (
                            <div className="bin-search__group" key={group.path}>
                                <div className="bin-search__group-head" title={group.path}>
                                    <span className="bin-search__group-name">{group.label}</span>
                                    {!group.editable && <span className="bin-search__ro">read-only</span>}
                                    <span className="bin-search__group-count">{group.hits.length}</span>
                                </div>
                                {group.hits.map((hit, i) => (
                                    <button
                                        className="bin-search__hit"
                                        key={`${hit.line}-${hit.column}-${i}`}
                                        onClick={() => reveal(group, hit)}
                                    >
                                        <span className="bin-search__hit-line">{hit.line}</span>
                                        <span className="bin-search__hit-text">{hit.preview}</span>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
