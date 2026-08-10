import type * as monacoNs from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID } from './ritobinLanguage';
import { resolvePreset } from './ritobinThemes';

export interface ColorSpan {
    text: string;
    color: string;
}

interface ColorRule {
    scope: string;
    color: string;
}

function rulesFor(presetId: string | undefined): ColorRule[] {
    return resolvePreset(presetId)
        .rules.filter((r) => r.foreground)
        .map((r) => ({ scope: r.token, color: `#${r.foreground}` }));
}

/* Monaco's own theme matcher: the rule with the LONGEST scope prefix wins, and
   the `''` rule every preset carries is the fallback. */
function colorFor(rules: ColorRule[], scope: string): string {
    let best: ColorRule | null = null;
    for (const rule of rules) {
        const hit = rule.scope === '' || scope === rule.scope || scope.startsWith(`${rule.scope}.`);
        if (!hit) continue;
        if (!best || rule.scope.length > best.scope.length) best = rule;
    }
    return best?.color ?? 'inherit';
}

/**
 * Colours one line of ritobin exactly as the BIN editor would.
 *
 * Tokenizing through Monaco rather than a local regex pass keeps this honest:
 * the Monarch grammar and the theme presets stay the single source of truth, so
 * a search result can't drift from what the same line looks like in the editor.
 */
export function colorizeRitobinLine(
    monaco: typeof monacoNs,
    line: string,
    presetId: string | undefined,
): ColorSpan[] {
    if (!line) return [];

    const rules = rulesFor(presetId);
    const tokens = monaco.editor.tokenize(line, RITOBIN_LANGUAGE_ID)[0];
    if (!tokens || tokens.length === 0) return [{ text: line, color: colorFor(rules, '') }];

    const spans: ColorSpan[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const start = tokens[i].offset;
        const end = i + 1 < tokens.length ? tokens[i + 1].offset : line.length;
        if (end <= start) continue;
        // Monarch suffixes every token type with the language id.
        const scope = tokens[i].type.replace(new RegExp(`\\.${RITOBIN_LANGUAGE_ID}$`), '');
        spans.push({ text: line.slice(start, end), color: colorFor(rules, scope) });
    }
    return spans;
}
