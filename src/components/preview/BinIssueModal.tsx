import React, { useRef } from 'react';
import type * as api from '../../lib/api';
import { Button } from '../ui/Button';
import { AssetPaths } from '../ui/AssetPaths';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';

interface Props {
    issue: api.CheckIssue | null;
    /** The retype is already in the buffer, waiting on a save to be re-checked. */
    applied: boolean;
    /** A fix edits the open buffer, so it is only offered against the text the check read. */
    dirty: boolean;
    onGoToLine: (line: number) => void;
    onApplyFix: (fix: api.TypeFix) => void;
    onClose: () => void;
}

const SEVERITY_LABEL: Record<api.CheckIssue['severity'], string> = {
    critical: 'Breaks the client',
    warning: 'Loads, probably not as intended',
};

function lineList(lines: number[]): string {
    return lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.join(', ')}`;
}

export const BinIssueModal: React.FC<Props> = ({ issue, applied, dirty, onGoToLine, onApplyFix, onClose }) => {
    // Hold the last issue so the body does not blank out during the modal's exit motion.
    const shownRef = useRef<api.CheckIssue | null>(null);
    if (issue) shownRef.current = issue;
    const shown = issue ?? shownRef.current;
    const fix = shown?.fix;
    const line = shown?.line;

    return (
        <Modal open={!!issue} onClose={onClose} modifier="modal--bin-issue">
            {shown && (
                <>
                    <ModalHeader title={shown.code === 'bin.missing-ref' ? 'Missing asset references' : shown.message} />
                    <ModalBody>
                        <div className="bin-issue__meta">
                            <span className={`bin-issue__severity bin-issue__severity--${shown.severity}`}>
                                {SEVERITY_LABEL[shown.severity]}
                            </span>
                            <code className="bin-issue__code">{shown.code}</code>
                        </div>

                        {shown.code === 'bin.missing-ref' && (
                            <p className="bin-issue__detail">
                                {shown.paths?.length ? `References ${shown.paths.length} file${shown.paths.length === 1 ? '' : 's'} this folder does not include.` : shown.message}
                            </p>
                        )}
                        {!!shown.paths?.length && (
                            <AssetPaths label="Missing assets" entries={shown.paths.map(path => ({ path }))} />
                        )}
                        {shown.detail && <p className="bin-issue__detail">{shown.detail}</p>}

                        {fix && (
                            <div className="bin-issue__diff">
                                <div className="bin-issue__diff-row bin-issue__diff-row--from">
                                    <span className="bin-issue__diff-mark">now</span>
                                    <code>{`${fix.field}: ${fix.from} =`}</code>
                                </div>
                                <div className="bin-issue__diff-row bin-issue__diff-row--to">
                                    <span className="bin-issue__diff-mark">fix</span>
                                    <code>{`${fix.field}: ${fix.to} =`}</code>
                                </div>
                            </div>
                        )}

                        {fix ? (
                            <p className="bin-issue__where">
                                {lineList(fix.lines)} in {fix.class}. The values stay as they are.
                            </p>
                        ) : (
                            line !== undefined && <p className="bin-issue__where">Line {line}.</p>
                        )}
                    </ModalBody>
                    <ModalFooter split>
                        <span className="bin-issue__note">
                            {applied
                                ? 'Changed in the editor. Save to check it again.'
                                : dirty
                                    ? 'Checked against the saved file. Save to check your edits.'
                                    : ''}
                        </span>
                        <div className="modal__footer-actions">
                            <Button variant="ghost" onClick={onClose}>Close</Button>
                            {line !== undefined && (
                                <Button onClick={() => onGoToLine(line)}>Go to line</Button>
                            )}
                            {fix && !applied && (
                                <Button
                                    variant="primary"
                                    disabled={dirty}
                                    title={dirty ? 'Save first so the fix lands on the checked text' : undefined}
                                    onClick={() => onApplyFix(fix)}
                                >
                                    {fix.lines.length > 1
                                        ? `Change to ${fix.to} on ${fix.lines.length} lines`
                                        : `Change to ${fix.to}`}
                                </Button>
                            )}
                        </div>
                    </ModalFooter>
                </>
            )}
        </Modal>
    );
};
