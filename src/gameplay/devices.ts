export const DEVICES = {
  kbm: { label: 'Keyboard + Mouse', uses: ['keysL', 'mouse'] },
  touch: { label: 'Touch', uses: ['touch'] }, // a phone's or a tablet's screen (touch.ts)
  wasd: { label: 'Keys: WASD', uses: ['keysL'] },
  arrows: { label: 'Keys: Arrows', uses: ['keysR'] },
  mouse: { label: 'Mouse only', uses: ['mouse'] },
  pad0: { label: 'Gamepad 1', uses: ['pad0'] },
  pad1: { label: 'Gamepad 2', uses: ['pad1'] },
  pad2: { label: 'Gamepad 3', uses: ['pad2'] },
  pad3: { label: 'Gamepad 4', uses: ['pad3'] },
};

export type DeviceId = keyof typeof DEVICES;
export function deviceInfo(id: string) {
  return Object.hasOwn(DEVICES, id) ? DEVICES[id as DeviceId] : undefined;
}
