/**
 * Flint - File Icons (VS Code Material Theme Style)
 * SVG icons for file tree and UI components
 */

// =============================================================================
// SVG Icon Definitions
// =============================================================================

export const icons = {
    // -------------------------------------------------------------------------
    // Folder Icons (Material Theme tan/brown)
    // -------------------------------------------------------------------------
    folder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.5 2.5A1.5 1.5 0 0 1 3 1h3.293a1 1 0 0 1 .707.293L8.414 2.7a1 1 0 0 0 .707.3H13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-10Z" fill="#C09553"/>
    </svg>`,

    folderOpen: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.5 2.5A1.5 1.5 0 0 1 3 1h3.293a1 1 0 0 1 .707.293L8.414 2.7a1 1 0 0 0 .707.3H13a1.5 1.5 0 0 1 1.5 1.5V5H3.5a2 2 0 0 0-2 1.5v6a1.5 1.5 0 0 1-1.5-1.5v-8.5Z" fill="#C09553" opacity="0.7"/>
        <path d="M2 7a1 1 0 0 1 1-1h11.5a1 1 0 0 1 .97 1.242l-1.5 6A1 1 0 0 1 13 14H3a1 1 0 0 1-1-1V7Z" fill="#C09553"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // Chevron/Expander Icons
    // -------------------------------------------------------------------------
    chevronRight: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 4l4 4-4 4" stroke="#8B949E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    chevronDown: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 6l4 4 4-4" stroke="#8B949E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // Default File Icon
    // -------------------------------------------------------------------------
    file: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.086a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 14.5v-13Z" fill="#6E7681"/>
        <path d="M9.5 0v3.5a1 1 0 0 0 1 1H14" fill="#4C5159"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // JavaScript / TypeScript Icons
    // -------------------------------------------------------------------------
    javascript: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#F7DF1E"/>
        <path d="M8.8 11.5c0 .9-.5 1.4-1.3 1.4-.7 0-1.1-.4-1.3-.9l1-.6c.1.3.2.5.4.5.2 0 .3-.1.3-.5V7.5h1v4Zm2.5 1.4c-.9 0-1.5-.4-1.8-1l1-.5c.2.4.5.5.8.5.3 0 .5-.1.5-.3 0-.6-2.2-.3-2.2-1.9 0-.8.7-1.3 1.6-1.3.7 0 1.3.3 1.6.9l-.9.5c-.2-.3-.4-.4-.7-.4-.2 0-.4.1-.4.3 0 .5 2.2.2 2.2 1.9 0 .8-.6 1.3-1.7 1.3Z" fill="#000"/>
    </svg>`,

    typescript: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#3178C6"/>
        <path d="M4.5 8h4v1h-1.5v4h-1V9h-1.5V8Zm5 .1c0-.1 0-.1 0 0l1.1-.1c.1.3.2.5.4.6.2.1.5.2.9.2.3 0 .6-.1.7-.2.2-.1.2-.2.2-.4 0-.1 0-.2-.1-.3-.1-.1-.2-.2-.4-.2l-.7-.2c-.6-.1-1-.3-1.3-.6-.3-.3-.4-.6-.4-1 0-.5.2-.9.6-1.2.4-.3.9-.4 1.5-.4.6 0 1.1.1 1.4.4.4.3.6.7.6 1.2h-1.1c0-.2-.1-.4-.3-.5-.1-.1-.4-.2-.7-.2-.3 0-.5.1-.6.2-.2.1-.2.2-.2.4 0 .1 0 .2.1.3.1.1.2.1.4.2l.8.2c.6.1 1 .3 1.2.6.3.3.4.6.4 1 0 .5-.2 1-.6 1.3-.4.3-.9.4-1.6.4-.7 0-1.2-.2-1.6-.5-.3-.3-.5-.7-.5-1.2Z" fill="#FFF"/>
    </svg>`,

    react: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#20232A"/>
        <circle cx="8" cy="8" r="1.5" fill="#61DAFB"/>
        <ellipse cx="8" cy="8" rx="5" ry="2" stroke="#61DAFB" stroke-width="0.8" fill="none"/>
        <ellipse cx="8" cy="8" rx="5" ry="2" stroke="#61DAFB" stroke-width="0.8" fill="none" transform="rotate(60 8 8)"/>
        <ellipse cx="8" cy="8" rx="5" ry="2" stroke="#61DAFB" stroke-width="0.8" fill="none" transform="rotate(120 8 8)"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // Data & Config Files
    // -------------------------------------------------------------------------
    json: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#F9C74F"/>
        <path d="M4.5 5C4.5 4.45 4.95 4 5.5 4H6v1.5c0 .55-.45 1-1 1h-.5V5Zm0 6c0 .55.45 1 1 1H6v-1.5c0-.55-.45-1-1-1h-.5V11Zm7-6c0-.55-.45-1-1-1H10v1.5c0 .55.45 1 1 1h.5V5Zm0 6c0 .55-.45 1-1 1H10v-1.5c0-.55.45-1 1-1h.5V11ZM8 8.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z" fill="#2B2B2B"/>
    </svg>`,

    markdown: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#519ABA"/>
        <path d="M2.5 5.5h1.8l1.2 2 1.2-2h1.8v5h-1.5V7.5l-1.5 2.5-1.5-2.5v3H2.5v-5Zm8.5 0v3.1l1.5-1.5 1 1L11 10.5 8.5 8.1l1-1 1.5 1.5V5.5h-1Z" fill="#FFF"/>
    </svg>`,

    config: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#6D8086"/>
        <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" fill="#FFF"/>
        <circle cx="8" cy="2.5" r="1" fill="#FFF"/>
        <circle cx="8" cy="13.5" r="1" fill="#FFF"/>
        <circle cx="2.5" cy="8" r="1" fill="#FFF"/>
        <circle cx="13.5" cy="8" r="1" fill="#FFF"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // Image Files
    // -------------------------------------------------------------------------
    image: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#42A5F5"/>
        <circle cx="5" cy="5" r="1.5" fill="#FFF" opacity="0.9"/>
        <path d="M2 12l3-4 2.5 3 3-4L15 12v1.5c0 .83-.67 1.5-1.5 1.5h-10c-.83 0-1.5-.67-1.5-1.5V12Z" fill="#FFF" opacity="0.9"/>
    </svg>`,

    texture: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#26A69A"/>
        <rect x="2" y="2" width="5" height="5" fill="#FFF" opacity="0.4"/>
        <rect x="9" y="2" width="5" height="5" fill="#FFF" opacity="0.8"/>
        <rect x="2" y="9" width="5" height="5" fill="#FFF" opacity="0.8"/>
        <rect x="9" y="9" width="5" height="5" fill="#FFF" opacity="0.4"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // League of Legends Specific
    // -------------------------------------------------------------------------
    bin: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#E67E22"/>
        <path d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" fill="#FFF"/>
        <circle cx="8" cy="8" r="1.5" fill="#FFF"/>
        <rect x="7.5" y="2" width="1" height="2" fill="#FFF"/>
        <rect x="7.5" y="12" width="1" height="2" fill="#FFF"/>
        <rect x="2" y="7.5" width="2" height="1" fill="#FFF"/>
        <rect x="12" y="7.5" width="2" height="1" fill="#FFF"/>
    </svg>`,

    model: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#AB47BC"/>
        <path d="M8 2L2 5.5v5L8 14l6-3.5v-5L8 2Zm0 1.5l4 2.2-4 2.3-4-2.3 4-2.2ZM3.5 6.5L7.5 9v3.5L3.5 10V6.5Zm5 6V9l4-2.5V10l-4 2.5Z" fill="#FFF"/>
    </svg>`,

    skeleton: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#78909C"/>
        <circle cx="8" cy="4" r="2" fill="#FFF"/>
        <rect x="7" y="6" width="2" height="5" rx="1" fill="#FFF"/>
        <path d="M5 8h6v1H5V8Zm1 3l-1 3h1.5l.5-2 .5 2H9l.5-2 .5 2H11.5l-1-3H6Z" fill="#FFF"/>
    </svg>`,

    animation: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#EF5350"/>
        <rect x="2" y="2" width="12" height="12" rx="1" stroke="#FFF" stroke-width="1.5" fill="none"/>
        <path d="M6.5 5.5v5l4-2.5-4-2.5Z" fill="#FFF"/>
    </svg>`,

    wad: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#8D6E63"/>
        <path d="M3 4h10v1H3V4Zm0 2.5h10v1H3v-1Zm0 2.5h10v1H3V9Zm0 2.5h10v1H3v-1Z" fill="#FFF" opacity="0.9"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // Document Files
    // -------------------------------------------------------------------------
    text: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#90A4AE"/>
        <path d="M4 4h8v1H4V4Zm0 2h8v1H4V6Zm0 2h6v1H4V8Zm0 2h8v1H4v-1Zm0 2h4v1H4v-1Z" fill="#FFF"/>
    </svg>`,

    html: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#E44D26"/>
        <path d="M4 4l.6 7.2L8 13l3.4-1.8L12 4H4Zm6.5 2.5l-.2 2.5-2.3.8-2.3-.8-.1-1.5h1.2l.1.8 1.1.4 1.1-.4.1-1H6.5l-.1-1h4.1Z" fill="#FFF"/>
    </svg>`,

    css: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#42A5F5"/>
        <path d="M4 4l.6 7.2L8 13l3.4-1.8L12 4H4Zm6.5 2.5l-.1 1H6.7l.1 1h3.5l-.3 3-2 .7-2-.7-.1-1.5h1.2l.1.8 1 .3 1-.3.1-1H6.5l-.3-3.3h4.3Z" fill="#FFF"/>
    </svg>`,

    python: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="16" height="16" rx="2" fill="#3776AB"/>
        <path d="M7.9 2C5.5 2 5.7 3 5.7 3v1.1h2.4v.4H4.8S3 4.3 3 6.9s1.6 2.5 1.6 2.5h.9V8.2s0-1.6 1.6-1.6h2.7s1.5 0 1.5-1.5V3.5S11.5 2 7.9 2Zm-1.4.9a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1Z" fill="#FFE052"/>
        <path d="M8.1 14c2.4 0 2.2-1 2.2-1v-1.1H7.9v-.4h3.3s1.8.2 1.8-2.4-1.6-2.5-1.6-2.5h-.9v1.2s0 1.6-1.6 1.6H6.2s-1.5 0-1.5 1.5v1.6s-.2 1.5 3.4 1.5Zm1.4-.9a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1Z" fill="#FFE052"/>
    </svg>`,

    // -------------------------------------------------------------------------
    // UI Icons (for buttons, toasts, etc.)
    // -------------------------------------------------------------------------
    plus: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    info: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" stroke="#60A5FA" stroke-width="1.5" fill="none"/>
        <path d="M8 7v4M8 5.5v.5" stroke="#60A5FA" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    success: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" stroke="#34D399" stroke-width="1.5" fill="none"/>
        <path d="M5.5 8l2 2 3.5-4" stroke="#34D399" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    warning: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2l6 11H2L8 2Z" stroke="#FBBF24" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
        <path d="M8 6v3M8 11v.5" stroke="#FBBF24" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    error: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" stroke="#F87171" stroke-width="1.5" fill="none"/>
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#F87171" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    document: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.086a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 14.5v-13Z" fill="#90A4AE"/>
        <path d="M9.5 0v3.5a1 1 0 0 0 1 1H14" fill="#6E7681"/>
        <path d="M5 7h6M5 9h6M5 11h4" stroke="#FFF" stroke-width="1" stroke-linecap="round"/>
    </svg>`,

    // Settings/Gear icon
    settings: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.5 1.5A1.5 1.5 0 0 1 8 0a1.5 1.5 0 0 1 1.5 1.5v.3c0 .4.3.8.7.9.4.1.8 0 1.1-.3l.2-.2a1.5 1.5 0 1 1 2.1 2.1l-.2.2c-.3.3-.4.7-.3 1.1.1.4.5.7.9.7h.3a1.5 1.5 0 0 1 0 3h-.3c-.4 0-.8.3-.9.7-.1.4 0 .8.3 1.1l.2.2a1.5 1.5 0 1 1-2.1 2.1l-.2-.2c-.3-.3-.7-.4-1.1-.3-.4.1-.7.5-.7.9v.3a1.5 1.5 0 0 1-3 0v-.3c0-.4-.3-.8-.7-.9-.4-.1-.8 0-1.1.3l-.2.2a1.5 1.5 0 1 1-2.1-2.1l.2-.2c.3-.3.4-.7.3-1.1-.1-.4-.5-.7-.9-.7h-.3a1.5 1.5 0 0 1 0-3h.3c.4 0 .8-.3.9-.7.1-.4 0-.8-.3-1.1l-.2-.2A1.5 1.5 0 1 1 3.7 2.3l.2.2c.3.3.7.4 1.1.3.4-.1.7-.5.7-.9v-.3Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" fill="none"/>
    </svg>`,

    // Search/magnifying glass
    search: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,

    // Package/box icon for exports
    package: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 5l6-3 6 3v6l-6 3-6-3V5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        <path d="M2 5l6 3 6-3M8 8v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,

    // Folder open (alternative style for buttons)
    folderOpen2: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V6H4a2 2 0 0 0-2 1.5V4Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        <path d="M2 8a1 1 0 0 1 1-1h10.5a1 1 0 0 1 1 1l-1 5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1l-1-5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
    </svg>`,

    // Save/floppy disk
    save: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h8l3 3v9a1 1 0 0 1-1 1Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        <path d="M5 2v3h5V2M5 14v-4h6v4" stroke="currentColor" stroke-width="1.2"/>
    </svg>`,

    // Checkmark (standalone)
    check: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 8l4 4 6-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // Image/picture icon
    picture: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
        <circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1"/>
        <path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

    // Export/download arrow
    export: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2v8M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 12v2h12v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
};

