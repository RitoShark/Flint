import { create } from 'zustand';
import type { Champion } from '../types';

interface ChampionState {
  champions: Champion[];
  championsLoaded: boolean;

  setChampions: (champions: Champion[]) => void;
  clearChampions: () => void;
}

export const useChampionStore = create<ChampionState>((set) => ({
  champions: [],
  championsLoaded: false,

  setChampions: (champions) => set({ champions, championsLoaded: true }),
  clearChampions: () => set({ champions: [], championsLoaded: false }),
}));
