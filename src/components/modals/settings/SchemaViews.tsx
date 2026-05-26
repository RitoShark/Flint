/**
 * SchemaViews - progress + result panels used by the 'Dev' tab when
 * aggregating BIN schemas. Kept paired since they share the
 * SchemaProgress shape.
 */
import React from 'react';
import * as api from '../../../lib/api';
import { Button, ProgressBar } from '../../ui';

export interface SchemaProgress {
    phase: string;
    current: number;
    total: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
}

export const SchemaProgressView: React.FC<{ progress: SchemaProgress }> = ({ progress }) => {
    const pct = (progress.current / Math.max(progress.total, 1)) * 100;
    return (
        <div className="settings-item">
            <div className="settings-item__label">
                {progress.phase === 'complete'
                    ? 'Complete'
                    : `Scanning WAD ${progress.current} / ${progress.total}`}
            </div>
            <ProgressBar value={pct} hideHeader />
            <div className="settings-item__hint" style={{ marginTop: 4 }}>
                {progress.bins_parsed.toLocaleString()} BINs parsed
                {progress.bins_failed > 0 && ` (${progress.bins_failed} failed)`}
                {' | '}
                {progress.classes_found.toLocaleString()} classes found
            </div>
        </div>
    );
};

export const SchemaResultView: React.FC<{
    classes: number;
    fields: number;
    binsParsed: number;
    binsFailed: number;
    wads: number;
    outputPath: string;
    label?: string;
}> = ({ classes, fields, binsParsed, binsFailed, wads, outputPath, label = 'BIN files' }) => (
    <div className="settings-item">
        <div className="settings-item__label">Result</div>
        <div className="settings-item__hint">
            Found {classes.toLocaleString()} classes with {fields.toLocaleString()} fields across{' '}
            {binsParsed.toLocaleString()} {label}
            {binsFailed > 0 && ` (${binsFailed} failed to parse)`} from {wads.toLocaleString()} WADs
        </div>
        <div className="settings-item__hint" style={{ marginTop: 4 }}>
            Output: {outputPath}
        </div>
        <Button
            variant="ghost"
            size="sm"
            icon="folder"
            style={{ marginTop: 6 }}
            onClick={() => {
                const dir = outputPath.replace(/[\\/][^\\/]+$/, '');
                api.openInExplorer(dir).catch(() => {});
            }}
        >
            Open in Explorer
        </Button>
    </div>
);
