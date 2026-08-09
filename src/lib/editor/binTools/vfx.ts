import type * as monacoNs from 'monaco-editor';

type CodeEditor = monacoNs.editor.IStandaloneCodeEditor;

export function hasVfxEmitters(text: string): boolean {
    return /VfxEmitterDefinitionData\s*\{/.test(text);
}

/* Fold/unfold every VfxEmitterDefinitionData block — and ONLY those, so an
 * emitter's parent VfxSystem and unrelated blocks keep their state.
 *
 * Monaco builds the folding model on a debounced scheduler, so right after a
 * load or an edit `getFoldingModel()` can resolve before any region exists.
 * That is what made the buttons look dead. `awaitFoldingRegions` retries a few
 * animation frames until regions appear.
 *
 * The collapse itself goes through `toggleCollapseState`: it repaints the fold
 * decorations and fires the model's change event. Setting `regions.setCollapsed`
 * and calling `foldingModel.update(regions)` does neither — `update()` wants NEW
 * ranges from a range provider, not the regions it already owns. */
async function awaitFoldingRegions(ctrl: any, tries = 12): Promise<any | null> {
    for (let attempt = 0; attempt < tries; attempt++) {
        const fm = await ctrl.getFoldingModel();
        if (fm?.regions?.length > 0) return fm;
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
}

export function setEmittersFolded(ed: CodeEditor, collapse: boolean) {
    const model = ed.getModel();
    if (!model) return;

    const emitterLines = new Set<number>();
    const total = model.getLineCount();
    for (let line = 1; line <= total; line++) {
        if (/VfxEmitterDefinitionData\s*\{/.test(model.getLineContent(line))) emitterLines.add(line);
    }
    if (emitterLines.size === 0) return;

    const ctrl = (ed as any).getContribution('editor.contrib.folding');
    if (!ctrl?.getFoldingModel) return;

    void awaitFoldingRegions(ctrl).then((fm) => {
        if (!fm?.regions) return;
        const regions = fm.regions;
        // toggleCollapseState FLIPS what it is given, so pass only the regions
        // that are currently in the wrong state.
        const toToggle: unknown[] = [];
        for (let i = 0; i < regions.length; i++) {
            if (emitterLines.has(regions.getStartLineNumber(i)) && regions.isCollapsed(i) !== collapse) {
                toToggle.push(regions.toRegion(i));
            }
        }
        if (toToggle.length > 0) fm.toggleCollapseState(toToggle);
    });
}
