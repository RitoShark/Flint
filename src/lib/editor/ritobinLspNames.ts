import type { LspEdit, LspRange } from './ritobinLspProtocol';

export type Completion = {
    label: string; kind?: number; detail?: string; documentation?: string | { value: string };
    insertText?: string; insertTextFormat?: number; textEdit?: LspEdit | { insert: LspRange; replace: LspRange; newText: string };
    additionalTextEdits?: LspEdit[]; sortText?: string; filterText?: string; preselect?: boolean;
    labelDetails?: { detail?: string; description?: string };
};

const hashLabel = /^0x[\da-f]{8}$/i;
const schemaName = (item: Completion) => (item.kind === 7 || item.kind === 10) && hashLabel.test(item.label);

/** Resolve only class/property identifiers through Flint, never unhash document values. */
export async function resolveCompletionNames(
    items: Completion[],
    lookup: (hashes: number[]) => Promise<Record<string, string>>,
): Promise<Completion[]> {
    const hashes = [...new Set(items.filter(schemaName).map(item => Number(item.label)))];
    if (!hashes.length) return items;
    const names = await lookup(hashes);
    return items.map(item => {
        if (!schemaName(item)) return item;
        const name = names[Number(item.label)];
        // The shared BIN dictionary also contains paths. Only identifiers are valid here.
        if (!name || !/^[a-z_][a-z\d_]*$/i.test(name)) return item;
        const replaceLeadingName = (text: string) => text === item.label ||
            (text.startsWith(item.label) && /[\s:{]/.test(text[item.label.length]))
            ? name + text.slice(item.label.length) : text;
        return {
            ...item, label: name,
            insertText: item.insertText === undefined ? undefined : replaceLeadingName(item.insertText),
            textEdit: item.textEdit ? { ...item.textEdit, newText: replaceLeadingName(item.textEdit.newText) } : undefined,
            filterText: name,
            // Keep upstream class distance ordering; sort known names alphabetically within it.
            sortText: item.sortText?.replace(/^([0-9]+)~[\da-f]{8}$/i, `$1${name}`) ?? name,
        };
    });
}

/** String/value popups must never cover Flint's independent asset preview. */
export function isQuotedPosition(line: string, column: number): boolean {
    const strings = /"(?:[^"\\]|\\.)*(?:"|$)/g;
    for (const match of line.matchAll(strings)) {
        if (column >= match.index + 1 && column <= match.index + match[0].length) return true;
    }
    return false;
}
