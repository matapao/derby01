import type { Car, CarAssembly } from '../../src/car-types.ts';
import type { DerbyDebug } from '../../src/flow.ts';
import { FX, defineEffect, share } from '../../src/net/effects.ts';
import { gunAt } from '../../src/gameplay/guns.ts';
import { placeDrop } from '../../src/drops.ts';
import { SFX } from '../../src/audio.ts';
import { requireFields } from '../../src/required-fields.ts';

type IsAny<T> = 0 extends 1 & T ? true : false;
type MustBeFalse<T extends false> = T;
export type NoUntypedDebug = MustBeFalse<IsAny<DerbyDebug>>;
export type NoUntypedDraw = MustBeFalse<IsAny<Parameters<typeof placeDrop>[1]>>;

export function browserContracts(car: Car, assembly: CarAssembly, debug: DerbyDebug): void {
  // @ts-expect-error only a completed car may enter presentation/gameplay
  const incomplete: Car = assembly;
  void incomplete;
  requireFields(assembly, ['root']);
  assembly.root.visible = true;
  // @ts-expect-error a drawing attachment cannot become arbitrary data
  car.root = 'mesh';
  // @ts-expect-error supply kinds must be validated before rendering
  placeDrop(1, 'constructor', 0, 0, 0);
  // @ts-expect-error positional audio accepts a position, not a string
  SFX.gun('boom');
  // @ts-expect-error the gun contract cannot silently lose its numeric heat
  gunAt(car, 1).heat = 'hot';
  // @ts-expect-error debug state exposes actual game contracts
  debug.G.cars = 'cars';
  // @ts-expect-error shared wire ids fix the argument tuple
  share(FX.takeDrop, () => {}, ['drop']);
  // @ts-expect-error callers cannot widen an effect id through its function arguments
  defineEffect(FX.takeDrop, (text: string) => text, {
    write() {},
    read() {
      return [1];
    },
  });
  defineEffect(FX.takeDrop, (id: number) => id, {
    write() {},
    // @ts-expect-error codecs must validate and return the correct tuple
    read() {
      return ['drop'];
    },
  });
}
