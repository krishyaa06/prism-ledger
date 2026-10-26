// Tiny terminal UI helpers (ESM, zero deps)
const env = typeof process !== "undefined" ? process.env : {};
export const useColor = typeof process !== "undefined" && !env.NO_COLOR && (env.FORCE_COLOR || process.stdout.isTTY);
const w = (a, b) => (s) => (useColor ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
const rgb = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));
export const c = { bold: w(1, 22), dim: w(2, 22), red: w(31, 39), green: w(32, 39), yellow: w(33, 39), blue: w(34, 39), magenta: w(35, 39), cyan: w(36, 39), gray: w(90, 39), accent: rgb(0, 210, 255), accent2: rgb(108, 99, 255), rgb };
export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const width = (s) => [...strip(s)].length;
export const pad = (s, n, right = false) => { const g = " ".repeat(Math.max(0, n - width(s))); return right ? g + s : s + g; };
export function table(rows, { head, align = [] } = {}) {
  const all = head ? [head, ...rows] : rows; const cols = Math.max(...all.map((r) => r.length));
  const ws = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => width(r[i] ?? ""))));
  const line = (r) => r.map((v, i) => pad(String(v ?? ""), ws[i], align[i] === "right")).join("  ").trimEnd();
  const out = []; if (head) { out.push(c.bold(line(head))); out.push(c.dim(ws.map((x) => "─".repeat(x)).join("  "))); }
  rows.forEach((r) => out.push(line(r))); return out.join("\n");
}
export const header = (name, sub = "") => `${c.accent("◆")} ${c.bold(name)}${sub ? " " + c.dim(sub) : ""}`;
export const bar = (frac, n = 20, col = c.accent) => { const f = Math.round(Math.max(0, Math.min(1, frac)) * n); return col("█".repeat(f)) + c.dim("░".repeat(n - f)); };
export const spark = (vals) => { const ch = "▁▂▃▄▅▆▇█", lo = Math.min(...vals), hi = Math.max(...vals); return vals.map((v) => ch[Math.round(((v - lo) / (hi - lo || 1)) * 7)]).join(""); };
export const num = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const ms = (n) => (n < 1 ? (n * 1000).toFixed(0) + "µs" : n < 1000 ? n.toFixed(2) + "ms" : (n / 1000).toFixed(2) + "s");
export function fail(msg, code = 2) { console.error(c.red("✖ " + msg)); process.exit(code); }
