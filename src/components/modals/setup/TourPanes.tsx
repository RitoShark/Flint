import React from 'react';
import { Icon, type IconName } from '../../ui';

const Zone: React.FC<{ n: number; className?: string; children: React.ReactNode }> = ({ n, className = '', children }) => (
    <div className={`tour-zone ${className}`}>
        <span className="tour-zone__pin" aria-hidden="true">{n}</span>
        {children}
    </div>
);

const Note: React.FC<{ n?: number; title: string; children: React.ReactNode }> = ({ n, title, children }) => (
    <li className={`tour-note ${n === undefined ? 'tour-note--plain' : ''}`}>
        <span className="tour-note__pin" aria-hidden="true">{n ?? ''}</span>
        <div>
            <strong>{title}</strong>
            <p>{children}</p>
        </div>
    </li>
);

const TourSplit: React.FC<{
    lead?: React.ReactNode;
    mock: React.ReactNode;
    children: React.ReactNode;
}> = ({ lead, mock, children }) => (
    <div className="tour">
        {lead && <p className="tour__lead">{lead}</p>}
        <div className="tour__mock">{mock}</div>
        <ol className="tour__notes">{children}</ol>
    </div>
);

const MockWindow: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="tour-win" aria-hidden="true">
        <div className="tour-win__bar">
            <span className="tour-win__dots"><i /><i /><i /></span>
            <span className="tour-win__title">{title}</span>
        </div>
        <div className="tour-win__body">{children}</div>
    </div>
);

const MockRow: React.FC<{ icon?: IconName; label: string; on?: boolean; dim?: boolean }> = ({ icon, label, on, dim }) => (
    <div className={`tour-mrow ${on ? 'is-on' : ''} ${dim ? 'is-dim' : ''}`}>
        {icon && <span className="tour-mrow__ico"><Icon name={icon} /></span>}
        <span className="tour-mrow__label">{label}</span>
    </div>
);

/* ── 1. Pipeline ───────────────────────────────────────────────────────── */

const STAGES: { icon: IconName; title: string; body: string }[] = [
    {
        icon: 'folder',
        title: 'Your install',
        body: 'The game keeps its assets in .wad.client archives. Flint reads them where they sit.',
    },
    {
        icon: 'download',
        title: 'Extract',
        body: 'Flint pulls out the files for one skin, map or loading screen, and nothing else.',
    },
    {
        icon: 'refresh',
        title: 'Repath',
        body: 'Every asset moves under ASSETS/<your name>/<project>, so two mods can change the same skin without overwriting each other.',
    },
    {
        icon: 'texture',
        title: 'Edit',
        body: 'Textures, models, BINs and audio open inside Flint. Jade and Quartz handle the rest if you have them.',
    },
    {
        icon: 'package',
        title: 'Package',
        body: 'Export a .fantome or .modpkg, or sync straight into your launcher.',
    },
];

export const FlowPane: React.FC = () => (
    <div className="tour-flow">
        <ol className="tour-flow__chain">
            {STAGES.map((s, i) => (
                <li key={s.title} className="tour-flow__stage">
                    <span className="tour-flow__step">{i + 1}</span>
                    <span className="tour-flow__ico"><Icon name={s.icon} /></span>
                    <strong>{s.title}</strong>
                    <p>{s.body}</p>
                </li>
            ))}
        </ol>
        <p className="tour-callout">
            <Icon name="lockOpen" className="tour-callout__ico" />
            <span>
                Flint only reads your League folder. Nothing in this chain writes back into the game,
                so a mod you break can never break your install.
            </span>
        </p>
    </div>
);

/* ── 2. Projects ───────────────────────────────────────────────────────── */

