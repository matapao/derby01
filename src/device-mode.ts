import { G } from './state.ts';
export const usesMouse = () => G.humans.some((h) => h.device === 'kbm' || h.device === 'mouse');
