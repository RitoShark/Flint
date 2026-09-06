const stroke = (d: string) => `<path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="bevel"/>`;
const facet = (d: string) => `<path d="${d}" fill="currentColor" opacity=".2"/>`;
const dot = (x: number, y: number, r = 1.5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor"/>`;
const sheet = stroke('M4 2.5h8l4 4v11H4z M12 2.5v4h4') + facet('M4 2.5h8v4h4v3H4z');
const folder = stroke('M2 5h6l2 2h8v10H2z') + facet('M2 8h16v9H2z');
const openFolder = stroke('M2 15V5h6l2 2h7v3 M2 17l2-7h14l-2 7z') + facet('M4 10h14l-2 7H2z');
const cube = stroke('M10 2l7 4v8l-7 4-7-4V6z M3 6l7 4 7-4 M10 10v8') + facet('M10 10l7-4v8l-7 4z');
const picture = stroke('M2.5 3.5h15v13h-15z M3 14l4-5 4 4 3-3 3 4') + dot(13,7) + facet('M3 14l4-5 4 4 3-3 3 4v2H3z');
const check = stroke('M3 10l4 4L17 4');
const cog = stroke('M7 2h6l1 3 3 1 1 6-3 2-1 4H7l-1-3-4-2V7l3-1z M7 8l3-2 3 2v4l-3 2-3-2z') + facet('M7 8l3-2 3 2v4l-3 2-3-2z');
const lock = stroke('M4 9h12v9H4z M6 9V5l2-2h4l2 2v4') + facet('M4 9h12v9H4z') + stroke('M10 12v3');
const artwork = {
    chevronRight: stroke('M7 4l6 6-6 6'),
    chevronDown: stroke('M4 7l6 6 6-6'),
    chevronUp: stroke('M4 13l6-6 6 6'),
    chevronLeft: stroke('M13 4l-6 6 6 6'),
    folder, folderOpen: openFolder, folderOpen2: openFolder,
    file: sheet,
    javascript: sheet + stroke('M10 10v5H7 M15 10h-3v2h3v3h-3'),
    typescript: sheet + stroke('M6 10h5 M8.5 10v5 M15 10h-3v2h3v3h-3'),
    react: stroke('M10 2l7 4v8l-7 4-7-4V6z M3 6l14 8 M17 6L3 14 M10 2v16') + dot(10,10,2),
    json: sheet + stroke('M8 10H6v2l-1 1 1 1v2h2 M12 10h2v2l1 1-1 1v2h-2'),
    markdown: sheet + stroke('M6 15v-5l3 3 3-3v5 M14 11v4l-2-2 M14 15l2-2'),
    config: cog,
    yaml: sheet + stroke('M6 10l3 3 3-3 M9 13v3 M13 15h2'),
    image: picture, picture,
    texture: stroke('M3 3h14v14H3z M3 10h14 M10 3v14') + facet('M3 3h7v7H3z M10 10h7v7h-7z'),
    bin: stroke('M5 3h10l3 7-3 7H5l-3-7z M6 7h3v6H6z M12 7h2 M13 7v6 M12 13h2') + facet('M5 3h10l3 7h-3l-2-4H7l-2 4H2z'),
    model: cube,
    skeleton: dot(10,4,2) + stroke('M10 6v6 M4 8l6 2 6-2 M10 12l-4 5 M10 12l4 5') + dot(4,8,1) + dot(16,8,1),
    animation: stroke('M3 4h11v11H3z M7 17h10V7') + facet('M7 6l5 3.5L7 13z'),
    wad: stroke('M3 3h14v14H3z M3 7h14 M8 3v4 M12 3v4 M7 11h6') + facet('M3 3h14v4H3z'),
    html: sheet + stroke('M8 10l-3 3 3 3 M12 10l3 3-3 3'),
    css: sheet + stroke('M6 10h8l-1 5-3 1-3-1 M7 12h6'),
    text: sheet + stroke('M6 10h8 M6 13h8 M6 16h5'),
    rust: stroke('M5 3h10l3 7-3 7H5l-3-7z M7 14V6h5l2 2-2 2H7 M11 10l3 4') + facet('M5 3h10l3 7h-3l-2-4H7l-2 4H2z'),
    python: sheet + stroke('M6 12V9h6v3H9v3h6v-3') + dot(8,10,0.6) + dot(13,14,0.6),
    shell: stroke('M2 3h16v14H2z M5 7l3 3-3 3 M10 13h5') + facet('M2 3h16v2H2z'),
    git: stroke('M10 2l8 8-8 8-8-8z M7 5l6 6 M8 6v8') + dot(8,7) + dot(8,14) + dot(13,11),
    video: stroke('M2 4h16v12H2z M5 4v12 M15 4v12 M2 8h3 M15 8h3 M2 12h3 M15 12h3') + facet('M8 7l5 3-5 3z'),
    audio: stroke('M3 8v4 M6 5v10 M10 2v16 M14 5v10 M17 8v4') + facet('M8 4h4v12H8z'),
    lock, lockClosed: lock,
    lockOpen: stroke('M4 9h12v9H4z M8 9V5l2-2h4l2 2') + facet('M4 9h12v9H4z') + stroke('M10 12v3'),
    plus: stroke('M10 3v14 M3 10h14') + facet('M7 7h6v6H7z'),
    minus: stroke('M3 10h14'),
    info: stroke('M6 2h8l4 4v8l-4 4H6l-4-4V6z M10 9v5') + dot(10,6,1),
    user: stroke('M3 18v-4l4-3h6l4 3v4') + facet('M3 18v-4l4-3h6l4 3v4z') + stroke('M7 3h6v5l-3 2-3-2z'),
    link: stroke('M8 6l3-3h4l2 2v4l-3 3 M12 14l-3 3H5l-2-2v-4l3-3 M7 13l6-6'),
    globe: stroke('M6 2h8l4 5v6l-4 5H6l-4-5V7z M6 2l2 8-2 8 M14 2l-2 8 2 8 M2 10h16') + facet('M2 7l4-5 2 8-2 8-4-5z'),
    heart: stroke('M2 5l3-2h3l2 3 2-3h3l3 2v5l-8 8-8-8z') + facet('M2 5l3-2h3l2 3v12l-8-8z'),
    success: stroke('M8 2H5L2 5v10l3 3h10l3-3v-4') + check,
    warning: stroke('M9 2h2l8 15H1z M10 7v5') + dot(10,14,0.8) + facet('M9 2h2l8 15h-4z'),
    error: stroke('M6 2h8l4 4v8l-4 4H6l-4-4V6z M7 7l6 6 M13 7l-6 6'),
    document: sheet,
    settings: cog,
    search: stroke('M6 2h5l3 3v6l-3 3H6l-4-3V5z M13 13l5 5') + facet('M6 2h5l3 3v3H2V5z'),
    package: cube,
    save: stroke('M3 2h11l3 3v13H3z M6 2v5h7V2 M6 18v-7h8v7') + facet('M6 11h8v7H6z') + stroke('M11 3v3'),
    check,
    export: stroke('M11 3h6v6 M17 3l-9 9 M8 4H3v13h13v-5') + facet('M3 11h4v6H3z'),
    import: stroke('M11 3h6v14h-6 M2 10h10 M8 6l4 4-4 4') + facet('M14 3h3v14h-3z'),
    svg: sheet + stroke('M5 14l3-4 4 5 3-5') + dot(8,10,1) + dot(12,15,1),
    xml: sheet + stroke('M7 10l-2 3 2 3 M13 10l2 3-2 3 M11 10l-2 6'),
    tauri: stroke('M3 6l4-4h6l4 4-4 4H7z M3 14l4-4h6l4 4-4 4H7z') + facet('M7 10h6l4 4-4 4H7z'),
    history: stroke('M3 7l3-4h8l4 4v7l-4 4H7l-4-3 M2 2v6h6 M10 6v5l4 2'),
    wrench: stroke('M12 2l-3 3v4L2 16l2 2 7-7h4l3-3V4l-4 4-2-2 4-4z') + facet('M2 16l7-7 2 2-7 7z'),
    refresh: stroke('M3 8V3l3 3 M3 6l4-4h6l4 4 M17 12v5l-3-3 M17 14l-4 4H7l-4-4'),
    trash: stroke('M2 5h16 M7 5V2h6v3 M4 5l1 13h10l1-13 M8 8v7 M12 8v7') + facet('M4 5h12l-1 13H5z'),
    contrast: stroke('M6 2h8l4 4v8l-4 4H6l-4-4V6z') + '<path d="M10 2h4l4 4v8l-4 4h-4z" fill="currentColor"/>',
    download: stroke('M10 2v10 M6 8l4 4 4-4 M3 13v5h14v-5') + facet('M3 15h14v3H3z'),
    copy: stroke('M7 6h10v12H7z M13 6V2H3v12h4') + facet('M7 6h10v3H7z'),
    close: stroke('M4 4l12 12 M16 4L4 16'),
    code: stroke('M6 4l-4 6 4 6 M14 4l4 6-4 6 M12 2L8 18'),
    eye: stroke('M1 10l5-6h8l5 6-5 6H6z') + dot(10,10,3) + facet('M1 10l5-6h8l5 6-5-3H6z'),
    more: dot(4,10) + dot(10,10) + dot(16,10),
    layerText: stroke('M3 4h14 M10 4v13 M6 17h8 M3 4v3 M17 4v3'),
    layerModel: cube,
    'git-compare': stroke('M5 3v11h6 M8 11l3 3-3 3 M15 17V6H9 M12 3L9 6l3 3') + dot(5,3) + dot(15,17),
    'file-edit': sheet + stroke('M8 15l6-6 2 2-6 6H8z'),
    'color-palette': stroke('M7 2h7l4 4v5l-3 2h-4l-1 5H6l-4-4V7z') + dot(7,7) + dot(12,5) + dot(15,9) + dot(5,12),
    'paint-bucket': stroke('M8 2l8 8-7 7-7-7 7-7 M3 10h13 M16 13l3 4-2 2-2-2z') + facet('M3 10h13l-7 7z'),
    'eye-off': stroke('M1 10l5-6h8l5 6-5 6H6z M2 2l16 16') + dot(10,10,2),
    target: stroke('M7 3H3v4 M13 3h4v4 M3 13v4h4 M17 13v4h-4 M10 1v4 M10 15v4 M1 10h4 M15 10h4') + dot(10,10,2),
};

const tones: Partial<Record<keyof typeof artwork, string>> = {
    folder: '#B5A080', folderOpen: '#D3BA8E', file: '#94A3B8',
    javascript: '#E8C46A', typescript: '#79B8E8', react: '#7DD3D8', json: '#D8B679',
    yaml: '#D8B679', markdown: '#A8BCCF', config: '#A8BCCF', text: '#A8BCCF',
    image: '#C69FDB', texture: '#71C2B3', bin: '#E9AD73', model: '#B99ADE',
    skeleton: '#B99ADE', animation: '#D7A3BA', wad: '#B5A080',
    html: '#DE997A', css: '#8DB5E8', rust: '#D6A189', python: '#D8C780',
    shell: '#9BC6A5', git: '#DD987E', video: '#C69FDB', audio: '#91B6CD',
};

export const icons = Object.fromEntries(Object.entries(artwork).map(([name, body]) => [name,
    `<svg class="flint-icon" data-icon="${name}" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"${tones[name as keyof typeof artwork] ? ` style="color:${tones[name as keyof typeof artwork]}"` : ''}>${body}</svg>`,
])) as Record<keyof typeof artwork, string>;

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
    'yaml': 'yaml',
    'yml': 'yaml',
    'env': 'config',

    // Web files
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'css',
    'less': 'css',
    'svg': 'svg',
    'xml': 'xml',

    // Images
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
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

    // Programming
    'py': 'python',
    'pyw': 'python',
    'rs': 'rust',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'shell',
    'bat': 'shell',
    'cmd': 'shell',

    // Media
    'mp4': 'video',
    'webm': 'video',
    'avi': 'video',
    'mov': 'video',
    'mkv': 'video',
    'mp3': 'audio',
    'wav': 'audio',
    'ogg': 'audio',
    'flac': 'audio',

    // Lock files
    'lock': 'lock',

    // Git
    'gitignore': 'git',
    'gitattributes': 'git',

    // Archives
    'zip': 'wad',
    'rar': 'wad',
    '7z': 'wad',
};

// =============================================================================
// Exported Functions
// =============================================================================

export function getFileIcon(name: string, isFolder: boolean, isExpanded = false): string {
    if (isFolder) {
        return isExpanded ? icons.folderOpen : icons.folder;
    }

    if (!name) {
        return icons.file;
    }

    const ext = name.split('.').pop()?.toLowerCase() || '';
    const iconType = extensionMap[ext];
    return iconType ? icons[iconType] : icons.file;
}

export function getExpanderIcon(isExpanded: boolean): string {
    return isExpanded ? icons.chevronDown : icons.chevronRight;
}

export function getIcon(name: keyof typeof icons): string {
    return icons[name] || icons.file;
}

export function getToastIcon(type: 'info' | 'success' | 'warning' | 'error'): string {
    return icons[type] || icons.info;
}
