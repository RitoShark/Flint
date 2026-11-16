import React, { useEffect, useMemo, useState } from 'react';
import type * as api from '../../lib/api';
import { issueGuidance, issueRepair } from '../../lib/editor/binIssueActions';
import { Button } from '../ui/Button';
import { AssetPaths } from '../ui/AssetPaths';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';

interface Props {
    open: boolean;
    issues: api.CheckIssue[];
    dirty: boolean;
    busy: boolean;
    result: api.BinRepairResult | null;
    error: string | null;
    onRepair: (kind: api.BinRepairKind) => void;
    onGoToLine: (line: number) => void;
    onSave: () => void;
    onClose: () => void;
}

export const BinIssueModal: React.FC<Props> = ({ open, issues, dirty, busy, result, error, onRepair, onGoToLine, onSave, onClose }) => {
    const [selected, setSelected] = useState(0);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<'all' | 'repair' | 'review'>('all');
    useEffect(() => { setSelected(0); }, [issues, query, filter]);
    const filtered = useMemo(() => issues.filter(issue => {
        const action = issueRepair(issue);
        return (filter === 'all' || (filter === 'repair' ? !!action : !action))
            && `${issue.message} ${issue.code}`.toLowerCase().includes(query.toLowerCase());
    }), [issues, query, filter]);
    const shown = filtered[Math.min(selected, filtered.length - 1)];
    const action = shown && issueRepair(shown);
    const repairable = issues.filter(issue => issueRepair(issue)).length;
    return (
        <Modal open={open} onClose={onClose} size="large" modifier="modal--bin-issues" closeOnOverlay={!busy} closeOnEscape={!busy}>
            <ModalHeader title={`BIN issues (${issues.length})`} />
            <ModalBody>
                <div className="bin-issues__toolbar">
                    <input aria-label="Search issues" placeholder="Search issues..." value={query} onChange={e => setQuery(e.target.value)} />
                    <div className="bin-issues__filters" aria-label="Filter issues">
                        <Button size="sm" variant={filter === 'all' ? 'primary' : 'ghost'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {issues.length}</Button>
                        <Button size="sm" variant={filter === 'repair' ? 'primary' : 'ghost'} aria-pressed={filter === 'repair'} onClick={() => setFilter('repair')}>Repair {repairable}</Button>
                        <Button size="sm" variant={filter === 'review' ? 'primary' : 'ghost'} aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>Review {issues.length - repairable}</Button>
                    </div>
                </div>
                {error && <p className="bin-issues__error" role="alert">{error}</p>}
                {result && (
                    <div className="bin-issues__result" role="status">
                        <strong>{result.report.changed ? `${result.report.changed} repairs applied to the editor` : 'No changes applied'}</strong>
                        <span>Metadata {result.metadata_version}. {result.report.changed > 0 ? 'Save to refresh findings. Undo restores the previous text.' : result.report.blocked.length ? 'See unresolved items below.' : 'No supported repairs were needed.'}</span>
                        {!!result.report.repaired.length && <details><summary>Applied repairs</summary><ul>{result.report.repaired.map(item => <li key={item}>{item}</li>)}</ul></details>}
                        {!!result.report.blocked.length && <details open><summary>{result.report.blocked.length} repairs need attention</summary><ul>{result.report.blocked.map(item => <li key={item}>{item}</li>)}</ul></details>}
                    </div>
                )}
                <div className="bin-issues__layout">
                    <nav className="bin-issues__list" aria-label="Issues">
                        {!filtered.length && <p className="bin-issues__empty">{issues.length ? 'No matching issues.' : 'No issues found in the saved file.'}</p>}
                        {filtered.map((issue, index) => (
                            <Button key={`${issue.code}-${index}`} variant="ghost" className={`bin-issues__item${index === selected ? ' bin-issues__item--selected' : ''}`} aria-pressed={index === selected} onClick={() => setSelected(index)}>
                                <span className={`bin-issues__severity bin-issues__severity--${issue.severity}`}>{issue.severity === 'critical' ? 'Critical' : 'Warning'}</span>
                                <span className="bin-issues__message">{issue.message}</span>
                                <span className="bin-issues__action-label">{issueRepair(issue) ? 'Repair available' : 'Needs review'}</span>
                            </Button>
                        ))}
                    </nav>
                    <section className="bin-issues__detail" aria-label="Issue details">
                        {shown ? <>
                            <code className="bin-issue__code">{shown.code}</code>
                            <h3>{shown.message}</h3>
                            <p>{issueGuidance(shown)}</p>
                            {shown.detail && shown.detail !== issueGuidance(shown) && <details><summary>Technical details</summary><p>{shown.detail}</p></details>}
                            {!!shown.paths?.length && <AssetPaths label="Referenced assets" entries={shown.paths.map(path => ({ path }))} />}
                            {shown.expected && <p className="bin-issues__expected">Expected: <code>{shown.expected}</code></p>}
                            <div className="bin-issues__actions">
                                {action && <Button variant="primary" disabled={busy} onClick={() => onRepair(action.kind)}>{action.label}</Button>}
                                {shown.line !== undefined && <Button variant="ghost" disabled={busy || dirty} title={dirty ? 'Save to refresh line locations' : undefined} onClick={() => onGoToLine(shown.line!)}>Inspect source</Button>}
                            </div>
                        </> : <p className="bin-issues__empty">Select an issue to see repair options.</p>}
                    </section>
                </div>
            </ModalBody>
            <ModalFooter split>
                <span className="bin-issue__note">{busy ? 'Checking metadata and repairing...' : dirty ? 'Findings reflect the saved file. Repairs use your current edits.' : 'Repairs are undoable. Text formatting is normalized.'}</span>
                <div className="modal__footer-actions">
                    <Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
                    <Button disabled={busy || !dirty} onClick={onSave}>Save and recheck</Button>
                    <Button variant="primary" disabled={busy || !repairable} onClick={() => onRepair('all')}>Fix all safe issues</Button>
                </div>
            </ModalFooter>
        </Modal>
    );
};