// =============================================================================
// Extension to Icon Type Mapping
// =============================================================================

const extensionMap: Record<string, keyof typeof icons> = {
    // JavaScript / TypeScript
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'react',
    'ts': 'typescript',
    'tsx': 'react',

    // Data files
    'json': 'json',
    'md': 'markdown',
    'markdown': 'markdown',

    // Config files
    'ini': 'config',
    'cfg': 'config',
    'config': 'config',
    'toml': 'config',
    'yaml': 'config',
    'yml': 'config',
    'env': 'config',

    // Web files
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'css',
    'less': 'css',

    // Images
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
    'svg': 'image',
    'webp': 'image',
    'bmp': 'image',
    'ico': 'image',

    // Textures (League-specific)
    'dds': 'texture',
    'tex': 'texture',
    'tga': 'texture',

    // League of Legends specific
    'bin': 'bin',
    'skn': 'model',
    'skl': 'skeleton',
    'anm': 'animation',
    'scb': 'model',
    'sco': 'model',
    'wad': 'wad',

    // Text files
    'txt': 'text',
    'log': 'text',

    // Python
    'py': 'python',
    'pyw': 'python',

    // Archives
    'zip': 'wad',
    'rar': 'wad',
    '7z': 'wad',
};

// =============================================================================
// Exported Functions
// =============================================================================

/**
 * Get file icon SVG based on extension
 */
export function getFileIcon(name: string, isFolder: boolean, isExpanded = false): string {
    if (isFolder) {
        return isExpanded ? icons.folderOpen : icons.folder;
    }

    // Defensive check for undefined/null name
    if (!name) {
        return icons.file;
    }

    const ext = name.split('.').pop()?.toLowerCase() || '';
    const iconType = extensionMap[ext];
    return iconType ? icons[iconType] : icons.file;
}

/**
 * Get expander/chevron icon
 */
export function getExpanderIcon(isExpanded: boolean): string {
    return isExpanded ? icons.chevronDown : icons.chevronRight;
}

/**
 * Get specific icon by name
 */
export function getIcon(name: keyof typeof icons): string {
    return icons[name] || icons.file;
}

/**
 * Get toast notification icon
 */
export function getToastIcon(type: 'info' | 'success' | 'warning' | 'error'): string {
    return icons[type] || icons.info;
}
