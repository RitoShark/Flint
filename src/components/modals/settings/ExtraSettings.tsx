import React, { useEffect } from 'react';
import { create } from 'zustand';
import { useModalStore } from '../../../lib/stores/modalStore';

export const useExtraSettings = create<{ unlocked: boolean }>(() => ({ unlocked: false }));

export function useExtraSettingsShortcut() {
    useEffect(() => {
        const sequence = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
        let recent: string[] = [];
        let lastKeyAt = 0;
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;
            if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor'))) {
                recent = [];
                return;
            }
            if (event.repeat) return;
            const now = performance.now();
            if (now - lastKeyAt > 4000) recent = [];
            lastKeyAt = now;
            recent = [...recent, event.key.toLowerCase()].slice(-sequence.length);
            if (recent.length !== sequence.length || !sequence.every((key, index) => recent[index] === key)) return;
            recent = [];
            event.preventDefault();
            event.stopPropagation();
            useExtraSettings.setState({ unlocked: true });
            const modal = useModalStore.getState();
            if (modal.activeModal === 'settings') {
                useModalStore.setState({ modalOptions: { ...modal.modalOptions, initialTab: 'extra' } });
            } else if (modal.activeModal === null) {
                modal.openModal('settings', { initialTab: 'extra' });
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
}

export const ExtraSettings: React.FC = () => (
    <div className="settings-panel" style={{ display: 'grid', gap: 20, alignContent: 'start' }}>
        <h3>The Department of Unnecessary Wizardry</h3>
        <p>Gandalf arrived at the council carrying a rice cooker and a parking ticket from a city that had not been invented yet. He placed both on the table. The rice cooker was elected treasurer. The ticket demanded trial by karaoke.</p>
        <p>Beyond the mountains, a goose in a velvet tracksuit had acquired every roundabout in Middle-earth. Travelers could enter, but leaving required a convincing impression of a microwave. Gandalf tried three times. On the fourth attempt, his staff connected to a printer and produced seventeen copies of a lasagna.</p>
        <p>A suspiciously qualified potato offered him a side quest: return the moon to customer service. It had arrived without batteries. They crossed a desert made entirely of keyboard crumbs, passed a dragon doing its taxes in a paddling pool, and reached a door marked STAFF ONLY. Naturally, Gandalf handed it his staff.</p>
        <p>The door apologized, promoted him to regional wizard, and issued him a tiny forklift. He drove it directly into the prophecy. Every bell in the kingdom rang once. The goose removed its sunglasses. The rice cooker finally spoke.</p>
        <p>tung tung tung sahur</p>
    </div>
);
