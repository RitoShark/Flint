import React from 'react';
import { Input } from '../../ui';

export const NameAndPathRow: React.FC<{
    namePlaceholder: string;
    name: string;
    onNameChange: (v: string) => void;
    path: string;
    onPathChange: (v: string) => void;
    onBrowse: () => void;
}> = ({ namePlaceholder, name, onNameChange, path, onPathChange, onBrowse }) => (
    <div className="np-fields-row">
        <div className="np-field np-field--grow">
            <label className="np-label">Project Name</label>
            <Input
                placeholder={namePlaceholder}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
            />
        </div>
        <div className="np-field np-field--grow">
            <label className="np-label">Location</label>
            <Input
                placeholder="Select folder…"
                value={path}
                onChange={(e) => onPathChange(e.target.value)}
                buttonLabel="Browse"
                onButtonClick={onBrowse}
            />
        </div>
    </div>
);
