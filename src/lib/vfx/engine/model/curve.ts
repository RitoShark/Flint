export type CurveKey = Readonly<{ time: number; values: readonly number[] }>;
export type ProbabilityTable = Readonly<{ channel: number; single: number; keys: readonly CurveKey[]; mismatched?: true }>;
