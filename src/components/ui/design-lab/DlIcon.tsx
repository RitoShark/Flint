import React from 'react';
import { getIcon, icons } from '../../../lib/ui-helpers/fileIcons';

export type DlIconName = keyof typeof icons;

export interface DlIconProps extends React.HTMLAttributes<HTMLSpanElement> {
    name: DlIconName;
    size?: number;
}

/**
 * Design-lab inline icon. Renders one of the shared SVG glyphs (see
 * `lib/ui-helpers/fileIcons`) wrapped in the `.dl-icon` shape so it inherits
 * `currentColor` and sizes consistently inside `.dl-btn` / `.dl-dd__item` /
 * `.dl-select-trigger`. Prefer this over raw emoji or ad-hoc text glyphs.
 */
export const DlIcon: React.FC<DlIconProps> = ({ name, size, className = '', style, ...rest }) => {
    const merged: React.CSSProperties | undefined = size
        ? { width: size, height: size, ...style }
        : style;
    return (
        <span
            {...rest}
            className={`dl-icon ${className}`.trim()}
            style={merged}
            dangerouslySetInnerHTML={{ __html: getIcon(name) }}
        />
    );
};