export const ProjectsPane: React.FC = () => (
    <TourSplit
        lead="A project is a folder Flint owns. It holds the extracted assets, your edits, and the info that goes into the finished mod."
        mock={
            <MockWindow title="New Project">
                <div className="tour-np">
                    <Zone n={1} className="tour-np__rail">
                        <span className="tour-lbl">Type</span>
                        <MockRow icon="user" label="Skin" on />
                        <MockRow icon="picture" label="Loading screen" />
                        <MockRow icon="globe" label="Map" />
                        <span className="tour-lbl">Source</span>
                        <MockRow icon="success" label="Live" on />
                        <MockRow icon="target" label="PBE" />
                        <span className="tour-lbl">Extract</span>
                        <MockRow icon="audio" label="SFX" dim />
                        <MockRow icon="audio" label="Voiceover" dim />
                    </Zone>
                    <Zone n={2} className="tour-np__pane">
                        <div className="tour-np__search" />
                        <div className="tour-np__grid">
                            {Array.from({ length: 18 }, (_, i) => (
                                <span key={i} className={`tour-np__tile ${i === 4 ? 'is-on' : ''}`} />
                            ))}
                        </div>
                    </Zone>
                </div>
                <Zone n={3} className="tour-np__foot">
                    <span className="tour-np__field">Ahri Base Rework</span>
                    <span className="tour-np__path">%APPDATA%/Flint/Projects<b>/Ahri Base Rework</b></span>
                    <span className="tour-btn">Create</span>
                </Zone>
            </MockWindow>
        }
    >
        <Note n={1} title="Type, source and extras">
            Skin pulls one champion skin. Map pulls a shipped map. Loading screen builds an animated
            loadscreen. Live or PBE picks which install the files come from. SFX and voiceover are off
            by default because they add hundreds of files you probably will not touch.
        </Note>
        <Note n={2} title="What you are modding">
            Pick a champion, then a skin slot. Slot 0 is the base look and higher numbers are
            alternates, including legendaries and prestige editions.
        </Note>
        <Note n={3} title="Name and location">
            The project name doubles as the repath prefix, so pick it before you start editing. The
            location is where the folder lands, and the default sits in Flint&rsquo;s own app data.
        </Note>
        <Note title="Ctrl+N">
            Opens this window from anywhere, with or without a project already loaded.
        </Note>
    </TourSplit>
);

/* ── 3. Workspace ──────────────────────────────────────────────────────── */

export const WorkspacePane: React.FC = () => (
    <TourSplit
        lead="Open a project and the window splits into four regions. What you click on the left opens in the middle."
        mock={
            <MockWindow title="Flint">
                <Zone n={1} className="tour-ws__bar">
                    <span className="tour-chip"><Icon name="refresh" />Sync</span>
                    <span className="tour-chip"><Icon name="history" />Timeline</span>
                    <span className="tour-chip"><Icon name="export" />Export</span>
                    <span className="tour-ws__bar-gap" />
                    <span className="tour-chip"><Icon name="wrench" /></span>
                    <span className="tour-chip"><Icon name="settings" /></span>
                </Zone>
                <div className="tour-ws__body">
                    <Zone n={2} className="tour-ws__tree">
                        <MockRow icon="folderOpen" label="ASSETS" />
                        <MockRow icon="folder" label="Characters" />
                        <MockRow icon="texture" label="ahri_base_tx.dds" on />
                        <MockRow icon="model" label="ahri.skn" />
                        <MockRow icon="bin" label="skin0.bin" />
                        <MockRow icon="audio" label="ahri_sfx.bnk" />
                    </Zone>
                    <Zone n={3} className="tour-ws__stage">
                        <div className="tour-ws__canvas" />
                    </Zone>
                </div>
                <Zone n={4} className="tour-ws__status">
                    <span>Ahri Base Rework</span>
                    <span>16.17</span>
                </Zone>
            </MockWindow>
        }
    >
        <Note n={1} title="Title bar">
            Sync copies the project into your launcher&rsquo;s mod folder so you can test it in game.
            Timeline is the checkpoint history: snapshot the project, compare snapshots, restore one
            when a change goes wrong. The wrench is Skin Fixer, which scans for the usual breakages
            and patches them.
        </Note>
        <Note n={2} title="File tree">
            Every file the project owns. Icons mark the type, and right-click is where the per-file
            tools live.
        </Note>
        <Note n={3} title="Editor">
            Opens whichever viewer fits the file. Models get a 3D preview with the skeleton and its
            animations, BINs get a property editor, audio banks get a player, textures get a zoomable
            viewer. The texture viewer only shows the file. Recolouring and format conversion are
            right-click actions, and pixel editing happens in your own image editor.
        </Note>
        <Note n={4} title="Status bar">
            The current project, the patch it was built against, and anything running in the
            background.
        </Note>
    </TourSplit>
);

/* ── 4. WAD Explorer ───────────────────────────────────────────────────── */

