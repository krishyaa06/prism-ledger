import { Platform, TENANTS, fmtMoney, fmtShort, toMinor, LedgerError } from "../src/index.js";
import { $, esc, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, hexA } from "./pro.js";

const OK = "#34f5c5", BAD = "#ff5c8a", WARN = "#ffb547", ACC = "#5cc8ff", ACC2 = "#7c5cff", MUTED = "#5f6884", TEXT = "#e6ebf5", mono = "JetBrains Mono, monospace";
const TYPE_COL = { asset: OK, liability: ACC2, revenue: ACC, expense: WARN, equity: "#c084fc" };
const KIND_COL = { topup: OK, pay: ACC, p2p: ACC2, payout: WARN, withdraw: WARN, settlement: OK, refund: "#c084fc", remit: ACC, charge: BAD, writeoff: BAD, return: OK, capital: "#c084fc" };
const P = new Platform({ seed: 21, rate: 12, settleEvery: 20, reconTol: 40e3, stale: 80e3 }), Lg = P.L;
const clock = () => new Date(Date.UTC(2026, 9, 26, 4, 30) + P.t * 1000 + 19800e3).toISOString().slice(11, 19);
const log = new LogView($("#log"), 200), LOG = (h) => log.html(h, clock());
let T = TENANTS[0].id; const cfg = () => P.cfg[T], cur = () => cfg().currency, money = (v, c = cur()) => fmtMoney(v, c), short = (v, c = cur()) => fmtShort(v, c);

// ---------- node layout per tenant ----------
const GROUP = (code) => (code.includes("nostro") ? "nostro" : code.startsWith("expense:") ? code.slice(8) : code.split(":")[0]);
function nodesFor(id) {
  const c = P.cfg[id], N = (key, col, row, label, short, type) => ({ key, col, row, label, short, type, glow: 0 });
  const left = c.nostro ? [N("psp", 0, 0, c.pspName, "PSP clearing", "asset"), N("bank", 0, 0.5, c.bankName, "Bank (AED)", "asset"), N("nostro", 0, 1, "ICICI nostro (INR)", "Nostro INR", "asset")] : [N("psp", 0, 0.12, c.pspName, "PSP clearing", "asset"), N("bank", 0, 0.75, c.bankName, "Bank a/c", "asset")];
  const mid = c.nostro ? [N("wallet", 1, 0.12, "Customer wallets", "Wallets", "liability"), N("fx", 1, 0.75, "FX positions", "FX positions", "equity")] : [N("wallet", 1, 0.12, "Customer wallets", "Wallets", "liability"), N("merchant", 1, 0.75, "Merchant payables", "Merchants", "liability")];
  const right = [N("revenue", 2, 0, c.nostro ? "Remittance fees" : "MDR fee revenue", "Revenue", "revenue"), N("psp-fees", 2, 0.333, "PSP fees", "PSP fees", "expense"), N("bank-charges", 2, 0.667, "Bank charges", "Bank chg", "expense"), N("equity", 2, 1, "Share capital", "Capital", "equity")];
  const nodes = Object.fromEntries([...left, ...mid, ...right].map((n) => [n.key, n]));
  for (const n of Object.values(nodes)) n.accts = Lg.accounts(id).filter((a) => GROUP(a.code) === n.key);
  return nodes;
}
let NODES = nodesFor(T);
const FLOWS = { topup: [["psp", "wallet"]], pay: [["wallet", "merchant"], ["wallet", "revenue"]], p2p: [["wallet", "wallet"]], payout: [["merchant", "bank"]], withdraw: [["wallet", "bank"]], settlement: [["psp", "bank"], ["psp", "psp-fees"]], refund: [["merchant", "wallet"]], remit: [["wallet", "fx"], ["fx", "nostro"], ["wallet", "revenue"]], charge: [["bank", "bank-charges"]], writeoff: [["psp", "psp-fees"]], return: [["bank", "merchant"]], capital: [["equity", "bank"]] };

