import { toPosix } from '../pathIdentity';
const APPDATA = '%APPDATA%';
const USERPROFILE = '%USERPROFILE%';

let appDataRoot: string | null = null;
let userProfileRoot: string | null = null;

const normalize = (p: string) => toPosix(p).replace(/\/+$/, '');

/**
 * Derives both roots from the app home (`<userprofile>/AppData/Roaming/Flint`),
 * so no extra Tauri command is needed to read the environment.
 */
export function registerAppHome(appHome: string): void {
    const parts = normalize(appHome).split('/');
    if (parts.length < 4) return;
    appDataRoot = parts.slice(0, -1).join('/');
    userProfileRoot = parts.slice(0, -3).join('/');
}

function collapse(path: string, root: string | null, token: string): string | null {
    if (!root) return null;
    const p = normalize(path);
    const r = normalize(root);
    if (p.toLowerCase() === r.toLowerCase()) return token;
    if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) return token + p.slice(r.length);
    return null;
}

/** Forward slashes, and the user's account name replaced by an env token. */
export function toDisplayPath(path: string): string {
    if (!path) return '';
    return collapse(path, appDataRoot, APPDATA)
        ?? collapse(path, userProfileRoot, USERPROFILE)
        ?? normalize(path);
}

export function fromDisplayPath(display: string): string {
    const d = normalize(display);
    if (appDataRoot && d.toUpperCase().startsWith(APPDATA)) {
        return appDataRoot + d.slice(APPDATA.length);
    }
    if (userProfileRoot && d.toUpperCase().startsWith(USERPROFILE)) {
        return userProfileRoot + d.slice(USERPROFILE.length);
    }
    return d;
}
