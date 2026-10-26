// Seeded PRNG (mulberry32) + helpers — deterministic simulations
export function rng(seed = 42) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.normal = (mu = 0, sd = 1) => { const u = 1 - r(), v = r(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.exp = (rate) => -Math.log(1 - r()) / rate;
  r.chance = (p) => r() < p;
  r.weighted = (items, wf) => { const ws = items.map(wf), t = ws.reduce((x, y) => x + y, 0); let x = r() * t; for (let i = 0; i < items.length; i++) if ((x -= ws[i]) <= 0) return items[i]; return items.at(-1); };
  return r;
}
