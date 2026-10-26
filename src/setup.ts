/** Saved settings boundary. Pure: importing this module never starts the game or touches storage. */
export interface CarSetup {
  team: number;
  kit: string;
  seats: string[];
}
export interface Setup {
  botSkill: number;
  mapSeed: number;
  cars: CarSetup[];
}
interface SetupRules {
  devices: Readonly<Record<string, { readonly uses: readonly string[] }>>;
  defaultKits: readonly string[];
  isKit(value: unknown): boolean;
  maxCars: number;
  newMapSeed(): number;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Rebuild fields rather than trusting persisted objects; devices sharing a resource cannot overlap. */
export function decodeSetup(value: unknown, rules: SetupRules): Setup | null {
  if (!rules.defaultKits.length) throw new RangeError('Setup requires at least one default kit');
  const saved = object(value);
  if (!Array.isArray(saved['cars']) || saved['cars'].length < 2 || saved['cars'].length > rules.maxCars)
    return null;
  const used = new Set<string>();
  const seat = (value: unknown): string => {
    if (typeof value !== 'string' || !Object.hasOwn(rules.devices, value)) return 'bot';
    const device = rules.devices[value];
    if (!device) return 'bot';
    const resources = device.uses;
    if (resources.some((resource) => used.has(resource))) return 'bot';
    resources.forEach((resource) => used.add(resource));
    return value;
  };
  const cars = saved['cars'].map((value, team): CarSetup => {
    const car = object(value);
    return {
      team,
      kit:
        typeof car['kit'] === 'string' && rules.isKit(car['kit'])
          ? car['kit']
          : rules.defaultKits[team % rules.defaultKits.length]!,
      seats:
        Array.isArray(car['seats']) && car['seats'].length === 4
          ? car['seats'].map(seat)
          : ['bot', 'bot', 'bot', 'bot'],
    };
  });
  return {
    botSkill: saved['botSkill'] === 0 || saved['botSkill'] === 2 ? saved['botSkill'] : 1,
    mapSeed:
      typeof saved['mapSeed'] === 'number' &&
      Number.isInteger(saved['mapSeed']) &&
      saved['mapSeed'] >= 1 &&
      saved['mapSeed'] <= 99999
        ? saved['mapSeed']
        : rules.newMapSeed(),
    cars,
  };
}