// ---------- per-tenant counters + animation state ----------
const C = Object.fromEntries(TENANTS.map((t) => [t.id, { journals: 0, vol: 0, replays: 0, rejected: 0, s: { p: 0, r: 0, x: 0 } }]));
let parts = [], marks = [], latest = {}, pinned = null, audit = Object.fromEntries(TENANTS.map((t) => [t.id, { ok: true, checked: 0, at: null }])), tampered = null, chainShift = 0, warm = true;
const groupOf = (code) => GROUP(code);
Lg.on((ev) => {
  const c = C[ev.tenant]; if (!c) return;
  if (ev.type === "posted") { const j = ev.journal; c.journals++; c.s.p++; c.vol += j.entries.filter((e) => e.side === "dr" && e.currency === P.cfg[ev.tenant].currency).reduce((s, e) => s + e.amount, 0); latest[ev.tenant] = j; if (ev.tenant === T) { chainShift = 1; animate(j); } }
  else if (ev.type === "replay") { c.replays++; c.s.r++; if (ev.tenant === T && !warm) { const n = NODES[groupOf(ev.journal.entries[0].account)]; if (n) marks.push({ node: n.key, t: 1, kind: "replay", text: "↺ replay" }); } }
  else if (ev.type === "rejected") { c.rejected++; c.s.x++; if (ev.tenant === T && !warm) { const acct = ev.error.account || ev.req?.account || ev.req?.entries?.[0]?.account || "wallet:"; const n = NODES[groupOf(acct)] || NODES.wallet; marks.push({ node: n.key, t: 1, kind: "reject", text: ev.error.code }); if (ev.error.code !== "INSUFFICIENT_FUNDS" || Math.random() < 0.5) LOG(`<span class="bad">${ev.error.code}</span> ${esc(ev.error.message)}`); } }
  else if (ev.type === "hold" && ev.tenant === T && !warm) marks.push({ node: "wallet", t: 1, kind: "hold", text: "hold " + short(ev.hold.amount) });
});
function animate(j) {
  if (warm) return; const kind = j.meta?.kind || (j.meta?.reverses ? "refund" : null), col = KIND_COL[kind] || MUTED;
  let pairs = FLOWS[kind]; if (!pairs) { const dr = j.entries.find((e) => e.side === "dr"), cr = j.entries.find((e) => e.side === "cr"); pairs = [[groupOf(dr.account), groupOf(cr.account)]]; }
  const amt = j.entries.filter((e) => e.side === "dr").reduce((s, e) => s + e.amount, 0);
  pairs.forEach(([a, b], i) => { if (!NODES[a] || !NODES[b]) return; parts.push({ a, b, t: -i * 0.18, col: i && kind !== "remit" ? hexA(col, 0.6) : col, amt: i ? 0 : amt, r: i ? 2.2 : 3 + Math.min(4, Math.log10(1 + amt / 10000)), off: (Math.random() - 0.5) * 0.5 }); NODES[a].glow = 1; });
  if (parts.length > 400) parts.splice(0, parts.length - 400);
}

// ---------- KPIs + charts ----------
const kp = new Kpis($("#kpis"), [
  { key: "j", label: "Journals", tone: "acc", fmt: (v) => Math.round(v).toLocaleString("en-IN") }, { key: "vol", label: "Volume", fmt: (v) => short(v) },
  { key: "rp", label: "Replays", fmt: (v) => Math.round(v).toLocaleString("en-IN") }, { key: "rj", label: "Rejected", fmt: (v) => Math.round(v).toLocaleString("en-IN") },
  { key: "tb", label: "Trial bal Δ", fmt: (v) => money(Math.round(v)) }, { key: "chain", label: "Hash chain" },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "posted", color: "--accent" }, { label: "replayed", color: ACC2 }, { label: "rejected", color: BAD }], points: 90, area: true, fmtY: (v) => v.toFixed(0) });
const ch2 = new Chart($("#ch2"), { series: [{ label: "cash (bank + PSP)", color: OK }, { label: "owed to users", color: ACC2 }], points: 90, min: 0, area: false, fmtY: (v) => short(v) });
const hist = Object.fromEntries(TENANTS.map((t) => [t.id, { a: [[], [], []], b: [[], []] }]));
const sum = (codes) => codes.reduce((s, a) => s + a.balance, 0);
function sample() {
  for (const t of TENANTS) {
    const c = C[t.id], h = hist[t.id], acc = Lg.accounts(t.id), cash = sum(acc.filter((a) => (a.code.startsWith("bank:") || a.code.startsWith("psp:")) && a.currency === t.currency)), owed = sum(acc.filter((a) => a.type === "liability"));
    for (const [i, v] of [c.s.p, c.s.r, c.s.x].entries()) { h.a[i].push(v); if (h.a[i].length > 90) h.a[i].shift(); } for (const [i, v] of [cash, owed].entries()) { h.b[i].push(v); if (h.b[i].length > 90) h.b[i].shift(); }
    c.s = { p: 0, r: 0, x: 0 };
  }
}
function paintCharts() { ch1.set(hist[T].a); ch2.set(hist[T].b); const bs = Lg.balanceSheet(T)[cur()]; $("#eqp").textContent = `A = L + E + P ${bs.ok ? "✓" : "✗"}`; $("#eqp").className = "pill " + (bs.ok ? "ok" : "bad"); }

