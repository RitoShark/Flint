import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import type { Particle } from '@babylonjs/core/Particles/particle';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { decodeDdsToPng } from '../api/texture';
import { resolveAssetPath } from '../api/mesh';
import type { IdleEffectData } from '../api/idleEffects';
import { number, sampleEffectValue } from './idleEffectValues';

export function playIdleEffects(scene: Scene, mesh: Mesh, skeleton: Skeleton | null, data: IdleEffectData, path: string, report: (message: string) => void) {
    let disposed = false;
    let speed = 1;
    const systems: ParticleSystem[] = [];
    const textures: Texture[] = [];
    const ticks: ((dt: number) => void)[] = [];
    const pending = new Map<string, Promise<{ texture: Texture; width: number; height: number }>>();
    let seed = 9173;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const loadTexture = (asset: string) => {
        let promise = pending.get(asset);
        if (!promise) {
            promise = resolveAssetPath(asset, path).then(decodeDdsToPng).then(decoded => {
                if (disposed) throw new Error('Preview closed');
                const url = decoded.data.startsWith('data:') ? decoded.data : `data:image/png;base64,${decoded.data}`;
                const texture = new Texture(url, scene, false, true);
                textures.push(texture);
                return { texture, width: decoded.width, height: decoded.height };
            });
            pending.set(asset, promise);
        }
        return promise;
    };
    for (const attachment of data.attachments) {
        const bone = skeleton?.bones.find(b => b.name.toLowerCase() === attachment.bone.toLowerCase());
        if (attachment.bone && !bone) {
            report(`Idle particle bone “${attachment.bone}” was not found`);
            continue;
        }
        const matrix = Matrix.Identity();
        const updateMatrix = () => {
            mesh.computeWorldMatrix(true);
            if (bone) {
                skeleton!.computeAbsoluteMatrices(true);
                bone.getAbsoluteTransform().multiplyToRef(mesh.getWorldMatrix(), matrix);
            } else matrix.copyFrom(mesh.getWorldMatrix());
        };
        for (const fields of attachment.emitters.slice(0, 64)) {
            if (fields.isDisabled === true) continue;
            const label = String(fields.emitterName ?? 'Idle particle');
            if (typeof fields.texture !== 'string' || !fields.texture) {
                report(`${label}: texture could not be resolved`);
                continue;
            }
            if (fields.isGroundLayer === true || fields.isLocalOrientation === true) {
                report(`${label}: oriented particles are not supported yet`);
                continue;
            }
            void loadTexture(fields.texture).then(({ texture, width, height }) => {
                if (disposed) return;
                const sheet = sampleEffectValue(fields.texDiv, 0, [1, 1]).map(v => Math.max(1, Math.floor(v)));
                const frames = Math.min(sheet[0] * sheet[1], Math.max(1, number(fields.numFrames, sheet[0] * sheet[1])));
                const system = new ParticleSystem(label, 512, scene, undefined, frames > 1);
                systems.push(system);
                system.particleTexture = texture;
                system.preventAutoStart = true;
                system.disposeOnStop = false;
                system.emitter = Vector3.Zero();
                system.minEmitPower = system.maxEmitPower = 1;
                system.minSize = system.maxSize = 1;
                system.color1 = system.color2 = new Color4(1, 1, 1, 0);
                const blendModes: Record<number, number> = {
                    0: ParticleSystem.BLENDMODE_ONEONE,
                    1: ParticleSystem.BLENDMODE_STANDARD,
                    2: ParticleSystem.BLENDMODE_SUBTRACT,
                    4: ParticleSystem.BLENDMODE_ADD,
                };
                const blend = number(fields.blendMode);
                system.blendMode = blendModes[blend] ?? ParticleSystem.BLENDMODE_STANDARD;
                if (!(blend in blendModes)) report(`${label}: blend mode ${blend} is approximated`);
                system.spriteCellWidth = width / sheet[0];
                system.spriteCellHeight = height / sheet[1];
                system.startSpriteCellID = 0;
                system.endSpriteCellID = frames - 1;
                const single = fields.isSingleParticle === true;
                let elapsed = 0;
                let started = false;
                let dt = 0;
                const previous = Matrix.Identity(), movement = Matrix.Identity(), inverse = Matrix.Identity();
                const moved = Vector3.Zero();
                const offset = Vector3.FromArray(attachment.position);
                const births = new WeakMap<Particle, { rolls: number[]; scale: number[]; color: number[] }>();
                system.startPositionFunction = (_world, position, particle) => {
                    const rolls = [random(), random(), random(), random()];
                    const translation = sampleEffectValue(fields.birthTranslation, elapsed, [0, 0, 0], rolls);
                    const local = offset.add(Vector3.FromArray(sampleEffectValue(fields.EmitterPosition, elapsed, [0, 0, 0], rolls)))
                        .add(Vector3.FromArray(translation));
                    Vector3.TransformCoordinatesToRef(local, matrix, position);
                    births.set(particle, {
                        rolls,
                        scale: sampleEffectValue(fields.birthScale0, elapsed, [1, 1, 1], rolls),
                        color: sampleEffectValue(fields.birthColor, elapsed, [1, 1, 1, 1], rolls),
                    });
                };
                system.startDirectionFunction = (_world, direction, particle) => {
                    const birth = births.get(particle)!;
                    direction.copyFromFloats(...sampleEffectValue(fields.birthVelocity, elapsed, [0, 0, 0], birth.rolls) as [number, number, number]);
                    Vector3.TransformNormalToRef(direction, matrix, direction);
                };
                system.updateFunction = particles => {
                    for (let i = particles.length - 1; i >= 0; i--) {
                        const particle = particles[i], birth = births.get(particle);
                        if (!birth) continue;
                        if (particle.age === 0) {
                            particle.lifeTime = Math.max(0.001, Math.min(86400, sampleEffectValue(fields.particleLifetime, elapsed, [single ? 86400 : 1], birth.rolls)[0]));
                            particle.angle = sampleEffectValue(fields.birthRotation0, elapsed, [0, 0, 0], birth.rolls)[2] * Math.PI / 180;
                            particle.angularSpeed = sampleEffectValue(fields.birthRotationalVelocity0, elapsed, [0, 0, 0], birth.rolls)[2] * Math.PI / 180;
                        }
                        particle.age += dt;
                        if (particle.age >= particle.lifeTime) {
                            const last = particles[particles.length - 1];
                            const survivingBirth = births.get(last);
                            system.recycleParticle(particle);
                            if (last !== particle && survivingBirth) births.set(particle, survivingBirth);
                            births.delete(last);
                            continue;
                        }
                        const age = particle.age / particle.lifeTime;
                        const bind = Math.max(0, Math.min(1, sampleEffectValue(fields.bindWeight, age, [0], birth.rolls)[0]));
                        const acceleration = sampleEffectValue(fields.acceleration, age, [0, 0, 0], birth.rolls);
                        particle.direction.addInPlaceFromFloats(acceleration[0] * dt, acceleration[1] * dt, acceleration[2] * dt);
                        Vector3.TransformCoordinatesToRef(particle.position, movement, moved);
                        Vector3.LerpToRef(particle.position, moved, bind, particle.position);
                        particle.position.addInPlace(particle.direction.scale(dt));
                        particle.angle += particle.angularSpeed * dt;
                        const scale = sampleEffectValue(fields.scale0, age, [1, 1, 1], birth.rolls);
                        particle.scale.copyFromFloats(Math.abs(birth.scale[0] * scale[0]) * 2, Math.abs(birth.scale[1] * scale[1]) * 2);
                        const color = sampleEffectValue(fields.color, age, [1, 1, 1, 1], birth.rolls).map((v, c) => v * birth.color[c]);
                        particle.color.copyFromFloats(color[0], color[1], color[2], color[3]);
                        particle.cellIndex = (Math.max(0, Math.floor(number(fields.startFrame))) + Math.floor(particle.age * number(fields.frameRate))) % frames;
                    }
                };
                updateMatrix();
                previous.copyFrom(matrix);
                ticks.push(delta => {
                    dt = delta;
                    elapsed += dt;
                    updateMatrix();
                    previous.invertToRef(inverse);
                    inverse.multiplyToRef(matrix, movement);
                    previous.copyFrom(matrix);
                    system.updateSpeed = dt / Math.max(0.001, scene.getAnimationRatio());
                    const delay = sampleEffectValue(fields.birthDelay, 0, [0])[0];
                    if (!started && elapsed >= delay) {
                        started = true;
                        system.manualEmitCount = single ? 1 : -1;
                        system.start();
                    }
                    const duration = number(fields.emitterLifetime, -1);
                    system.emitRate = single || (duration > 0 && elapsed - delay >= duration) ? 0
                        : Math.min(2000, Math.max(0, sampleEffectValue(fields.rate, Math.max(0, elapsed - delay), [1])[0]));
                });
            }).catch(error => { if (!disposed) report(`${label}: ${String(error)}`); });
        }
    }
    const observer = scene.onBeforeRenderObservable.add(() => {
        const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000) * speed;
        for (const tick of ticks) tick(dt);
    });
    return {
        setSpeed(value: number) { speed = Math.max(0, value); },
        dispose() {
            disposed = true;
            scene.onBeforeRenderObservable.remove(observer);
            systems.forEach(s => s.dispose(false));
            textures.forEach(t => t.dispose());
        },
    };
}
