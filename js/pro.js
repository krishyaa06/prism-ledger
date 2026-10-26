// Prism Systems UI kit (ES module, zero deps)
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v; else if (k === "html") e.innerHTML = v; else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const fmt = {
  num: (n, d = 0) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })),
  compact: (n) => (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + "k" : fmt.num(n, Math.abs(n) < 10 && n % 1 ? 2 : 0)),
  ms: (n) => (n < 1 ? (n * 1000).toFixed(0) + "µs" : n < 1000 ? n.toFixed(n < 10 ? 2 : 0) + "ms" : (n / 1000).toFixed(2) + "s"),
  bytes: (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(2) + " GB"),
  pct: (x, d = 1) => (x * 100).toFixed(d) + "%",
  money: (n, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n),
  time: (t = Date.now()) => new Date(t).toTimeString().slice(0, 8),
};
export function rng(seed = 42) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function toast(msg) { let t = $(".toast"); if (!t) { t = h("div", { class: "toast" }); document.body.append(t); } t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200); }

/** Animation loop with play/pause/speed. tick(dtSeconds, elapsed) */
export class Loop {
  constructor(tick, { speed = 1 } = {}) { this.tick = tick; this.speed = speed; this.running = false; this.t = 0; this._f = this._f.bind(this); }
  start() { if (this.running) return; this.running = true; this.last = performance.now(); requestAnimationFrame(this._f); this.onchange?.(true); }
  stop() { this.running = false; this.onchange?.(false); }
  toggle() { this.running ? this.stop() : this.start(); }
  _f(now) { if (!this.running) return; const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000)) * this.speed; this.last = now; this.t += dt; this.tick(dt, this.t); requestAnimationFrame(this._f); }
}
/** Wire [data-play] button, [data-speed] select and .live indicator to a Loop. */
export function bindLoop(loop, root = document) {
  const btn = $("[data-play]", root), sp = $("[data-speed]", root), live = $(".live", root);
  const sync = (on) => { if (btn) btn.innerHTML = on ? "❚❚ Pause" : "▶ Run"; live?.classList.toggle("on", on); if (live) live.lastChild.textContent = on ? " live" : " paused"; };
  loop.onchange = sync; btn?.addEventListener("click", () => loop.toggle()); sp?.addEventListener("change", () => (loop.speed = +sp.value)); sync(loop.running);
}
/** Streaming log panel. */
export class LogView {
  constructor(el, max = 250) { this.el = el; this.max = max; }
  push(msg, cls = "", t = fmt.time()) { const d = h("div", {}, h("span", { class: "t" }, t + " "), h("span", { class: cls }, msg)); const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 30; this.el.append(d); while (this.el.childElementCount > this.max) this.el.firstChild.remove(); if (stick) this.el.scrollTop = this.el.scrollHeight; }
  html(html, t = fmt.time()) { const d = h("div", { html: `<span class="t">${t} </span>${html}` }); this.el.append(d); while (this.el.childElementCount > this.max) this.el.firstChild.remove(); this.el.scrollTop = this.el.scrollHeight; }
  clear() { this.el.innerHTML = ""; }
}
/** KPI tiles with tweened values. defs: [{key,label,fmt?,tone?,sub?}] */
export class Kpis {
  constructor(el, defs) { this.el = el; this.defs = defs; this.cur = {}; this.nodes = {}; el.classList.add("kpis"); for (const d of defs) { const b = h("b", {}, "–"), s = h("small", {}); const k = h("div", { class: "kpi " + (d.tone || "") }, h("span", {}, d.label), b, d.sub ? s : null); this.nodes[d.key] = { b, s, k }; el.append(k); } }
  set(vals) { for (const d of this.defs) { if (!(d.key in vals)) continue; const v = vals[d.key], n = this.nodes[d.key]; if (typeof v === "number" && isFinite(v)) { const from = this.cur[d.key] ?? v; this.cur[d.key] = v; tween(from, v, 350, (x) => (n.b.textContent = (d.fmt || fmt.compact)(x))); } else n.b.textContent = v; } }
  tone(key, tone) { const n = this.nodes[key]; if (n) n.k.className = "kpi " + (tone || ""); }
  sub(key, text) { const n = this.nodes[key]; if (n) n.s.textContent = text; }
}
export function tween(a, b, ms, fn) { if (a === b || !isFinite(a)) return fn(b); const t0 = performance.now(); const f = (now) => { const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3); fn(a + (b - a) * e); if (k < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); }
/** DPR-aware canvas helper. Returns {ctx,w,h} sized to element. */
export function fit(canvas) { const r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1; const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height)); if (canvas.width !== w * d || canvas.height !== hh * d) { canvas.width = w * d; canvas.height = hh * d; } const ctx = canvas.getContext("2d"); ctx.setTransform(d, 0, 0, d, 0, 0); return { ctx, w, h: hh }; }
/** Rolling multi-series line chart. */
export class Chart {
  constructor(canvas, { series = [{ label: "", color: "--accent" }], points = 120, min = 0, max = null, fmtY = fmt.compact, area = true } = {}) { this.c = canvas; this.series = series; this.points = points; this.min = min; this.max = max; this.fmtY = fmtY; this.area = area; this.data = series.map(() => []); }
  push(...vals) { vals.forEach((v, i) => { const d = this.data[i]; d.push(v); if (d.length > this.points) d.shift(); }); this.draw(); }
  set(arrays) { this.data = arrays.map((a) => a.slice(-this.points)); this.draw(); }
  draw() {
    const { ctx, w, h: H } = fit(this.c); ctx.clearRect(0, 0, w, H);
    const all = this.data.flat().filter((x) => isFinite(x)); const lo = this.min ?? (all.length ? Math.min(...all) : 0), hi = this.max ?? (Math.max(lo + 1e-9, ...all) * 1.1 || 1);
    const pad = { l: 44, r: 8, t: 10, b: 18 }, iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
    ctx.font = "10px JetBrains Mono, monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 3; i++) { const y = pad.t + (ih * i) / 3; ctx.strokeStyle = "#ffffff0d"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.fillStyle = "#5f6884"; ctx.fillText(this.fmtY(hi - ((hi - lo) * i) / 3), pad.l - 6, y); }
    this.series.forEach((s, si) => {
      const d = this.data[si]; if (d.length < 2) return; const col = s.color.startsWith("--") ? css(s.color) : s.color;
      const X = (i) => pad.l + (iw * i) / (this.points - 1) + iw * (this.points - d.length) / (this.points - 1), Y = (v) => pad.t + ih - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * ih;
      ctx.beginPath(); d.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.stroke();
      if (this.area && si === 0) { ctx.lineTo(X(d.length - 1), pad.t + ih); ctx.lineTo(X(0), pad.t + ih); ctx.closePath(); const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih); g.addColorStop(0, col + "55"); g.addColorStop(1, col + "00"); ctx.fillStyle = g; ctx.fill(); }
    });
    let lx = pad.l + 4; ctx.textAlign = "left"; this.series.forEach((s) => { if (!s.label) return; const col = s.color.startsWith("--") ? css(s.color) : s.color; ctx.fillStyle = col; ctx.fillRect(lx, pad.t + 2, 8, 3); ctx.fillStyle = "#8d94ad"; ctx.fillText(s.label, lx + 12, pad.t + 4); lx += ctx.measureText(s.label).width + 26; });
  }
}
/** Horizontal bars: set([{label,value,max?,text?}]) */
export class Bars {
  constructor(el) { this.el = el; el.classList.add("bars"); }
  set(items, max = Math.max(1e-9, ...items.map((i) => i.value))) { this.el.innerHTML = ""; for (const it of items) this.el.append(h("div", { class: "bar" }, h("span", {}, it.label), h("div", { class: "tr" }, h("div", { class: "fl", style: { width: Math.min(100, (it.value / (it.max || max)) * 100) + "%", background: it.color || "" } })), h("span", {}, it.text ?? fmt.compact(it.value)))); }
}
export function hexA(hex, a) { const v = parseInt(hex.replace("#", ""), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- page chrome (auto) ----
function chrome() {
  for (const t of $$("[data-tabs]")) { const bs = $$("button", t), ps = $$(`[data-tabp="${t.dataset.tabs}"]`); bs.forEach((b, i) => b.addEventListener("click", () => { bs.forEach((x) => x.classList.toggle("on", x === b)); ps.forEach((p, j) => p.classList.toggle("on", j === i)); })); }
  for (const b of $$("[data-copy]")) b.addEventListener("click", () => { const pre = b.closest(".codebox").querySelector("pre"); navigator.clipboard?.writeText(pre.innerText).then(() => toast("Copied to clipboard")); });
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.08 }) : null;
  for (const r of $$(".reveal")) io ? io.observe(r) : r.classList.add("in");
  const bg = $("#bg"); if (bg && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const R = rng(7), pts = Array.from({ length: 70 }, () => ({ x: R(), y: R(), vx: (R() - 0.5) * 0.00035, vy: (R() - 0.5) * 0.00035 }));
    const a1 = css("--accent") || "#00d2ff";
    const draw = () => { const { ctx, w, h: H } = fit(bg); ctx.clearRect(0, 0, w, H); for (const p of pts) { p.x = (p.x + p.vx + 1) % 1; p.y = (p.y + p.vy + 1) % 1; } for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const dx = (pts[i].x - pts[j].x) * w, dy = (pts[i].y - pts[j].y) * H, d = Math.hypot(dx, dy); if (d < 150) { ctx.strokeStyle = hexA(a1, (1 - d / 150) * 0.16); ctx.beginPath(); ctx.moveTo(pts[i].x * w, pts[i].y * H); ctx.lineTo(pts[j].x * w, pts[j].y * H); ctx.stroke(); } } for (const p of pts) { ctx.fillStyle = hexA(a1, 0.5); ctx.fillRect(p.x * w - 1, p.y * H - 1, 2, 2); } requestAnimationFrame(draw); };
    draw();
  }
  const links = $$(".topbar nav a[href^='#']"); if (links.length && io) { const so = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) links.forEach((l) => l.classList.toggle("on", l.getAttribute("href") === "#" + e.target.id)); }), { rootMargin: "-45% 0px -50% 0px" }); links.forEach((l) => { const s = $(l.getAttribute("href")); s && so.observe(s); }); }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", chrome); else chrome();
