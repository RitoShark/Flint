import { useLayoutEffect, useState } from 'react';
import { motionDuration } from './motion';

export function usePresence(open: boolean, exitMs = 160) {
    const [mounted, setMounted] = useState(open);
    useLayoutEffect(() => {
        if (open) { setMounted(true); return; }
        if (motionDuration(exitMs) === 0) { setMounted(false); return; }
        const timer = setTimeout(() => setMounted(false), motionDuration(exitMs));
        return () => clearTimeout(timer);
    }, [open, exitMs]);
    return { present: open || mounted, exiting: !open && mounted };
}
