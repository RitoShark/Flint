const solid = (d: string) => `<path d="${d}" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>`;
const line = (d: string) => `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const disk = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor"/>`;
const block = (x: number, y: number, w: number, h: number, r = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="currentColor"/>`;
const sheet = solid('M5 1h6l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2 M11 2v4h4');
const page = (body: string) => `<g opacity=".22">${sheet}</g>${body}`;
const folder = solid('M3 3h4c1 0 1.5.5 2 1l1 1h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2');
const folderOpen = solid('M3 3h4c1 0 1.5.5 2 1l1 1h6a2 2 0 0 1 2 2H6c-1.4 0-2.2.8-2.6 2L1 15V5a2 2 0 0 1 2-2 M6 9h11c1 0 1.5.7 1.2 1.5l-2 6A2 2 0 0 1 14.3 18H2.5z');
const cube = solid('M9 1.5a2 2 0 0 1 2 0l6 3.4-7 4-7-4z M2 6.5l7 4V19l-6-3.4a2 2 0 0 1-1-1.7z M11 10.5l7-4v7.4a2 2 0 0 1-1 1.7L11 19z');
const picture = solid('M3 2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 M13 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M3 15h14l-4-5-3 3-3-4z');
const cog = solid('M8 1h4l.7 2.3 1.6.9 2.3-.5 2 3.5-1.6 1.8v2l1.6 1.8-2 3.5-2.3-.5-1.6.9L12 19H8l-.7-2.3-1.6-.9-2.3.5-2-3.5L3 11V9L1.4 7.2l2-3.5 2.3.5 1.6-.9z M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7');
const lock = solid('M5 8V6a5 5 0 0 1 10 0v2h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z M7 8h6V6a3 3 0 0 0-6 0z M9 11v4h2v-4z');
const check = line('M4 10l4 4 8-8');
const artwork = {
    chevronRight: line('M7 5l5 5-5 5'), chevronDown: line('M5 7l5 5 5-5'), chevronUp: line('M5 13l5-5 5 5'), chevronLeft: line('M13 5l-5 5 5 5'),
    folder, folderOpen, folderOpen2: folderOpen, file: sheet, document: sheet,
    javascript: page(line('M9 9v6H6 M15 9h-3v3h3v3h-3')),
    typescript: page(line('M5 9h5 M7.5 9v6 M15 9h-3v3h3v3h-3')),
    react: disk(10,10,2.5) + line('M4 4l12 12 M4 16L16 4 M2 10h16'),
    json: page(line('M7 8H5v3l-1 1 1 1v3h2 M13 8h2v3l1 1-1 1v3h-2')),
    markdown: page(line('M5 15V9l3 3 3-3v6 M14 9v6l-2-2 M14 15l2-2')),
    config: cog, yaml: page(line('M6 9l4 4 4-4 M10 13v4')),
    image: picture, picture,
    texture: block(1,1,8,8) + block(11,11,8,8) + '<g opacity=".35">' + block(11,1,8,8) + block(1,11,8,8) + '</g>',
    bin: page(block(6,8,3,3,1) + block(11,8,3,3,1) + block(6,13,3,3,1) + block(11,13,3,3,1)),
    model: cube, layerModel: cube,
    skeleton: disk(10,3,2.5) + line('M10 7v5 M4 8l6 2 6-2 M10 12l-4 5 M10 12l4 5'),
    animation: block(1,3,4,14,1.5) + block(7,6,4,11,1.5) + solid('M14 5a1 1 0 0 1 1.5-.8l4 3a1 1 0 0 1 0 1.6l-4 3A1 1 0 0 1 14 10z'),
    wad: solid('M3 2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 M3 5v2h14V5z M7 10v3h6v-3z'),
    html: page(line('M7 9l-3 3 3 3 M13 9l3 3-3 3')),
    css: page(solid('M5 8h10l-1.5 8-3.5 1-3.5-1-.5-3h2l.3 1.5 1.7.5 1.7-.5.3-2H6l-.3-2H13l.2-1H5z')),
    text: page(line('M6 9h8 M6 12h8 M6 15h5')),
    rust: page(line('M6 16V8h5a3 3 0 0 1 0 6H6 M10 14l4 3')),
    python: page(solid('M6 7h6a2 2 0 0 1 2 2v3H8v2H5a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h1z M9 13h6a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-1h2z')),
    shell: solid('M3 2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 M4 6l4 4-4 4 1.5 1.5L11 10 5.5 4.5z M11 13v2h5v-2z'),
    git: line('M5 4v12 M5 8h6a4 4 0 0 0 4-4') + disk(5,3,2.5) + disk(5,17,2.5) + disk(15,3,2.5),
    video: solid('M3 3h9a2 2 0 0 1 2 2v2l4-2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1l-4-2v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2'),
    audio: block(1,7,3,6,1.5) + block(6,3,3,14,1.5) + block(11,1,3,18,1.5) + block(16,6,3,8,1.5),
    lock, lockClosed: lock,
    lockOpen: solid('M7 8h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h1V6a5 5 0 0 1 9-3l-1.5 1.5A3 3 0 0 0 7 6z M9 11v4h2v-4z'),
    plus: block(8.5,2,3,16,1.5) + block(2,8.5,16,3,1.5), minus: block(2,8.5,16,3,1.5),
    info: solid('M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M9 5v2h2V5z M9 9v6h2V9z'),
    user: disk(10,5,4) + solid('M2 17a8 6 0 0 1 16 0 2 2 0 0 1-2 2H4a2 2 0 0 1-2-2'),
    link: line('M8 6l2-2a4.2 4.2 0 0 1 6 6l-2 2 M6 8l-2 2a4.2 4.2 0 0 0 6 6l2-2 M7 13l6-6'),
    globe: solid('M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 8h4l1-2-2-2-3 2z M9 10l2-2 5 2-2 3-1 4-3-1z'),
    heart: solid('M10 18C7 15 1 11 1 6a4.5 4.5 0 0 1 9-1 4.5 4.5 0 0 1 9 1c0 5-6 9-9 12'),
    success: solid('M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M4 10l4 4 8-8-1.5-1.5L8 11l-2.5-2.5z'),
    warning: solid('M8.2 2a2 2 0 0 1 3.6 0l7 13a2 2 0 0 1-1.8 3H3a2 2 0 0 1-1.8-3z M9 6v6h2V6z M9 14v2h2v-2z'),
    error: solid('M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M6 5L5 6l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z'),
    settings: cog,
    search: solid('M8 1a7 7 0 1 0 4.2 12.6l4.8 4.8a1.4 1.4 0 0 0 2-2l-4.8-4.8A7 7 0 0 0 8 1 M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9'),
    package: cube,
    save: solid('M3 1h11l5 5v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2 M5 2v5h8V2z M5 11v7h10v-7z'),
    check,
    export: solid('M10 1h8a1 1 0 0 1 1 1v8h-3V6L8 14l-2-2 8-8h-4z') + line('M6 4H3v13h13v-3'),
    import: solid('M2 8h7V4l7 6-7 6v-5H2z') + line('M13 2h5v16h-5'),
    svg: page(disk(6,11,2) + disk(14,11,2) + line('M6 11l4-4 4 4 M6 11l4 5 4-5')),
    xml: page(line('M6 9l-2 3 2 3 M14 9l2 3-2 3 M11 8l-2 8')),
    tauri: disk(7,7,5) + '<g opacity=".45">' + disk(13,13,5) + '</g>',
    history: solid('M3 1v7h7L7.3 5.3A6 6 0 1 1 4 12H1.5A8.5 8.5 0 1 0 5.5 3.5z') + line('M10 7v4l3 2'),
    wrench: solid('M13 1a6 6 0 0 0-5.6 8L1.8 15a2.3 2.3 0 0 0 3.2 3.2l6-5.6A6 6 0 0 0 19 7l-4 3-4-4z'),
    refresh: solid('M17 1v7h-7l2.5-2.5A6 6 0 0 0 4 10H1.5a8.5 8.5 0 0 1 12.8-6.3z M3 19v-7h7l-2.5 2.5A6 6 0 0 0 16 10h2.5a8.5 8.5 0 0 1-12.8 6.3z'),
    trash: solid('M7 1h6l1 2h3a1.5 1.5 0 0 1 0 3H3a1.5 1.5 0 0 1 0-3h3z M4 8h12l-1 9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z M7 10v6h2v-6z M11 10v6h2v-6z'),
    contrast: solid('M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M10 3v14a7 7 0 0 0 0-14'),
    download: solid('M8.5 1h3v8H16l-6 6-6-6h4.5z') + line('M2 14v4h16v-4'),
    copy: block(6,6,13,13) + '<g opacity=".4">' + block(1,1,13,13) + '</g>',
    close: line('M5 5l10 10 M15 5L5 15'), code: line('M6 5l-4 5 4 5 M14 5l4 5-4 5 M11 3L9 17'),
    eye: solid('M1 9q9-13 18 0a2 2 0 0 1 0 2Q10 24 1 11a2 2 0 0 1 0-2 M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8') + disk(10,10,2),
    more: disk(3,10,2) + disk(10,10,2) + disk(17,10,2),
    layerText: solid('M2 2h16v4h-2V5h-4v11h3v2H5v-2h3V5H4v1H2z'),
    'git-compare': disk(5,3,2.5) + disk(15,17,2.5) + line('M5 5v9h5 M8 11l3 3-3 3 M15 15V6h-5 M12 3L9 6l3 3'),
    'file-edit': page(solid('M6 14l8-8 3 3-8 8H6z')),
    'color-palette': solid('M10 1a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.5 1.5 1.5 0 0 1 1-2.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8 M6 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3 M11 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3 M15 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3 M4 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3'),
    'paint-bucket': solid('M8 2l9 9-7 7a2 2 0 0 1-3 0l-6-6a2 2 0 0 1 0-3z M4 10h10L8 4z M17 13q5 6 0 6t0-6'),
    'eye-off': line('M2 2l16 16 M1 10q3-5 6-5 M13 5q3 0 6 5-3 5-6 5 M7 15q-3 0-6-5') + disk(10,10,3),
    target: line('M6 2H2v4 M14 2h4v4 M2 14v4h4 M18 14v4h-4') + disk(10,10,4),
};

export const icons = Object.fromEntries(Object.entries(artwork).map(([name, body]) => [name,
    `<svg class="flint-icon" data-icon="${name}" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
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
