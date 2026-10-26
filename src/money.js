// Exact money in integer minor units. No floats ever touch a balance.
export const CURRENCIES = { INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, JPY: 0, USDC: 6, BTC: 8 };
export const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£", AED: "AED ", SGD: "S$", JPY: "¥", USDC: "USDC ", BTC: "₿" };
export class MoneyError extends Error { constructor(msg) { super(msg); this.code = "BAD_AMOUNT"; } }
export const decimals = (cur) => { const d = CURRENCIES[cur]; if (d == null) throw new MoneyError(`unknown currency ${cur}`); return d; };

/** "1,234.50" | "1234.5" | 1234.5 -> 123450 (INR). Rejects exponents, extra precision and unsafe magnitudes. */
export function toMinor(v, cur = "INR") {
  if (typeof v === "bigint") v = v.toString();
  const s = String(v).trim().replace(/[,_\s]/g, ""), d = decimals(cur), m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) throw new MoneyError(`bad amount "${v}"`);
  const frac = (m[3] || "").replace(/0+$/, "");
  if (frac.length > d) throw new MoneyError(`${cur} has ${d} decimals, got "${v}"`);
  const n = Number((m[2] || "0") + frac.padEnd(d, "0"));
  if (!Number.isSafeInteger(n)) throw new MoneyError(`amount out of range "${v}"`);
  return m[1] ? -n : n;
}
/** 123450 -> "1,234.50" (Indian grouping for INR). */
export function fmtMoney(minor, cur = "INR", { symbol = true, group = true } = {}) {
  const d = decimals(cur), neg = minor < 0, a = Math.abs(minor), s = String(a).padStart(d + 1, "0");
  let int = d ? s.slice(0, -d) : s; const frac = d ? s.slice(-d) : "";
  if (group) int = cur === "INR" ? int.replace(/(\d)(?=(\d\d)+\d$)/g, "$1,") : int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + (symbol ? SYMBOL[cur] || cur + " " : "") + int + (d ? "." + frac : "");
}
/** Compact display: ₹12.4 L, ₹3.2 Cr, $1.2M. */
export function fmtShort(minor, cur = "INR") {
  const v = Math.abs(minor) / 10 ** decimals(cur), sg = minor < 0 ? "-" : "", sym = SYMBOL[cur] || cur + " ";
  if (cur === "INR") { if (v >= 1e7) return `${sg}${sym}${(v / 1e7).toFixed(2)} Cr`; if (v >= 1e5) return `${sg}${sym}${(v / 1e5).toFixed(1)} L`; if (v >= 1e3) return `${sg}${sym}${(v / 1e3).toFixed(1)}k`; return `${sg}${sym}${v.toFixed(0)}`; }
  if (v >= 1e6) return `${sg}${sym}${(v / 1e6).toFixed(2)}M`; if (v >= 1e3) return `${sg}${sym}${(v / 1e3).toFixed(1)}k`; return `${sg}${sym}${v.toFixed(Math.min(2, decimals(cur)))}`;
}
/** Split an amount into n parts that sum exactly (largest-remainder), e.g. for fees or splits. */
export function allocate(minor, weights) {
  const tot = weights.reduce((a, b) => a + b, 0); if (tot <= 0) throw new MoneyError("weights must sum > 0");
  const raw = weights.map((w) => (minor * w) / tot), out = raw.map(Math.floor); let rest = minor - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return out;
}
/** Percentage fee in basis points with banker's rounding (half to even). */
export function bps(minor, b) { const x = (minor * b) / 10000, f = Math.floor(x), r = x - f; return r > 0.5 || (r === 0.5 && f % 2 === 1) ? f + 1 : f; }