// ---------- tenant switch ----------
$("#ten").innerHTML = TENANTS.map((t) => `<option value="${t.id}">${esc(t.name)} · ${t.currency}</option>`).join("");
$("#ten").onchange = () => { T = $("#ten").value; NODES = nodesFor(T); parts = []; marks = []; pinned = null; fillForm(); renderAll(); paintCharts(); draw(); LOG(`<span class="acc">TENANT</span> ${esc(cfg().name)} <span class="dim">separate accounts, balances, idempotency keys and hash chain</span>`); };

// ---------- inspector ----------
function inspect(j, pin = false) {
  const el = $("#insp"); if (!j) { el.innerHTML = `<div class="empty">Waiting for the first journal…</div>`; return; }
  const kind = j.meta?.kind || (j.meta?.reverses ? "refund" : "manual");
  const rows = j.entries.map((e) => `<tr><td>${esc(e.account)}</td><td class="n">${e.side === "dr" ? fmtMoney(e.amount, e.currency) : ""}</td><td class="n">${e.side === "cr" ? fmtMoney(e.amount, e.currency) : ""}</td></tr>`).join("");
  const bad = audit[T].at === j.seq && !audit[T].ok;
  el.innerHTML = `<div class="hd"><span class="k" style="color:${KIND_COL[kind] || MUTED};background:${hexA(KIND_COL[kind] || MUTED, 0.14)}">${esc(kind)}</span><b>${esc(j.id)}</b><span class="dim">${new Date(Date.UTC(2026, 9, 26, 4, 30) + j.at + 19800e3).toISOString().slice(11, 19)}</span></div>
    <div class="memo">${esc(j.memo || "")}${j.ref ? ` <span class="dim">· ref ${esc(j.ref)}</span>` : ""}${j.reversedBy ? ` <span class="warn">· reversed by ${esc(j.reversedBy)}</span>` : ""}</div>
    <table><thead><tr><th>account</th><th class="n">debit</th><th class="n">credit</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>${j.entries.length} legs ${new Set(j.entries.map((e) => e.currency)).size > 1 ? "· multi-currency" : ""}</td><td class="n" colspan="2">balanced ✓</td></tr></tfoot></table>
    <div class="hash"><span>key</span><b>${esc(j.key || "—")}</b><span>prev</span><b>${j.prev.slice(0, 20)}…</b><span>hash</span><b class="${bad ? "bad" : ""}">${j.hash.slice(0, 20)}… ${bad ? "✗ mismatch" : ""}</b></div>`;
  $("#insw").textContent = pin ? "pinned · click to unpin" : "latest";
}
$("#insw").onclick = () => { pinned = null; inspect(latest[T]); };

