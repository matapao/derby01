import { Input } from './gameplay/input.ts';
import { screenDevice } from './touch.ts';

export function localDevice(): string {
  const i = Input.pads.findIndex(Boolean);
  return i >= 0 ? 'pad' + i : screenDevice();
}
