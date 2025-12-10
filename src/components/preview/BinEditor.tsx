/**
 * Flint - BIN Editor Component
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../../lib/state';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/fileIcons';

interface BinEditorProps {
    filePath: string;
}

export const BinEditor: React.FC<BinEditorProps> = ({ filePath }) => {
    const { showToast, setWorking, setReady } = useAppState();
    const [content, setContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const [lineCount, setLineCount] = useState(0);

    useEffect(() => {
        const loadBin = async () => {
            setLoading(true);
            setError(null);

            try {
                const text = await api.readOrConvertBin(filePath);
                setContent(text);
                setLineCount(text.split('\n').length);
                setIsDirty(false);
            } catch (err) {
                console.error('[BinEditor] Error:', err);
                setError((err as Error).message || 'Failed to load BIN file');
            } finally {
                setLoading(false);
            }
        };

        loadBin();
    }, [filePath]);

    const handleSave = useCallback(async () => {
        try {
            setWorking('Saving BIN file...');
            await api.saveRitobinToBin(filePath, content);
            setIsDirty(false);
            setReady('Saved');
            showToast('success', 'BIN file saved successfully');
        } catch (err) {
            console.error('[BinEditor] Save error:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Failed to save');
        }
    }, [filePath, content, setWorking, setReady, showToast]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setContent(e.target.value);
        setIsDirty(true);
        setLineCount(e.target.value.split('\n').length);
    }, []);

    const fileName = filePath.split('\\').pop() || filePath.split('/').pop() || 'file.bin';

    if (loading) {
        return (
            <div className="bin-editor__loading">
                <div className="spinner spinner--lg" />
                <span>Loading BIN file...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bin-editor__error">
                <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                <span>{error}</span>
            </div>
        );
    }

    return (
        <div className="bin-editor">
            <div className="bin-editor__toolbar">
                <span className="bin-editor__filename">
                    {fileName}{isDirty ? ' •' : ''}
                </span>
                <div className="bin-editor__toolbar-actions">
                    <button
                        className="btn btn--primary btn--sm"
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        Save
                    </button>
                </div>
            </div>
            <div className="bin-editor__content">
                <div className="bin-editor__wrapper">
                    <div className="bin-editor__line-numbers">
                        {Array.from({ length: lineCount }, (_, i) => (
                            <div key={i} className="bin-editor__line-num">{i + 1}</div>
                        ))}
                    </div>
                    <textarea
                        className="bin-editor__code"
                        value={content}
                        onChange={handleChange}
                        spellCheck={false}
                    />
                </div>
            </div>
        </div>
    );
};