type WadNode = { depth: number; label: string; icon: IconName; state?: 'open' | 'shut'; on?: boolean; dim?: boolean };

const WAD_TREE: WadNode[] = [
    { depth: 0, label: 'Ahri.wad.client', icon: 'wad', state: 'open' },
    { depth: 1, label: 'assets', icon: 'folderOpen', state: 'open' },
    { depth: 2, label: 'characters/ahri', icon: 'folderOpen', state: 'open' },
    { depth: 3, label: 'skins/skin01', icon: 'folderOpen', state: 'open' },
    { depth: 4, label: 'ahri_base_tx_cm.dds', icon: 'texture', on: true },
    { depth: 4, label: 'ahri_base.skn', icon: 'model' },
    { depth: 4, label: 'ahri_base.skl', icon: 'skeleton' },
    { depth: 3, label: 'particles', icon: 'folder', state: 'shut' },
    { depth: 1, label: 'data', icon: 'folderOpen', state: 'open' },
    { depth: 2, label: 'characters/ahri/skins/skin01.bin', icon: 'bin' },
    { depth: 2, label: '0x7a3f19c4e2b08d51', icon: 'file', dim: true },
    { depth: 0, label: 'Aatrox.wad.client', icon: 'wad', state: 'shut' },
    { depth: 0, label: 'Global.wad.client', icon: 'wad', state: 'shut' },
    { depth: 0, label: 'Map11.wad.client', icon: 'wad', state: 'shut' },
    { depth: 0, label: 'UI.wad.client', icon: 'wad', state: 'shut' },
    { depth: 0, label: 'en_US.wad.client', icon: 'wad', state: 'shut' },
];

export const WadPane: React.FC = () => (
    <TourSplit
        lead={
            <>
                A .wad.client file is Riot&rsquo;s archive format. One file holds thousands of assets, and
                each is stored under a hash of its path instead of its name. Flint resolves those
                hashes against a hash database, so you get readable paths back.
            </>
        }
        mock={
            <MockWindow title="WAD Explorer">
                <Zone n={1} className="tour-wad__search">
                    <Icon name="search" className="tour-wad__ico" />
                    <span>ahri</span>
                </Zone>
                <div className="tour-wad__body">
                    <Zone n={2} className="tour-wad__tree">
                        {WAD_TREE.map((n) => (
                            <div
                                key={n.label + n.depth}
                                className={`tour-mrow tour-wtree__row ${n.on ? 'is-on' : ''} ${n.dim ? 'is-dim' : ''}`}
                                style={{ ['--depth' as never]: n.depth }}
                            >
                                <span className={`tour-wtree__twist ${n.state ? `is-${n.state}` : 'is-leaf'}`} />
                                <span className="tour-mrow__ico"><Icon name={n.icon} /></span>
                                <span className="tour-mrow__label">{n.label}</span>
                            </div>
                        ))}
                    </Zone>
                    <Zone n={3} className="tour-wad__preview">
                        <div className="tour-wad__thumb" />
                        <span className="tour-wad__meta">ahri_base_tx_cm.dds &middot; BC3 &middot; 1024&times;1024</span>
                        <span className="tour-btn">Extract</span>
                    </Zone>
                </div>
            </MockWindow>
        }
    >
        <Note n={1} title="Search">
            Filters every chunk in every archive by path. Type part of a champion name, a folder, or a
            file extension.
        </Note>
        <Note n={2} title="One tree, every archive">
            Each .wad.client in your install is a root. Champions get one each, and there are archives
            for the maps, the UI, the localised text and the shared Global assets. Expand one and its
            contents appear as a normal folder tree.
        </Note>
        <Note n={3} title="Preview, then extract">
            Textures, models, BINs, audio and text render in place. Nothing touches your disk until you
            extract, and you can take one file, a folder, or the whole archive.
        </Note>
        <Note title="Rows that show a bare hash">
            Those are chunks the hash database has no name for. That is normal. They preview and
            extract like anything else, they just land under their hash.
        </Note>
        <Note title="No project required">
            The explorer runs straight off your install, so you can dig through the game without
            creating anything first. Use it to find what a skin actually ships before you mod it.
        </Note>
    </TourSplit>
);

/* ── 5. Context menus ──────────────────────────────────────────────────── */

