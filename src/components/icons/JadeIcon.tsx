interface JadeIconProps {
    size?: number;
    className?: string;
}

export const JadeIcon: React.FC<JadeIconProps> = ({ size = 16, className = '' }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z" />
            <path d="M12 2 2 12l10 10L22 12Z" />
            <path d="m17 12-5-5-5 5 5 5Z" />
        </svg>
    );
};
