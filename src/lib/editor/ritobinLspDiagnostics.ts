import { checkRitobinBrackets } from './bracketCheck';
import type { LspDiagnostic, LspEdit } from './ritobinLspProtocol';

export function readableDiagnostic(d: LspDiagnostic): LspDiagnostic {
    let message = d.message;
    if (/^UnexpectedItem \{/.test(message)) {
        const expected = /expected: (\w+)/.exec(message)?.[1];
        message = expected === 'Entry' ? 'Expected a property name and type here, but found another value or block.'
            : expected === 'Value' ? 'Expected a list or map value here, but found a property entry.'
            : 'This item does not belong in the surrounding block.';
        message += ' Check whether the preceding block is missing a closing bracket.';
    } else if (/^QuotedPropertyName \{/.test(message)) {
        message = 'A quoted name is being read as a class property. If this is a new object, check that the preceding block is closed.';
    } else if (/^MissingType\(/.test(message)) {
        message = 'Missing a type after this property name (for example, name: string = "value"). A missing closing bracket earlier can also cause this error.';
    } else if (message === "Missing '}' for block - got end of file") {
        message = "Missing '}' to close a block. The parser reached the end of the file; the missing bracket may belong earlier in the document.";
    }
    return message === d.message ? d : { ...d, message, rawMessage: d.message };
}

export interface BracketFix {
    title: string;
    explanation: string;
    openerLine: number;
    edit: LspEdit;
}

/** Only locate a repair after the LSP reports a missing closer. This never supplies diagnostics. */
export function suggestLspBracket(text: string, diagnostics: LspDiagnostic[]): BracketFix | null {
    const missing = diagnostics.flatMap(d => {
        const match = /^Missing '(\}|\]|\))' for .* - got end of file$/.exec(d.rawMessage ?? d.message);
        return match ? [match[1]] : [];
    });
    if (missing.length !== 1) return null;
    const result = checkRitobinBrackets(text);
    // Indentation can be ambiguous. Offer one explicit candidate only, never bulk repair.
    if (result.errors.length !== 1) return null;
    const issue = result.errors[0];
    const closer = ({ '{': '}', '[': ']', '(': ')' } as Record<string, string>)[issue.char];
    if (closer !== missing[0] || !issue.message.includes('is never closed')) return null;
    const lines = text.split(/\r?\n/);
    const line = issue.suggestLine - 1;
    if (line < 0 || line >= lines.length) return null;
    const indent = /^\s*/.exec(lines[issue.line - 1])?.[0] ?? '';
    if (!lines.slice(issue.line, line + 1).some(body => body.trim() && !/^\s*(#|\/\/)/.test(body)
        && (/^\s*/.exec(body)?.[0].length ?? 0) > indent.length)) return null;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const newText = eol + indent + closer;
    const repaired = [...lines.slice(0, line), lines[line] + newText, ...lines.slice(line + 1)].join(eol);
    if (!checkRitobinBrackets(repaired).valid) return null;
    const position = { line, character: lines[line].length };
    return {
        title: `Insert '${closer}' after line ${line + 1}`,
        explanation: `Suggested from indentation: insert '${closer}' after line ${line + 1}${line + 1 < lines.length ? `, before the current line ${line + 2}` : ', at the end of the file'}. Fix this first, then let the LSP check the remaining errors again.`,
        openerLine: issue.line,
        edit: { range: { start: position, end: position }, newText },
    };
}