// ---------- post a transfer ----------
const newKey = () => ($("#key").value = "ui_" + Math.random().toString(36).slice(2, 10));
function fillForm(fresh = true) {
  const ws = Lg.accounts(T, { prefix: "wallet:" }).slice(0, 14), o = ws.map((a) => `<option value="${a.code}">${a.code} · ${short(a.balance - a.pending)}</option>`).join("");
  const f = $("#from").value, t = $("#to").value; $("#from").innerHTML = o; $("#to").innerHTML = o; $("#from").value = ws.some((a) => a.code === f) ? f : ws[0].code; $("#to").value = ws.some((a) => a.code === t) && t !== $("#from").value ? t : ws[1].code; if (fresh) newKey();
}
function send() {
  const out = $("#tres"), from = $("#from").value, to = $("#to").value;
  try {
    if (from === to) throw new LedgerError("BAD_REQUEST", "from and to must differ");
    const amount = toMinor($("#amt").value, cur()), r = Lg.post(T, { key: $("#key").value, memo: "Manual transfer (UI)", entries: [{ account: from, side: "dr", amount }, { account: to, side: "cr", amount }], meta: { kind: "p2p" } });
    out.innerHTML = r.replay ? `<span class="code acc">200</span> replayed <b>${r.journal.id}</b> <span class="dim">· same key, nothing posted twice</span>` : `<span class="code ok">201</span> posted <b>${r.journal.id}</b> <span class="dim">· ${money(amount)} · hash ${r.journal.hash.slice(0, 10)}…</span>`;
    if (r.replay) marks.push({ node: "wallet", t: 1, kind: "replay", text: "↺ replay" }); pinned = r.journal; inspect(r.journal, true);
    LOG(r.replay ? `<span class="acc">REPLAY</span> ${esc($("#key").value)} returned ${r.journal.id} <span class="dim">no double charge</span>` : `<span class="ok">POSTED</span> ${money(amount)} ${esc(from)} → ${esc(to)} <span class="dim">${r.journal.id}</span>`);
  } catch (e) {
    const st = e.status || 400; out.innerHTML = `<span class="code bad">${st}</span> <b>${esc(e.code || "ERROR")}</b> <span class="dim">${esc(e.message)}</span>`;
    if (e.code === "IDEMPOTENCY_CONFLICT") toast("Same key, different body: change the key with New key");
  }
  fillForm(false);
}
$("#send").onclick = () => send();
$("#again").onclick = () => send();
$("#nkey").onclick = () => { newKey(); $("#tres").innerHTML = `<span class="dim">new key: the next Send is a new request</span>`; };

// ---------- reconciliation + trial balance panels ----------
function renderRecon() {
  const R = P.recon[T], s = R.stats, tot = s.matched + R.breaks.filter((b) => b.side === "bank").length, pct = tot ? s.matched / tot : 1;
  const types = Object.entries(s.byType).map(([k, v]) => `<span class="t">${esc(k)} <b>${v.toLocaleString("en-IN")}</b></span>`).join("");
  const open = R.breaks.filter((b) => b.status === "open").slice(-6).reverse();
  const fixLabel = (b) => (b.side === "bank" && b.amount < 0 ? "Book" : b.side === "ledger" && b.amount > 0 ? "Claim" : b.side === "ledger" ? "Return" : "");
  $("#recon").innerHTML = `<div class="mbar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
    <div class="rs"><span><b>${(pct * 100).toFixed(1)}%</b> bank lines matched</span><span class="dim">fees ${short(s.fees)} · pending ${R.ledger.length}/${R.bank.length}</span></div>
    <div class="types">${types}</div>
    <div class="brk">${open.length ? open.map((b) => `<div class="row"><div class="m"><span class="${b.side === "bank" ? "warn" : "bad"}">${esc(b.reason)}</span><small>${esc(b.id)} · ${money(b.amount)}${b.desc ? " · " + esc(b.desc) : ""}</small></div>${fixLabel(b) ? `<button class="btn sm x" data-fix="${esc(b.id)}">${fixLabel(b)}</button>` : ""}</div>`).join("") : `<div class="empty">No open breaks. Every bank line agrees with the books.</div>`}</div>`;
  $("#rcp").textContent = `${R.breaks.filter((b) => b.status === "open").length} open breaks`;
}
$("#recon").onclick = (e) => { const b = e.target.closest("[data-fix]"); if (!b) return; const out = [], br = P.fixBreak(T, b.dataset.fix, out); const j = out.find((x) => x.journal)?.journal; if (br && j) { LOG(`<span class="ok">FIXED</span> ${esc(br.reason)} ${money(br.amount)} <span class="dim">posted ${j.id}: ${esc(j.memo)}</span>`); pinned = j; inspect(j, true); } renderRecon(); renderTB(); };
function renderTB() {
  const tb = Lg.trialBalance(T), by = {}; for (const r of tb.rows) { if (r.currency !== cur()) continue; const g = (by[r.type] ||= { dr: 0, cr: 0, n: 0 }); g.dr += r.dr; g.cr += r.cr; g.n++; }
  const t = tb.totals[cur()], order = ["asset", "liability", "equity", "revenue", "expense"];
  $("#tb").innerHTML = `<table><thead><tr><th>type</th><th class="n">debit</th><th class="n">credit</th></tr></thead><tbody>${order.filter((k) => by[k]).map((k) => `<tr><td><i style="background:${TYPE_COL[k]}"></i>${k} <span class="dim">${by[k].n}</span></td><td class="n">${by[k].dr ? short(by[k].dr) : ""}</td><td class="n">${by[k].cr ? short(by[k].cr) : ""}</td></tr>`).join("")}</tbody><tfoot><tr><td>total</td><td class="n">${money(t.dr)}</td><td class="n">${money(t.cr)}</td></tr></tfoot></table>`;
  $("#tbp").textContent = tb.balanced ? "balanced ✓" : "UNBALANCED"; $("#tbp").className = "pill " + (tb.balanced ? "ok" : "bad");
}
function renderAll() { renderRecon(); renderTB(); inspect(pinned || latest[T], !!pinned); }

