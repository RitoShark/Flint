import React, { useEffect, useRef, useState } from 'react';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import { Checkbox } from './Checkbox';
import { Dropdown } from './Dropdown';
import { Input, Range, SearchInput, Textarea } from './FormField';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Picker } from './Picker';
import { ProgressBar } from './ProgressBar';
import { ContextMenu } from '../overlays/ContextMenu';
import { ToastContainer } from '../overlays/Toast';
import { useModalStore } from '../../lib/stores/modalStore';
import { useNotificationStore } from '../../lib/stores/notificationStore';
import { useUxStore } from '../../lib/stores/uxStore';
import { icons } from '../../lib/ui-helpers/fileIcons';

const Section: React.FC<{ title: string; description: string; children: React.ReactNode }> = ({ title, description, children }) => (
    <section className="ui-preview__section"><header><h2>{title}</h2><p>{description}</p></header><div className="ui-preview__examples">{children}</div></section>
);

export const DesignLab: React.FC<{ standalone?: boolean }> = ({ standalone = false }) => {
    const [section, setSection] = useState('controls');
    const [dialog, setDialog] = useState<'default' | 'wide' | 'large' | null>(null);
    const modalSize = useRef<'default' | 'wide' | 'large'>('default');
    if (dialog) modalSize.current = dialog;
    const [nested, setNested] = useState(false);
    const [loading, setLoading] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const [checked, setChecked] = useState(true);
    const [progress, setProgress] = useState(64);
    const [format, setFormat] = useState('tex');
    const [query, setQuery] = useState('');
    const [feedback, setFeedback] = useState('Ready to explore.');
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const fpsMode = useUxStore(state => state.fpsMode);
    const setFpsMode = useUxStore(state => state.setFpsMode);
    const buttonGlow = useUxStore(state => state.buttonGlow);
    const setButtonGlow = useUxStore(state => state.setButtonGlow);
    const openContextMenu = useModalStore(state => state.openContextMenu);
    const showToast = useNotificationStore(state => state.showToast);
    useEffect(() => () => clearTimeout(timer.current), []);
    const notify = (message: string) => { setFeedback(message); showToast('success', message, { duration: 2400 }); };
    const runAction = () => {
        setLoading(true);
        timer.current = setTimeout(() => { setLoading(false); notify('Preview action completed.'); }, 900);
    };
    const context = (x: number, y: number) => openContextMenu(x, y, [
        { label: 'Open preview', icon: icons.picture, onClick: () => setDialog('default') },
        { label: 'Copy name', icon: icons.copy, onClick: () => notify('Copy action previewed.') },
        { label: 'Export as', icon: icons.export, submenu: [
            { label: 'Texture', icon: icons.texture, onClick: () => notify('Texture export previewed.') },
            { label: 'Model', icon: icons.model, onClick: () => notify('Model export previewed.') },
        ] },
        { label: 'Unavailable action', disabled: true },
    ]);
    return (
        <main className="ui-preview">
            <div className="ui-preview__shell">
                <header className="ui-preview__header"><div><span className="ui-preview__eyebrow">FLINT / WORKBENCH</span><h1>UI Preview</h1><p>Try the controls, icons, and motion used throughout Flint.</p></div><div className="ui-preview__preferences">
                    <Checkbox toggle label="FPS mode" checked={fpsMode} onChange={event => setFpsMode(event.target.checked)} />
                    <Checkbox toggle label="Button glow" checked={buttonGlow && !fpsMode} disabled={fpsMode} onChange={event => setButtonGlow(event.target.checked)} />
                    <small>These use your app settings.</small>
                </div></header>
                <nav className="ui-preview__nav" aria-label="Preview sections">{[['controls', 'Controls'], ['motion', 'Popups & motion'], ['icons', 'Icons']].map(([id, label]) => <Button key={id} variant="ghost" active={section === id} onClick={() => setSection(id)}>{label}</Button>)}</nav>
                <div key={section} className="ui-preview__page">
                    {section === 'controls' && <>
                        <Section title="Buttons" description="Shared variants, real sizes, and interaction states.">
                            <div className="ui-preview__row">{(['primary', 'secondary', 'ghost', 'danger', 'success'] as const).map(variant => <Button key={variant} variant={variant} icon={variant === 'danger' ? 'trash' : 'plus'} onClick={() => setFeedback(`${variant} button clicked.`)}>{variant}</Button>)}</div>
                            <div className="ui-preview__row">{(['sm', 'md', 'lg', 'xl'] as const).map(size => <Button key={size} size={size} icon="folderOpen2">{size.toUpperCase()}</Button>)}<IconButton icon="settings" title="Settings icon" /><Button disabled>Disabled</Button><Button loading={loading} onClick={runAction}>Run preview</Button></div>
                            <div className="ui-preview__cards">{(['texture', 'bin', 'audio', 'model'] as const).map(name => <Button key={name} variant="ghost" layout="stacked" size="lg" icon={name} onClick={() => setFeedback(`${name} selected.`)}>{name}</Button>)}</div>
                        </Section>
                        <Section title="Inputs & choices" description="The same fields, toggles, and pickers used in settings and editors.">
                            <div className="ui-preview__fields"><Input aria-label="Project name" placeholder="Project name" /><SearchInput aria-label="Search files" placeholder="Search files…" /><Input invalid aria-label="Invalid example" value="An example error" readOnly /><Textarea aria-label="Description" placeholder="Describe your project…" /></div>
                            <div className="ui-preview__row"><Checkbox label="Include textures" checked={checked} onChange={event => setChecked(event.target.checked)} /><Checkbox label="Disabled unchecked" disabled /><Checkbox label="Disabled checked" checked disabled /><Checkbox toggle label="Enable preview" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><Picker aria-label="File format" value={format} onChange={setFormat} options={['tex', 'bin', 'skn'].map(value => ({ value, label: value.toUpperCase(), icon: <Icon name={value === 'tex' ? 'texture' : value === 'bin' ? 'bin' : 'model'} /> }))} /></div>
                            <Range aria-label="Preview progress" value={progress} min={0} max={100} onChange={event => setProgress(Number(event.target.value))} /><ProgressBar value={progress} />
                        </Section>
                    </>}
                    {section === 'motion' && <>
                        <Section title="Dialogs" description="Open, close, resize, and stack real dialogs. FPS mode makes them immediate."><div className="ui-preview__row">{(['default', 'wide', 'large'] as const).map(size => <Button key={size} icon="picture" onClick={() => setDialog(size)}>Open {size} modal</Button>)}</div></Section>
                        <Section title="Menus & popups" description="Try context menus, submenus, dropdowns, and selection popups."><div className="ui-preview__row">
                            <Button icon="more" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); context(rect.left, rect.bottom + 8); }}>Open context menu</Button>
                            <Dropdown align="left" trigger={(open, toggle) => <Button aria-expanded={open} onClick={toggle} iconRight="chevronDown">Dropdown</Button>} items={[{ label: 'Open modal', icon: <Icon name="picture" />, onClick: () => setDialog('default') }, { label: 'Show notification', icon: <Icon name="info" />, onClick: () => notify('Dropdown action completed.') }, { label: 'Disabled', disabled: true }]} />
                            <Picker aria-label="Animated picker" value={format} onChange={setFormat} options={['tex', 'bin', 'skn'].map(value => ({ value, label: value.toUpperCase() }))} />
                        </div><div className="ui-preview__context-target" onContextMenu={event => { event.preventDefault(); context(event.clientX, event.clientY); }}><Icon name="folderOpen2" /><span>Right-click here to try the file menu.</span></div></Section>
                        <Section title="Notifications" description="Success, information, warning, and error feedback."><div className="ui-preview__row">{(['success', 'info', 'warning', 'error'] as const).map(type => <Button key={type} icon={type} onClick={() => showToast(type, `${type[0].toUpperCase() + type.slice(1)} notification preview.`, { duration: 3000 })}>{type}</Button>)}</div></Section>
                    </>}
                    {section === 'icons' && <Section title="Icon library" description="Soft, solid shapes with Flint's original file and status colors."><SearchInput aria-label="Find an icon" placeholder="Find an icon…" value={query} onChange={event => setQuery(event.target.value)} /><div className="ui-preview__icons">{(Object.keys(icons) as Array<keyof typeof icons>).filter(name => name.toLowerCase().includes(query.toLowerCase())).map(name => <div className="ui-preview__icon" key={name}><div><Icon name={name} /><Icon name={name} size={24} /></div><span>{name}</span></div>)}</div></Section>}
                </div>
                <p className="ui-preview__feedback" role="status">{feedback}</p>
            </div>
            <Modal open={dialog !== null} size={modalSize.current} onClose={() => setDialog(null)} closeOnEscape={!nested} closeOnOverlay={!nested}>
                <ModalHeader title="A little room to experiment" /><ModalBody><p>This is the shared Flint modal. Try opening another, closing with Escape, or switching FPS mode on the page.</p><div className="ui-preview__row"><Button icon="plus" onClick={() => setNested(true)}>Open nested modal</Button><Input aria-label="Modal input" placeholder="Try typing here…" /></div></ModalBody><ModalFooter><Button variant="ghost" onClick={() => setDialog(null)}>Close</Button><Button variant="primary" onClick={() => { setDialog(null); notify('Changes previewed.'); }}>Save example</Button></ModalFooter>
            </Modal>
            <Modal open={nested} onClose={() => setNested(false)}><ModalHeader title="One more layer" /><ModalBody>This popup uses the same animation and sizing rules.</ModalBody><ModalFooter><Button onClick={() => setNested(false)}>Back</Button></ModalFooter></Modal>
            {standalone && <><ContextMenu /><ToastContainer /></>}
        </main>
    );
};

export default DesignLab;
