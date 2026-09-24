export interface Moment {
    readonly step: number;
    readonly bytes: number;
}

export interface Checkpoints<T extends Moment> {
    readonly bytes: number;
    wants(mark: number): boolean;
    keep(mark: number, estimatedBytes: number, capture: () => T): void;
    latest(mark: number, step: number): T | null;
    clear(): void;
}

export function createCheckpoints<T extends Moment>(most: number, budget: number): Checkpoints<T> {
    if (!Number.isSafeInteger(most) || most < 0 || !Number.isFinite(budget) || budget < 0) {
        throw new RangeError('Invalid checkpoint limits');
    }
    const snapshots = new Map<number, T>();
    let used = 0;
    const wants = (mark: number) => Number.isInteger(mark) && mark > 0 && mark <= most && !snapshots.has(mark);
    const validSize = (bytes: number) => Number.isFinite(bytes) && bytes >= 0 && bytes <= budget;
    const priority = (mark: number) => {
        let level = 0;
        while (mark % 2 === 0) {
            mark /= 2;
            level++;
        }
        return level;
    };
    function reserve(bytes: number): void {
        const groups = new Map<number, number[]>();
        for (const mark of snapshots.keys()) {
            const level = priority(mark);
            const group = groups.get(level) ?? [];
            group.push(mark);
            groups.set(level, group);
        }
        for (const level of [...groups.keys()].sort((a, b) => a - b)) {
            if (used + bytes <= budget) break;
            for (const mark of groups.get(level)!) {
                used -= snapshots.get(mark)!.bytes;
                snapshots.delete(mark);
            }
        }
    }
    return {
        get bytes() { return used; },
        wants,
        clear() { snapshots.clear(); used = 0; },
        latest(mark, step) {
            let best = 0;
            let result: T | null = null;
            for (const [index, snapshot] of snapshots) {
                if (index > best && index <= mark && snapshot.step <= step) {
                    best = index;
                    result = snapshot;
                }
            }
            return result;
        },
        keep(mark, estimatedBytes, capture) {
            if (!wants(mark) || !validSize(estimatedBytes)) return;
            const slots = estimatedBytes === 0 ? Infinity : Math.floor(budget / estimatedBytes);
            const spacing = 2 ** Math.max(0, Math.ceil(Math.log2((most - mark + 1) / slots)));
            if (mark % spacing !== 0) return;
            const snapshot = capture();
            if (!validSize(snapshot.bytes) || !Number.isFinite(snapshot.step)) return;
            if (used + snapshot.bytes > budget) reserve(snapshot.bytes);
            snapshots.set(mark, snapshot);
            used += snapshot.bytes;
        },
    };
}