interface MenuRow {
    label: string;
    icon: IconName;
    sub?: boolean;
    /** Dimmed in the mock: it is not on the menu unless the condition holds. */
    conditional?: boolean;
    when: string;
    note: string;
}

const FOLDER_MENU: MenuRow[] = [
    {
        label: 'Project', icon: 'wrench', sub: true, when: 'project root only',
        note: 'Rename, mod info, thumbnail, Add Layer, and Port to Chromas.',
    },
    {
        label: 'Export', icon: 'export', sub: true, when: 'project root only',
        note: 'Writes a .modpkg or a .fantome.',
    },
    {
        label: 'Add Layer…', icon: 'plus', conditional: true, when: 'on content/ only',
        note: 'Adds another WAD layer to the mod.',
    },
    {
        label: 'Batch Recolor', icon: 'contrast', when: 'any folder',
        note: 'Shifts hue, saturation and brightness across every texture under it.',
    },
    {
        label: 'BIN Tools', icon: 'bin', sub: true, conditional: true, when: 'on the data/ folder',
        note: 'Split BINs by Class, and Organize VFX, which consolidates scattered VFX into one BIN.',
    },
    {
        label: 'Check Files', icon: 'search', conditional: true, when: 'on a .wad.client folder',
        note: 'Audits that WAD tree for dead particle links, missing animations and bad references. It walks the whole tree, so a subfolder will not do.',
    },
    {
        label: 'New Folder', icon: 'folder', when: 'any folder',
        note: 'Creates an empty folder in place.',
    },
    {
        label: 'Copy', icon: 'copy', sub: true, when: 'any folder',
        note: 'Absolute path, relative path, or just the name.',
    },
    {
        label: 'Reveal in Explorer', icon: 'folderOpen', when: 'any folder',
        note: 'Opens the folder in Windows.',
    },
];

const FILE_MENU: { label: string; when: string; note: string }[] = [
    {
        label: 'Edit BIN, View Troybin, Edit LuaBin64', when: 'by extension',
        note: 'Each opens its own editor. Which one appears depends on the file you clicked.',
    },
    {
        label: 'Recolor', when: '.dds and .tex',
        note: 'Not on .png. Shifts the colours of that one texture.',
    },
    {
        label: 'File Transformation', when: 'textures only',
        note: 'Convert to .dds shows on a .tex, Convert to .tex shows on a .dds, Export as .png shows on either.',
    },
    {
        label: 'Create Thumbnail, Cut Textures by UV', when: '.skn only',
        note: 'Both need a mesh, so they never appear on anything else.',
    },
    {
        label: 'Split BIN by Class', when: '.bin, except _concat',
        note: 'A concatenated BIN is already merged, so splitting it is meaningless.',
    },
    {
        label: 'Compare with, Backup, Restore from Original', when: 'only under content/<name>.wad.client/',
        note: 'These need a stock file to diff against, and Flint can only find one for assets that came out of a WAD. Files you added yourself do not get them.',
    },
];

export const MenusPane: React.FC = () => (
    <div className="tour-menus">
        <p className="tour__lead">
            The toolbar only carries what you press constantly. Everything else is on right-click, and
            the menu changes with what you clicked. Dimmed rows below are not always there.
        </p>

        <div className="tour-cm">
            <span className="tour-cm__panel" aria-hidden="true" />
            {FOLDER_MENU.map((m) => (
                <React.Fragment key={m.label}>
                    <div className={`tour-cm__item ${m.conditional ? 'is-conditional' : ''}`}>
                        <span className="tour-cm__ico"><Icon name={m.icon} /></span>
                        <span className="tour-cm__label">{m.label}</span>
                        {m.sub && <Icon name="chevronRight" className="tour-cm__chev" />}
                    </div>
                    <span className="tour-cm__link" aria-hidden="true" />
                    <p className="tour-cm__note">
                        <b>{m.when}</b>
                        {m.note}
                    </p>
                </React.Fragment>
            ))}
        </div>

        <div className="tour-files">
            <p className="tour-files__head">Right-clicking a file instead</p>
            <dl className="tour-files__list">
                {FILE_MENU.map((f) => (
                    <div key={f.label} className="tour-files__row">
                        <dt>
                            {f.label}
                            <span>{f.when}</span>
                        </dt>
                        <dd>{f.note}</dd>
                    </div>
                ))}
            </dl>
        </div>
    </div>
);
