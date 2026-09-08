import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const SHOW_DELAY_MS = 500;
const HIDE_DELAY_MS = 60;
const VIEWPORT_PAD = 8;
const GAP = 8;

interface TipState {
    text: string;
    rect: DOMRect;
    placement: 'top' | 'bottom';
}

function findTooltipHost(start: EventTarget | null): HTMLElement | null {
    let el = start as HTMLElement | null;
    while (el && el !== document.body) {
        if (el.hasAttribute && el.hasAttribute('data-tooltip-skip')) return null;
        if (el.hasAttribute && (el.hasAttribute('data-tooltip') || el.hasAttribute('title'))) return el;
        el = el.parentElement;
    }
    return null;
}

function readTooltipText(el: HTMLElement): string | null {
    let text = el.getAttribute('data-tooltip');
    if (text == null) {
        const t = el.getAttribute('title');
        if (t == null) return null;
        text = t;
        el.setAttribute('data-tooltip', t);
        el.removeAttribute('title');
    }
    return text && text.trim() ? text : null;
}

export const TooltipProvider: React.FC = () => {
    const [tip, setTip] = useState<TipState | null>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeEl = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const clearShow = () => { if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; } };
        const clearHide = () => { if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; } };

        const onMouseOver = (e: MouseEvent) => {
            const host = findTooltipHost(e.target);
            if (!host) return;
            const text = readTooltipText(host);
            if (!text) return;
            if (activeEl.current === host) { clearHide(); return; }
            activeEl.current = host;
            clearShow();
            clearHide();
            showTimerRef.current = setTimeout(() => {
                if (activeEl.current !== host || !document.contains(host)) return;
                const rect = host.getBoundingClientRect();
                const placement = rect.top - GAP - 28 >= VIEWPORT_PAD ? 'top' : 'bottom';
                setTip({ text, rect, placement });
            }, SHOW_DELAY_MS);
        };

        const onMouseOut = (e: MouseEvent) => {
            const current = activeEl.current;
            if (!current) return;
            const related = e.relatedTarget as Node | null;
            if (related && current.contains(related)) return;
            clearShow();
            activeEl.current = null;
            hideTimerRef.current = setTimeout(() => setTip(null), HIDE_DELAY_MS);
        };

        const onScroll = () => { clearShow(); setTip(null); activeEl.current = null; };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearShow(); setTip(null); activeEl.current = null; } };

        document.addEventListener('mouseover', onMouseOver, true);
        document.addEventListener('mouseout', onMouseOut, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mouseover', onMouseOver, true);
            document.removeEventListener('mouseout', onMouseOut, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('keydown', onKeyDown);
            clearShow();
            clearHide();
        };
    }, []);

    useLayoutEffect(() => {
        if (!tip) { setPos(null); return; }
        const el = tipRef.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        const maxLeft = Math.max(VIEWPORT_PAD, window.innerWidth - VIEWPORT_PAD - width);
        const maxTop = Math.max(VIEWPORT_PAD, window.innerHeight - VIEWPORT_PAD - height);
        const centerX = tip.rect.left + tip.rect.width / 2;
        const rawTop = tip.placement === 'top' ? tip.rect.top - GAP - height : tip.rect.bottom + GAP;
        setPos({
            left: Math.min(Math.max(VIEWPORT_PAD, centerX - width / 2), maxLeft),
            top: Math.min(Math.max(VIEWPORT_PAD, rawTop), maxTop),
        });
    }, [tip]);

    if (!tip) return null;

    return (
        <div
            ref={tipRef}
            className={`flint-tooltip flint-tooltip--${tip.placement}`}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            role="tooltip"
        >
            {tip.text}
        </div>
    );
};
