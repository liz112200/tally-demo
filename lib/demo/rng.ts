// Seeded randomness for the demo data. mulberry32: tiny, fast, and fully
// determined by its 32-bit seed, so the same seed rebuilds identical data on
// every reset. Not for anything security-sensitive.
export type Rng = {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  shuffle<T>(items: readonly T[]): T[];
  uuid(): string;
  fork(label: string): Rng;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, to derive independent sub-streams from a label: adding a merchant
// to one stream then never shifts every value drawn from another.
function hash(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items) => {
      const total = items.reduce((acc, i) => acc + i.weight, 0);
      let r = next() * total;
      for (const i of items) {
        r -= i.weight;
        if (r < 0) return i.value;
      }
      return items[items.length - 1].value;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    // RFC 4122 v4 layout from seeded bits: valid uuid columns, stable ids.
    uuid: () => {
      const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16));
      hex[12] = '4';
      hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
      const s = hex.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
    fork: (label) => createRng((seed ^ hash(label)) >>> 0),
  };
  return rng;
}
