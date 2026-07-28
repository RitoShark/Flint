import { describe, it, expect, vi } from 'vitest';

// projectOpen pulls in the store graph (and through it the Tauri API layer)
// only for the open/import flows; the path helpers under test are pure. Stub
// the far side so importing the module doesn't drag a real backend in.
vi.mock('./stores', () => ({
    useConfigStore: { getState: () => ({ defaultProjectPath: '', recentProjects: [] }) },
    useProjectTabStore: { getState: () => ({}) },
    useNavigationStore: { getState: () => ({}) },
    useAppMetadataStore: { getState: () => ({}) },
}));
vi.mock('./api', () => ({}));

const { projectPathKey, isSameProjectPath, toProjectDir } = await import('./projectOpen');

// The exact spellings Flint stores. Older builds joined a forward-slashed
// projects root to a backslash-separated folder name, so recentProjects holds
// mixed separators while `discover_projects` returns all-backslash paths.
// Typed as `string` rather than string literals so the comparison below, which
// exists to document the old bug, isn't flagged as a no-overlap type error.
const MIXED: string = 'C:/Users/emirf/AppData/Roaming/Flint/projects\\testtests';
const BACKSLASH: string = 'C:\\Users\\emirf\\AppData\\Roaming\\Flint\\projects\\testtests';
const OTHER: string = 'C:\\Users\\emirf\\AppData\\Roaming\\Flint\\projects\\kookkoko';

describe('projectPathKey', () => {
    it('collapses mixed separators to one canonical spelling', () => {
        expect(projectPathKey(MIXED)).toBe(projectPathKey(BACKSLASH));
    });

    it('ignores a trailing separator', () => {
        expect(projectPathKey(`${BACKSLASH}\\`)).toBe(projectPathKey(BACKSLASH));
    });

    it('folds case, since Windows paths are case-insensitive', () => {
        expect(projectPathKey(BACKSLASH.toUpperCase())).toBe(projectPathKey(BACKSLASH));
    });

    it('treats a project config file as its containing project', () => {
        expect(projectPathKey(`${BACKSLASH}\\mod.config.json`)).toBe(projectPathKey(BACKSLASH));
        expect(projectPathKey(`${BACKSLASH}/flint.json`)).toBe(projectPathKey(BACKSLASH));
    });
});

describe('isSameProjectPath', () => {
    // The delete bug: a raw `!==` between these two spellings was always true,
    // so deleting a project never pruned it from Recent Folders.
    it('matches the two spellings of one project', () => {
        expect(MIXED === BACKSLASH).toBe(false); // why the raw comparison failed
        expect(isSameProjectPath(MIXED, BACKSLASH)).toBe(true);
    });

    it('does not match different projects under the same root', () => {
        expect(isSameProjectPath(MIXED, OTHER)).toBe(false);
    });

    it('does not match a project against a sibling sharing its name prefix', () => {
        expect(isSameProjectPath(BACKSLASH, `${BACKSLASH}-backup`)).toBe(false);
    });
});

describe('toProjectDir', () => {
    it('leaves a plain directory untouched', () => {
        expect(toProjectDir(BACKSLASH)).toBe(BACKSLASH);
    });

    it('strips a trailing project config file', () => {
        expect(toProjectDir(`${BACKSLASH}\\mod.config.json`)).toBe(BACKSLASH);
    });

    it('keeps an unrelated .json path intact', () => {
        const asset = `${BACKSLASH}\\content\\data.json`;
        expect(toProjectDir(asset)).toBe(asset);
    });
});
