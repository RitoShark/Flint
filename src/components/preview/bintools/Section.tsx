import React from 'react';
import { Icon } from '../../ui';

interface SectionProps {
    title: string;
    badge?: string;
    collapsed: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

export const Section: React.FC<SectionProps> = ({ title, badge, collapsed, onToggle, children }) => (
    <div className="bin-tools__section">
        <div className="bin-tools__section-head" onClick={onToggle}>
            <Icon
                className="bin-tools__chevron"
                name={collapsed ? 'chevronRight' : 'chevronDown'}
            />
            <span>{title}</span>
            {badge && <span className="bin-tools__badge">{badge}</span>}
        </div>
        {!collapsed && children}
    </div>
);
