export type LayerType = 'model' | 'text' | 'disc' | 'deco' | 'env';

export interface BaseLayer {
  id: string;
  type: LayerType;
  name: string;
  hidden: boolean;
  rot: number;
  locked: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  text: string;
  size: number;
  font: string;
  italic: boolean;
  spacing: number;
}

export interface ModelLayer extends BaseLayer {
  type: 'model';
  sknPath: string;
  anim: string;
  frame: number;
  maxFrame: number;
  scale: number;
  orbit: number;
  /** Submesh (material) names hidden for this model. Empty/undefined = all
   *  submeshes visible. Driven by the mesh-visibility popup. */
  hiddenMeshes?: string[];
}

export interface DiscLayer extends BaseLayer {
  type: 'disc';
  opacity: number; // fixed composite
}

export interface DecoLayer extends BaseLayer {
  type: 'deco';
  asset: string;
  z: 'front' | 'behind';
}

export type Layer = TextLayer | ModelLayer | DiscLayer | DecoLayer;

export function addLayer(list: Layer[], layer: Layer): Layer[] {
  return [layer, ...list];
}

export function removeLayer(list: Layer[], id: string): Layer[] {
  return list.filter(l => l.id !== id);
}

export function updateLayer(list: Layer[], id: string, patch: Partial<Layer>): Layer[] {
  return list.map(l => (l.id === id ? ({ ...l, ...patch } as Layer) : l));
}

export function toggleLock(list: Layer[], id: string): Layer[] {
  return list.map(l => (l.id === id ? { ...l, locked: !l.locked } : l));
}

export function serialize(list: Layer[]): string {
  return JSON.stringify(list);
}

export function deserialize(json: string): Layer[] {
  return JSON.parse(json) as Layer[];
}
