import React from 'react';
import { getIcon, icons } from '../../lib/ui-helpers/fileIcons';

export type IconName = keyof typeof icons;

export interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
    name: IconName;
    size?: number;
}

export const Icon: React.FC<IconProps> = ({ name, size, style, ...rest }) => {
    const inline = size ? { width: size, height: size, display: 'inline-flex', ...style } : style;
    return (
        <span
            {...rest}
            style={inline}
            dangerouslySetInnerHTML={{ __html: getIcon(name) }}
        />
    );
};
