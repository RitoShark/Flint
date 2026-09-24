import { particleFragment, quadVertex } from './programs';
export const ARBITRARY_UV = [[0, 1, 0.5], [1, 0, 0.5]] as const;
export const VERTEX = quadVertex();
export const FRAGMENT = particleFragment();
