// Bank reconciliation: match ledger-expected cash movements to bank statement lines.
// Passes run from most to least certain: reference, amount+date, fee-adjusted, then
// many-to-one settlement batches (bounded subset sum). Whatever is left is a break.
import { bps } from "./money.js";
const DAY = 86400e3;

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). Returns objects keyed by the header row. */
export function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows; return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/**
 * Find a subset of `items` (each with .amount) whose sum lies in [lo, hi]. Dynamic programming over
 * reachable sums, capped at `cap` states so the worst case stays bounded. Prefers fewer items.
 */
export function subsetSum(items, lo, hi, { cap = 20000, maxItems = 24 } = {}) {
  const xs = items.slice(0, maxItems); let reach = new Map([[0, []]]);
  for (let i = 0; i < xs.length; i++) {
    const nx = new Map(reach);
    for (const [s, idx] of reach) { const v = s + xs[i].amount; if (v > hi && xs[i].amount > 0) continue; if (!nx.has(v) || nx.get(v).length > idx.length + 1) nx.set(v, [...idx, i]); }
    reach = nx; if (reach.size > cap) reach = new Map([...reach].sort((a, b) => Math.abs(a[0] - (lo + hi) / 2) - Math.abs(b[0] - (lo + hi) / 2)).slice(0, cap));
    for (const [s, idx] of reach) if (idx.length > 1 && s >= lo && s <= hi) return idx.map((k) => xs[k]);
  }
  return null;
}

/**
 * @param ledger  [{ id, at (ms), amount (signed minor units, + = cash in), ref? }]
 * @param bank    [{ id, at (ms), amount (signed minor units), ref?, desc? }]
 * @param opts    dateTol (ms), feeBps (max fee a processor may deduct, one-to-one), settlementBps (exact processor
 *                 fee on batches; makes batch targets exact), batch (enable many-to-one)
 */
export function reconcile(ledger, bank, { dateTol = 3 * DAY, feeBps = 300, settlementBps = null, batch = true } = {}) {
  const L = ledger.map((x) => ({ ...x })), B = bank.map((x) => ({ ...x })), matches = [], used = new Set(), usedB = new Set();
  const take = (type, b, ls, note) => { for (const l of ls) used.add(l.id); for (const x of [].concat(b)) usedB.add(x.id); const lsum = ls.reduce((s, l) => s + l.amount, 0), bsum = [].concat(b).reduce((s, x) => s + x.amount, 0); matches.push({ type, bank: [].concat(b).map((x) => x.id), ledger: ls.map((l) => l.id), diff: bsum - lsum, note }); };
  // 1. reference
  const byRef = new Map(); for (const l of L) if (l.ref) (byRef.get(l.ref) || byRef.set(l.ref, []).get(l.ref)).push(l);
  for (const b of B) { if (!b.ref) continue; const c = (byRef.get(b.ref) || []).find((l) => !used.has(l.id) && l.amount === b.amount); if (c) take("reference", b, [c]); }
  // 2. exact amount, closest date inside the tolerance
  const byAmt = new Map(); for (const l of L) (byAmt.get(l.amount) || byAmt.set(l.amount, []).get(l.amount)).push(l);
  for (const b of B) { if (usedB.has(b.id)) continue; let best = null; for (const l of byAmt.get(b.amount) || []) { if (used.has(l.id)) continue; const d = Math.abs(l.at - b.at); if (d <= dateTol && (!best || d < best.d)) best = { l, d }; } if (best) take("amount+date", b, [best.l]); }
  // 3. one-to-one with a processor fee deducted (bank received slightly less than expected)
  for (const b of B) { if (usedB.has(b.id) || b.amount <= 0) continue; let best = null; for (const l of L) { if (used.has(l.id) || l.amount <= 0 || Math.abs(l.at - b.at) > dateTol) continue; const fee = l.amount - b.amount; if (fee > 0 && (settlementBps != null ? fee === bps(l.amount, settlementBps) : fee * 10000 <= l.amount * feeBps) && (!best || fee < best.fee)) best = { l, fee }; } if (best) take("net of fee", b, [best.l], `fee ${best.fee}`); }
  // 4. many-to-one settlement batches: bank line = sum(ledger items) − fee
  if (batch) for (const b of B) {
    if (usedB.has(b.id) || b.amount <= 0) continue;
    const cand = L.filter((l) => !used.has(l.id) && l.amount > 0 && l.at <= b.at + DAY && b.at - l.at <= dateTol).sort((x, y) => y.at - x.at);
    let targets;
    if (settlementBps != null) { const g = Math.round((b.amount * 10000) / (10000 - settlementBps)); targets = []; for (let S = g - 3; S <= g + 3; S++) if (S - bps(S, settlementBps) === b.amount) targets.push(S); }
    let pick = null;
    // contiguous run in time first: processors settle "everything up to the cut-off"
    const byT = cand.slice().sort((x, y) => x.at - y.at);
    const fits = (s) => (targets ? targets.includes(s) : s >= b.amount && s * (10000 - feeBps) <= b.amount * 10000);
    const amtIdx = new Map(); byT.forEach((l, i) => (amtIdx.get(l.amount) || amtIdx.set(l.amount, []).get(l.amount)).push(i));
    for (let i = 0; i < byT.length && !pick; i++) {
      let s = 0;
      for (let k = i; k < byT.length; k++) {
        s += byT[k].amount; if (k > i && fits(s)) { pick = byT.slice(i, k + 1); break; }
        // the same run with exactly one item the processor left out (it becomes a break)
        if (targets && k > i + 1) for (const S of targets) { const miss = (amtIdx.get(s - S) || []).find((x) => x > i && x < k); if (miss != null) { pick = byT.slice(i, k + 1).filter((_, q) => q !== miss - i); break; } }
        if (pick || s > b.amount * 2) break;
      }
    }
    if (!pick) pick = targets ? targets.reduce((p, S) => p || subsetSum(cand, S, S), null) : subsetSum(cand, b.amount, Math.floor((b.amount * 10000) / (10000 - feeBps)));
    if (pick) take("settlement batch", b, pick, `${pick.length} items, fee ${pick.reduce((s, l) => s + l.amount, 0) - b.amount}`);
  }
  const unmatchedLedger = L.filter((l) => !used.has(l.id)), unmatchedBank = B.filter((b) => !usedB.has(b.id));
  const breaks = [
    ...unmatchedBank.map((b) => ({ side: "bank", id: b.id, at: b.at, amount: b.amount, desc: b.desc, reason: b.amount < 0 ? (/charge|fee|gst/i.test(b.desc || "") ? "bank charge not booked" : "unexpected debit") : /return|reversal|failed/i.test(b.desc || "") ? "returned payment" : "unidentified credit" })),
    ...unmatchedLedger.map((l) => ({ side: "ledger", id: l.id, at: l.at, amount: l.amount, ref: l.ref, reason: l.amount > 0 ? "expected funds not received" : "payout not cleared" })),
  ];
  const n = L.length + B.length, m = used.size + usedB.size, byType = {}; for (const x of matches) byType[x.type] = (byType[x.type] || 0) + 1;
  return { matches, breaks, unmatchedLedger, unmatchedBank, stats: { ledger: L.length, bank: B.length, matched: matches.length, matchedPct: n ? m / n : 1, byType, fees: matches.reduce((s, x) => s - Math.min(0, x.diff), 0) } };
}
