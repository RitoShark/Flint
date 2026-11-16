import React, { useMemo, useState } from 'react';
import { Button, Icon } from '../../ui';
import { HitRow } from '../WorkspaceSearch';
import { VirtualizedList } from './VirtualizedList';
import { flattenWadMatches, grepFileKey, groupWadMatches } from './wadGrepTree';
import type { WadGrepFile } from '../../../lib/api/wadGrep';

export const WadGrepResults: React.FC<{
    files: WadGrepFile[];
    theme: string;
    onOpen: (file: WadGrepFile, line: number) => void;
}> = ({ files, theme, onOpen }) => {
    const [openWads, setOpenWads] = useState<Set<string>>(new Set());
    const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
    const groups = useMemo(() => groupWadMatches(files), [files]);
    const rows = useMemo(() => flattenWadMatches(groups, openWads, openFiles), [groups, openWads, openFiles]);
    const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => setter(previous => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    return <div className="wad-grep__results">
        <div className="wad-grep__results-head">
            <span>{groups.length} WAD{groups.length === 1 ? '' : 's'} <span className="wad-grep__muted">/ {files.length} matching files</span></span>
            <Button size="sm" variant="ghost" disabled={!openWads.size} onClick={() => { setOpenWads(new Set()); setOpenFiles(new Set()); }}>Collapse all</Button>
        </div>
        <VirtualizedList totalRows={rows.length} rowHeight={36} overscan={6} renderEpoch={0} renderRow={index => {
            const row = rows[index];
            if (row.kind === 'wad') {
                const { group } = row;
                const expanded = openWads.has(group.path);
                return <button className="wad-grep__tree-row wad-grep__wad" aria-expanded={expanded} title={group.path} onClick={() => toggle(setOpenWads, group.path)}>
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
                    <Icon name={expanded ? 'folderOpen' : 'folder'} />
                    <span className="wad-grep__name">{group.name}</span>
                    <span className="wad-grep__count">{group.files.length} files</span>
                    <span className="wad-grep__count wad-grep__muted">{group.matches} hits</span>
                </button>;
            }
            if (row.kind === 'file') {
                const { file } = row;
                const expanded = openFiles.has(grepFileKey(file));
                return <button className="wad-grep__tree-row wad-grep__file" aria-expanded={expanded} title={file.path} onClick={() => toggle(setOpenFiles, grepFileKey(file))}>
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
                    <Icon name="file" />
                    <span className="wad-grep__name">{file.path}</span>
                    <span className="wad-grep__count">{file.matches.length}{file.extra ? '+' : ''} hits</span>
                </button>;
            }
            return <div className="wad-grep__hit">
                <span className="wad-grep__line">{row.hit.line}</span>
                <HitRow hit={row.hit} presetId={theme} onOpen={() => onOpen(row.file, row.hit.line)} />
            </div>;
        }} />
    </div>;
};
