import type { EmitterModel } from '../../engine/model/model';
import { age01, appearance, drawnPlace, drawnPlaceInto, erosionDrive, legacyRoll, standingFrameInto, type DrawFrame } from '../../engine/simulation/particleRead';
import type { Pool } from '../../engine/simulation/pool';
import { multiplyInto, standingInto } from '../../engine/utils/basis';
import { colorLookupInto } from '../utils/colorLookup';
import { packUv } from '../utils/ribbon';
import { uvDraw, uvTransformInto } from '../utils/uvTransform';
import type { MeshBuffers, QuadBuffers } from '../utils/buffers';

export class DrawParticle {
    readonly scale = new Float32Array(3);
    readonly color = new Float32Array(4);
    readonly position = drawnPlace();
    readonly lookup = new Float32Array(3);
    readonly textures = [new Float32Array(7), new Float32Array(7)];
    readonly rotation = new Float32Array(9);
    private readonly standing = new Float32Array(9);
    private readonly uv = uvDraw();
    age = 0;

    read(emitter: EmitterModel, pool: Pool, index: number, frame: DrawFrame) {
        this.age = frame.now - pool.birthTime[index];
        const progress = age01(pool, index, frame.now);
        appearance(pool, index, emitter, frame.now, this);
        drawnPlaceInto(pool, index, frame, this.position);
        colorLookupInto(emitter, pool, index, progress, this.lookup, 0);
        this.lookup[2] = erosionDrive(pool, index, emitter, frame.now);
        [emitter.uv, emitter.multUv].forEach((layer, channel) => {
            if (!layer) return;
            uvTransformInto(pool, index, layer, channel, this.age, progress, frame.now, this.uv);
            packUv(this.uv, this.textures[channel], 0);
        });
        return this;
    }

    orient(emitter: EmitterModel, pool: Pool, index: number, frame: DrawFrame) {
        standingInto(pool.rotation, index * 3, legacyRoll(pool, index, emitter, frame.now), this.rotation);
        standingFrameInto(pool, index, emitter, frame, this.standing);
        multiplyInto(this.standing, this.rotation, this.rotation);
        if (this.position.orbited) multiplyInto(this.position.turn, this.rotation, this.rotation);
        return this.rotation;
    }

    writeTextures(buffers: MeshBuffers | QuadBuffers, instance: number) {
        [buffers.uvTurn, buffers.uvTurnMult].forEach((attribute, channel) => {
            const uv = this.textures[channel];
            attribute.setXYZ(instance, uv[0], uv[1], uv[2]);
        });
        [buffers.uvShift, buffers.uvShiftMult].forEach((attribute, channel) => {
            const uv = this.textures[channel];
            attribute.setXYZW(instance, uv[3], uv[4], uv[5], uv[6]);
        });
    }
}
