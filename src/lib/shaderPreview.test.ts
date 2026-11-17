import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), frontend: true }));
vi.mock('@shaderforge', () => ({ get shaderForgeAvailable() { return mocks.frontend; } }));
vi.mock('./api/core', () => ({ invokeCommand: mocks.invoke }));

beforeEach(() => { vi.resetModules(); mocks.invoke.mockReset(); mocks.frontend = true; });

it('does not advertise a mounted frontend when the backend is a stub', async () => {
    mocks.invoke.mockResolvedValue(false);
    const { shaderPreviewAvailable } = await import('./shaderPreview');
    expect(await shaderPreviewAvailable()).toBe(false);
    expect(await shaderPreviewAvailable()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it('shares the backend capability query between callers', async () => {
    mocks.invoke.mockResolvedValue(true);
    const { shaderPreviewAvailable } = await import('./shaderPreview');
    expect(await Promise.all([shaderPreviewAvailable(), shaderPreviewAvailable()])).toEqual([true, true]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it('skips backend discovery when the frontend module is absent', async () => {
    mocks.frontend = false;
    const { shaderPreviewAvailable } = await import('./shaderPreview');
    expect(await shaderPreviewAvailable()).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
});

it('explains why a stub build cannot load game shaders', async () => {
    mocks.invoke.mockResolvedValue(false);
    const { shaderPreviewStatus } = await import('./shaderPreview');
    expect(await shaderPreviewStatus()).toMatchObject({ available: false, reason: expect.stringContaining('no ShaderForge backend') });
});

it('reports connection failures and allows a later retry', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('IPC unavailable')).mockResolvedValueOnce(true);
    const { shaderPreviewStatus } = await import('./shaderPreview');
    expect(await shaderPreviewStatus()).toMatchObject({ available: false, reason: expect.stringContaining('IPC unavailable') });
    expect((await shaderPreviewStatus()).available).toBe(true);
});
