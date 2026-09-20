import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { Particle } from '@babylonjs/core/Particles/particle';
import type { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { playIdleEffects } from './idleEffectPlayer';
import { decodeDdsToPng } from '../api/texture';
import type { EffectFields } from './idleEffectValues';

vi.mock('../api/mesh', () => ({ resolveAssetPath: vi.fn(async (path: string) => path) }));
vi.mock('../api/texture', () => ({ decodeDdsToPng: vi.fn(async () => ({ data: '', width: 16, height: 16, format: 'PNG' })) }));

const engines: NullEngine[] = [];
afterEach(() => {
    engines.splice(0).forEach(engine => engine.dispose());
    vi.clearAllMocks();
});

async function setup() {
    const engine = new NullEngine();
    engines.push(engine);
    vi.spyOn(engine, 'getDeltaTime').mockReturnValue(16);
    const scene = new Scene(engine);
    const mesh = new Mesh('character', scene);
    const skeleton = new Skeleton('rig', 'rig', scene);
    const bone = new Bone('hand', skeleton, null, Matrix.Identity());
    const fields: EffectFields = {
        texture: 'assets/glow.tex', bindWeight: 1, birthScale0: [2, 3, 1],
        birthColor: [0.2, 0.4, 0.6, 1], particleLifetime: 1,
    };
    const player = playIdleEffects(scene, mesh, skeleton, {
        warnings: [],
        attachments: [{ bone: 'HAND', position: [1, 0, 0], emitters: [fields] }],
    }, 'skin.skn', vi.fn());
    await vi.waitFor(() => expect(scene.particleSystems).toHaveLength(1));
    const system = scene.particleSystems[0] as ParticleSystem;
    const tick = () => scene.onBeforeRenderObservable.notifyObservers(scene);
    tick();
    const particle = new Particle(system);
    system.startPositionFunction!(Matrix.Identity(), particle.position, particle, false);
    system.startDirectionFunction!(Matrix.Identity(), particle.direction, particle, false);
    return { scene, bone, player, system, particle, tick, fields };
}

describe('idle particle playback', () => {
    it('follows a case-insensitive bone attachment through translation and rotation', async () => {
        const { bone, player, system, particle, tick } = await setup();
        expect(particle.position.asArray()).toEqual([1, 0, 0]);
        bone.updateMatrix(Matrix.RotationZ(Math.PI / 2).multiply(Matrix.Translation(4, 0, 0)));
        tick();
        system.updateFunction([particle]);
        expect(particle.position.x).toBeCloseTo(4);
        expect(particle.position.y).toBeCloseTo(1);
        expect(particle.scale.asArray()).toEqual([4, 6]);
        expect(particle.color.r).toBeCloseTo(0.2);
        player.dispose();
    });

    it('freezes particle age at zero playback speed and disposes observers and systems', async () => {
        const { scene, player, system, particle, tick } = await setup();
        player.setSpeed(0);
        tick();
        system.updateFunction([particle]);
        expect(particle.age).toBe(0);
        player.dispose();
        expect(scene.particleSystems).toHaveLength(0);
        expect(scene.onBeforeRenderObservable.observers.filter(o => !o._willBeUnregistered)).toHaveLength(0);
    });

    it('does not create a system when texture loading completes after disposal', async () => {
        let finish!: (value: Awaited<ReturnType<typeof decodeDdsToPng>>) => void;
        vi.mocked(decodeDdsToPng).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const engine = new NullEngine();
        engines.push(engine);
        const scene = new Scene(engine);
        const player = playIdleEffects(scene, new Mesh('mesh', scene), null, {
            warnings: [], attachments: [{ bone: '', position: [0, 0, 0], emitters: [{ texture: 'late.tex' }] }],
        }, 'skin.skn', vi.fn());
        await vi.waitFor(() => expect(finish).toBeDefined());
        player.dispose();
        finish({ data: '', width: 16, height: 16, format: 'PNG' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(scene.particleSystems).toHaveLength(0);
    });

    it('preserves surviving birth values when Babylon recycles a different particle', async () => {
        const { player, system, particle, tick, fields } = await setup();
        fields.birthScale0 = [9, 7, 1];
        const second = new Particle(system);
        system.startPositionFunction!(Matrix.Identity(), second.position, second, false);
        system.startDirectionFunction!(Matrix.Identity(), second.direction, second, false);
        const particles = (system as unknown as { _particles: Particle[] })._particles;
        particles.push(particle, second);
        particle.age = 0.99;
        particle.lifeTime = 1;
        tick();
        system.updateFunction(particles);
        expect(particles).toHaveLength(1);
        tick();
        system.updateFunction(particles);
        expect(particles[0].scale.asArray()).toEqual([18, 14]);
        player.dispose();
    });

    it('can clean up after the owning scene is disposed', async () => {
        const { scene, player } = await setup();
        scene.dispose();
        expect(() => player.dispose()).not.toThrow();
    });

    it('leaves unbound particles where they spawned when the bone moves', async () => {
        const { bone, player, system, particle, tick, fields } = await setup();
        fields.bindWeight = 0;
        bone.updateMatrix(Matrix.Translation(10, 0, 0));
        tick();
        system.updateFunction([particle]);
        expect(particle.position.asArray()).toEqual([1, 0, 0]);
        player.dispose();
    });
});