// ---------- scenarios ----------
$("#storm").onclick = () => { const out = P.retryStorm(T, 48), n = out.filter((x) => x.journal).length; LOG(`<span class="acc">RETRY STORM</span> ${n} top-ups, each resent 3× over a flaky network <span class="dim">watch Replays climb while balances move once</span>`); toast("Every retry carries the same Idempotency-Key"); };
$("#race").onclick = () => { const out = P.race(T), [a, b] = out; if (!a) return toast("No wallet with enough balance"); LOG(`<span class="acc">RACE</span> two withdrawals of ${money(a.hold?.amount || 0)} hit ${esc(a.hold?.account || "")} at once <span class="dim">A: ${a.hold ? "held" : a.error?.code} · B: ${b?.hold ? "held" : esc(b?.error?.code || "")}</span>`); toast("Only one can reserve the funds"); };
$("#over").onclick = () => { const out = P.overdraft(T); const e = out[0]?.error; if (e) LOG(`<span class="bad">BLOCKED</span> overdraft attempt <span class="dim">${esc(e.message)}</span>`); };
function runAudit(quiet) {
  const t0 = performance.now(), v = Lg.verify(T), ms = performance.now() - t0; audit[T] = { ok: v.ok, checked: v.checked, at: v.at ?? null, reason: v.reason, checkedTo: v.ok ? Lg.tenant(T).journals.length : undefined };
  if (!quiet) LOG(v.ok ? `<span class="ok">AUDIT</span> ${v.checked.toLocaleString("en-IN")} journals re-hashed and re-summed in ${ms.toFixed(0)} ms <span class="dim">head ${v.head.slice(0, 16)}…</span>` : `<span class="bad">AUDIT FAILED</span> journal #${v.at}: ${esc(v.reason)} <span class="dim">${ms.toFixed(0)} ms</span>`);
  return v;
}
$("#audit").onclick = () => { const v = runAudit(); toast(v.ok ? "Chain intact, balances match the journals" : "Tampering detected at journal #" + v.at); renderAll(); };
$("#tamper").onclick = () => {
  const js = Lg.tenant(T).journals;
  if (tampered) { tampered.e.amount = tampered.orig; LOG(`<span class="acc">RESTORED</span> journal #${tampered.j.seq} put back`); tampered = null; $("#tamper").textContent = "Tamper a journal"; runAudit(); renderAll(); return; }
  const j = js[js.length - 4], e = j.entries[0]; tampered = { j, e, orig: e.amount, tenant: T }; e.amount += 100000;
  LOG(`<span class="bad">TAMPER</span> someone ran UPDATE on journal #${j.seq}: ${esc(e.account)} ${money(tampered.orig)} → ${money(e.amount)} <span class="dim">balances untouched, hash not recomputed</span>`);
  $("#tamper").textContent = "Undo tamper"; setTimeout(() => { runAudit(); pinned = j; renderAll(); }, 700);
};

