export const UV_LAYERS = 2;
export const UV_SLOTS = 10;
export const FRAME_SLOTS = 9;
export const NOT_LINGERING = -1;
export const UV = {
    scrollX: 0, scrollY: 1, birthOffsetX: 2, birthOffsetY: 3,
    birthScrollX: 4, birthScrollY: 5, rotate: 6, birthRotate: 7,
    phase: 8, frameRate: 9,
} as const;

const widths = {
    birthTime: 1, lifetime: 1, position: 3, velocity: 3, travel: 3,
    birthScale: 3, frame: FRAME_SLOTS, rotation: 3, angularVelocity: 3,
    angularAcceleration: 3, birthDrag: 3, dragTerminal: 3, dragOffset: 3,
    orbital: 3, birthColor: 4, roll: 1, lingerFrom: 1, tiling: 2,
    odometer: 1, uv: UV_LAYERS * UV_SLOTS,
} as const;

type FloatColumns = { readonly [K in keyof typeof widths]: Float32Array };
export type Pool = FloatColumns & {
    readonly capacity: number;
    readonly emitter: Int32Array;
    readonly serial: Uint32Array;
    count: number;
    born: number;
};

type Column = Float32Array | Int32Array | Uint32Array;
type ColumnName = keyof FloatColumns | 'emitter' | 'serial';
const layout: readonly (readonly [ColumnName, number])[] = [
    ['emitter', 1], ['serial', 1],
    ...Object.entries(widths) as [keyof FloatColumns, number][],
];
const bytesPerParticle = layout.reduce((total, [, width]) => total + width * 4, 0);

export interface PoolRows {
    readonly count: number;
    readonly born: number;
    readonly columns: readonly Column[];
}

export function createPool(capacity: number): Pool {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('Invalid particle capacity');
    const columns = Object.fromEntries(Object.entries(widths).map(([name, width]) => [name, new Float32Array(capacity * width)])) as FloatColumns;
    return { ...columns, capacity, count: 0, born: 0, emitter: new Int32Array(capacity), serial: new Uint32Array(capacity) };
}

export function uvAt(index: number, layer: number): number {
    return UV_SLOTS * (UV_LAYERS * index + layer);
}

export function spawn(pool: Pool, emitter: number, birthTime: number, lifetime: number, roll: number): number | null {
    if (pool.count === pool.capacity) return null;
    const index = pool.count++;
    for (const [name, width] of layout) pool[name].fill(0, index * width, (index + 1) * width);
    pool.birthScale.fill(1, index * 3, index * 3 + 3);
    pool.birthColor.fill(1, index * 4, index * 4 + 4);
    for (let diagonal = 0; diagonal < FRAME_SLOTS; diagonal += 4) pool.frame[index * FRAME_SLOTS + diagonal] = 1;
    pool.emitter[index] = emitter;
    pool.serial[index] = pool.born++;
    pool.birthTime[index] = birthTime;
    pool.lifetime[index] = lifetime;
    pool.roll[index] = roll;
    pool.lingerFrom[index] = NOT_LINGERING;
    return index;
}

export function retire(pool: Pool, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= pool.count) return;
    pool.count--;
    if (index === pool.count) return;
    for (const [name, width] of layout) {
        pool[name].copyWithin(index * width, pool.count * width, (pool.count + 1) * width);
    }
}

export function copyRows(pool: Pool): PoolRows {
    return {
        count: pool.count,
        born: pool.born,
        columns: layout.map(([name, width]) => pool[name].slice(0, pool.count * width)),
    };
}

export function writeRows(pool: Pool, rows: PoolRows): void {
    if (!Number.isInteger(rows.count) || rows.count < 0 || rows.count > pool.capacity || rows.columns.length !== layout.length) {
        throw new RangeError('Particle snapshot does not fit the pool');
    }
    for (let i = 0; i < layout.length; i++) {
        const [name, width] = layout[i];
        if (rows.columns[i].constructor !== pool[name].constructor || rows.columns[i].length !== rows.count * width) {
            throw new RangeError(`Invalid particle snapshot column: ${name}`);
        }
    }
    layout.forEach(([name], i) => pool[name].set(rows.columns[i]));
    pool.count = rows.count;
    pool.born = rows.born;
}

export function rowsByteLength(rows: PoolRows): number {
    return rows.columns.reduce((bytes, column) => bytes + column.byteLength, 0);
}

export function liveByteLength(pool: Pool): number {
    return pool.count * bytesPerParticle;
}