// ---------- drawing ----------
function layout(w, H) {
  const narrow = w < 640, top = 44, chainH = narrow ? 64 : 76, bot = H - chainH - 34, nw = Math.min(190, (w - 40) * (narrow ? 0.3 : 0.24)), nh = narrow ? 50 : 56;
  const cols = [16 + nw / 2, w / 2, w - 16 - nw / 2], pos = {};
  for (const n of Object.values(NODES)) pos[n.key] = [cols[n.col], top + nh / 2 + n.row * (bot - top - nh)];
  return { narrow, top, bot, nw, nh, pos, chainY: H - chainH - 16, chainH, w };
}
let LY = null, blocks = [];
function curve(a, b, off) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1]; return [mx - dy * (0.12 + off * 0.2), my + dx * (0.12 + off * 0.2)]; }
function qpt(a, c, b, t) { const u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]; }
function draw(dt = 0) {
  const { ctx, w, h: H } = fit($("#flow")); ctx.clearRect(0, 0, w, H); LY = layout(w, H); const { pos, nw, nh, narrow } = LY;
  // static edges
  ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.07)";
  const seen = new Set(); for (const fl of Object.values(FLOWS)) for (const [a, b] of fl) { const k = a + b; if (seen.has(k) || a === b || !pos[a] || !pos[b]) continue; seen.add(k); const c = curve(pos[a], pos[b], 0); ctx.beginPath(); ctx.moveTo(...pos[a]); ctx.quadraticCurveTo(...c, ...pos[b]); ctx.stroke(); }
  ctx.setLineDash([]);
  // column headings
  ctx.font = `600 9.5px ${mono}`; ctx.textAlign = "center"; ctx.fillStyle = MUTED; const heads = narrow ? ["ASSETS", "OWED", "P&L · EQUITY"] : ["ASSETS · cash we hold", cfg().nostro ? "LIABILITIES · FX" : "LIABILITIES · money we owe", "P&L · EQUITY"];
  [16 + nw / 2, w / 2, w - 16 - nw / 2].forEach((x, i) => ctx.fillText(heads[i], x, LY.top - 8 + 0));
  // particles
  for (const p of parts) p.t += dt / 0.9; parts = parts.filter((p) => p.t < 1);
  for (const p of parts) {
    if (p.t < 0) continue; const a = pos[p.a], b = pos[p.b];
    if (p.a === p.b) { const an = p.t * Math.PI * 2, x = a[0] + Math.cos(an - Math.PI / 2) * (nw / 2 + 8) * 0.55, y = a[1] - nh / 2 - 14 + Math.sin(an - Math.PI / 2) * 12; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(x, y, p.r * 0.8, 0, 7); ctx.fill(); continue; }
    const c = curve(a, b, p.off); for (let k = 0; k < 5; k++) { const tt = Math.max(0, p.t - k * 0.03), q = qpt(a, c, b, tt); ctx.fillStyle = hexA(p.col.startsWith("#") ? p.col : OK, (1 - k / 5) * 0.55); ctx.beginPath(); ctx.arc(q[0], q[1], p.r * (1 - k * 0.15), 0, 7); ctx.fill(); }
    const q = qpt(a, c, b, p.t); ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(q[0], q[1], p.r, 0, 7); ctx.fill();
    if (p.amt >= (cur() === "AED" ? 200000 : 500000) && !narrow) { ctx.font = `600 9.5px ${mono}`; ctx.textAlign = "center"; ctx.fillStyle = hexA(TEXT, 0.85); ctx.fillText(short(p.amt), q[0], q[1] - 9); }
  }
  // nodes
  for (const n of Object.values(NODES)) {
    const [x, y] = pos[n.key], col = TYPE_COL[n.type]; n.glow = Math.max(0, n.glow - dt * 1.6);
    const curN = n.accts[0]?.currency || cur(), bal = n.accts.reduce((s, a) => s + (a.currency === curN ? a.balance : 0), 0), pend = n.accts.reduce((s, a) => s + a.pending, 0);
    ctx.save(); ctx.shadowColor = hexA(col, 0.25 + n.glow * 0.5); ctx.shadowBlur = 8 + n.glow * 18; ctx.fillStyle = "rgba(14,18,32,.92)"; ctx.strokeStyle = hexA(col, 0.35 + n.glow * 0.5); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.roundRect(x - nw / 2, y - nh / 2, nw, nh, 10); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.fillStyle = col; ctx.fillRect(x - nw / 2 + 10, y - nh / 2 + 10, 3, nh - 20);
    ctx.textAlign = "left"; ctx.font = `600 ${narrow ? 10 : 11}px Inter, system-ui, sans-serif`; ctx.fillStyle = TEXT; const label = narrow || ctx.measureText(n.label).width > nw - 30 ? n.short : n.label; ctx.fillText(label, x - nw / 2 + 20, y - nh / 2 + (narrow ? 17 : 19));
    ctx.font = `600 ${narrow ? 11 : 13}px ${mono}`; ctx.fillStyle = hexA(TEXT, 0.95); ctx.fillText(short(bal, curN), x - nw / 2 + 20, y + (narrow ? 9 : 10));
    ctx.font = `500 9px ${mono}`; ctx.fillStyle = MUTED; const sub = (n.accts.length > 1 ? `${n.accts.length} a/c` : n.type) + (pend ? ` · ${short(pend, curN)} held` : ""); if (!narrow || nw > 100) ctx.fillText(sub, x - nw / 2 + 20, y + nh / 2 - 8);
  }
  // marks (replay / reject / hold)
  for (const m of marks) m.t -= dt / 1.6; marks = marks.filter((m) => m.t > 0); const stack = {};
  for (const m of marks) {
    const p = pos[m.node]; if (!p) continue; const k = (stack[m.node] = (stack[m.node] || 0) + 1); if (k > 3) continue; const col = m.kind === "reject" ? BAD : m.kind === "hold" ? WARN : ACC2;
    const n = NODES[m.node], right = n.col < 2, x = right ? p[0] + nw / 2 + 6 : p[0] - nw / 2 - 6, y = p[1] - nh / 2 + 8 + (k - 1) * 17 + (1 - m.t) * 4;
    ctx.globalAlpha = Math.min(1, m.t * 2); ctx.font = `700 9.5px ${mono}`; const txt = (m.kind === "reject" ? "✗ " : "") + (LY.narrow ? m.text.replace("INSUFFICIENT_FUNDS", "NSF").replace("IDEMPOTENCY_CONFLICT", "409") : m.text), tw = ctx.measureText(txt).width; let bx = right ? x : x - tw - 12, yy = y;
    if (LY.narrow) { bx = Math.max(2, Math.min(LY.w - tw - 14, p[0] - tw / 2 - 6)); yy = p[1] + nh / 2 + 12 + (k - 1) * 17; }
    ctx.fillStyle = hexA(col, 0.16); ctx.beginPath(); ctx.roundRect(bx, yy - 9, tw + 12, 16, 8); ctx.fill(); ctx.fillStyle = col; ctx.textAlign = "left"; ctx.fillText(txt, bx + 6, yy + 3); ctx.globalAlpha = 1;
  }
  // hash chain strip
  const js = Lg.tenant(T).journals, bw = narrow ? 64 : 82, gap = narrow ? 10 : 14, n = Math.max(3, Math.floor((w - 28 + gap) / (bw + gap))), y0 = LY.chainY, bh = LY.chainH - 22;
  chainShift = Math.max(0, chainShift - dt * 4); const xs = 14 + chainShift * (bw + gap) * 0.4; blocks = [];
  ctx.font = `600 9.5px ${mono}`; ctx.textAlign = "left"; ctx.fillStyle = MUTED; ctx.fillText(`SHA-256 CHAIN · ${cfg().name.toUpperCase()} · ${audit[T].ok ? "verified" : "BROKEN AT #" + audit[T].at}`, 14, y0 - 6);
  const start = Math.max(0, js.length - n);
  for (let i = start; i < js.length; i++) {
    const j = js[i], x = xs + (i - start) * (bw + gap), bad = !audit[T].ok && audit[T].at === j.seq, after = !audit[T].ok && audit[T].at != null && j.seq > audit[T].at, kc = KIND_COL[j.meta?.kind] || MUTED, sel = pinned && pinned.id === j.id;
    if (x + bw > w - 8) break;
    if (i > start) { ctx.strokeStyle = bad || after ? hexA(BAD, 0.6) : "rgba(255,255,255,.18)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - gap, y0 + bh / 2); ctx.lineTo(x, y0 + bh / 2); ctx.stroke(); }
    ctx.fillStyle = bad ? hexA(BAD, 0.18) : "rgba(16,20,36,.95)"; ctx.strokeStyle = bad ? BAD : sel ? TEXT : after ? hexA(BAD, 0.35) : "rgba(255,255,255,.12)"; ctx.lineWidth = bad || sel ? 1.6 : 1;
    ctx.beginPath(); ctx.roundRect(x, y0, bw, bh, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = kc; ctx.fillRect(x + 6, y0 + 4, bw - 12, 2);
    ctx.font = `700 ${narrow ? 9 : 10}px ${mono}`; ctx.fillStyle = bad ? BAD : TEXT; ctx.fillText("#" + j.seq, x + 7, y0 + bh / 2 + 1);
    ctx.font = `500 ${narrow ? 8.5 : 9}px ${mono}`; ctx.fillStyle = bad ? BAD : MUTED; ctx.fillText(bad ? "✗ hash" : j.hash.slice(0, narrow ? 6 : 8), x + 7, y0 + bh - 6);
    blocks.push({ x, y: y0, w: bw, h: bh, j });
  }
  // legend
  const items = [["● asset", OK], ["● liability", ACC2], ["● revenue", ACC], ["● expense", WARN], ["● equity", "#c084fc"]]; let lx = 14; ctx.font = `500 10px ${mono}`; ctx.textAlign = "left";
  for (const [t, c] of items) { ctx.fillStyle = c; ctx.fillText(t, lx, H - 10); lx += ctx.measureText(t).width + 12; if (lx > w - 70) break; }
}
$("#flow").addEventListener("click", (e) => { const r = $("#flow").getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, b = blocks.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h); if (b) { pinned = b.j; inspect(b.j, true); } });

// ---------- loop ----------
let acc = 0, rAcc = 0, uiAcc = 0;
function tick(dt, ui = true) {
  P.step(dt); acc += dt; rAcc += dt; uiAcc += dt;
  if (rAcc >= 5) { rAcc = 0; for (const t of TENANTS) { const before = P.recon[t.id].breaks.length, { res } = P.reconcile(t.id); const batches = res.matches.filter((m) => m.type === "settlement batch"); if (ui && t.id === T) { for (const m of batches) LOG(`<span class="ok">RECON</span> ${m.bank[0]} = ${m.ledger.length} top-ups net of ${short(-m.diff)} PSP fee <span class="dim">settlement journal posted</span>`); for (const b of P.recon[t.id].breaks.slice(before)) LOG(`<span class="warn">BREAK</span> ${esc(b.reason)} ${money(b.amount)} <span class="dim">${esc(b.id)}${b.desc ? " · " + esc(b.desc) : ""}</span>`); } } }
  if (acc >= 1) {
    acc = 0; sample(); const c = C[T];
    if (ui) {
      const tb = Lg.trialBalance(T).totals[cur()]; if (audit[T].ok) { const v = Lg.verify(T, { fromSeq: Math.max(1, audit[T].checkedTo || 1) }); if (!v.ok) audit[T] = { ok: false, at: v.at, reason: v.reason }; else audit[T].checkedTo = Lg.tenant(T).journals.length; }
      kp.set({ j: c.journals, vol: c.vol, rp: c.replays, rj: c.rejected, tb: Math.abs(tb.dr - tb.cr), chain: audit[T].ok ? "Intact" : "Broken" }); kp.tone("chain", audit[T].ok ? "ok" : "bad"); kp.tone("tb", tb.dr === tb.cr ? "ok" : "bad");
      paintCharts(); $("#clock").textContent = `${clock()} IST · ${cfg().name} · ${Lg.tenant(T).journals.length.toLocaleString("en-IN")} journals`;
    }
  }
  if (ui && uiAcc >= 0.7) { uiAcc = 0; renderRecon(); renderTB(); if (!pinned) inspect(latest[T]); }
}
for (let i = 0; i < 1500; i++) tick(0.1, false); // prewarm 150 s: settlements, reconciliation runs and a few breaks
warm = false; for (const t of TENANTS) audit[t.id].checkedTo = Lg.tenant(t.id).journals.length;
fillForm(); renderAll(); paintCharts(); log.clear();
LOG(`<span class="acc">LIVE</span> ${TENANTS.length} tenants on one ledger · ${Lg.accounts(T).length + Lg.accounts(TENANTS[1].id).length + Lg.accounts(TENANTS[2].id).length} accounts <span class="dim">PSP settles every ${P.settleEvery}s net of 1.5% · reconciliation every 5 s</span>`);
const loop = new Loop((dt) => { tick(dt); draw(dt); });
bindLoop(loop, $("#sim")); draw(); loop.start();
setTimeout(() => $("#storm").click(), 1500);
setTimeout(() => $("#race").click(), 4500);
setTimeout(() => $("#over").click(), 6500);
addEventListener("resize", () => { draw(); paintCharts(); });
