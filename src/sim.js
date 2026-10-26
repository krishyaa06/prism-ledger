// A synthetic payments platform running on the ledger: three tenants (two INR wallets and an
// AED→INR remittance app), customers, merchants, a PSP that settles in net batches, a bank
// statement with charges and occasional anomalies, network retries and overdraft attempts.
import { Ledger, LedgerError } from "./ledger.js";
import { bps } from "./money.js";
import { reconcile } from "./recon.js";
import { rng } from "./lib/rng.js";

export const TENANTS = [
  { id: "kirana-pay", name: "Kirana Pay", currency: "INR", bank: "bank:hdfc", bankName: "HDFC current a/c", psp: "psp:razorpay", pspName: "Razorpay clearing", customers: 80, merchants: 14, avg: 600, mdr: 200, capital: 25e5 },
  { id: "campus-wallet", name: "Campus Wallet", currency: "INR", bank: "bank:sbi", bankName: "SBI current a/c", psp: "psp:cashfree", pspName: "Cashfree clearing", customers: 120, merchants: 8, avg: 180, mdr: 175, capital: 8e5 },
  { id: "gulf-remit", name: "Gulf Remit", currency: "AED", bank: "bank:enbd", bankName: "Emirates NBD a/c", psp: "psp:checkout", pspName: "Checkout.com clearing", customers: 50, merchants: 0, avg: 900, fee: 1500, rate: 22.71, capital: 5e5, nostro: 4e7 },
];
export const SETTLE_BPS = 150;          // PSP keeps 1.5% of each settlement batch
export const GROUP = (code) => code.split(":")[0] === "expense" ? (code.includes("psp") ? "psp-fees" : "bank-charges") : code.startsWith("fx:") ? "fx" : code.split(":")[0];

export class Platform {
  constructor({ seed = 7, rate = 14, settleEvery = 30, retryRate = 0.06, overdraftRate = 0.03, anomalies = true, reconTol = 90e3, stale = 3 * reconTol } = {}) {
    this.tol = reconTol; this.stale = stale;
    this.r = rng(seed); this.t = 0; this.rate = rate; this.settleEvery = settleEvery; this.retryRate = retryRate; this.overdraftRate = overdraftRate; this.anomalies = anomalies;
    this.L = new Ledger({ clock: () => Math.round(this.t * 1000) });
    this.cfg = Object.fromEntries(TENANTS.map((c) => [c.id, c])); this.n = 0; this.retries = []; this.holds = []; this.lastPays = {};
    this.recon = {}; this.unsettled = {}; this.lastSettle = {}; this.bankPending = []; this.truth = { missing: 0, charges: 0, returned: 0 };
    for (const c of TENANTS) this.setup(c);
  }
  setup(c) {
    const L = this.L, id = c.id, cur = c.currency; L.createTenant(id, { name: c.name, currency: cur });
    L.openAccount(id, { code: c.bank, name: c.bankName, type: "asset" }); L.openAccount(id, { code: c.psp, name: c.pspName, type: "asset" });
    L.openAccount(id, { code: "equity:capital", name: "Share capital", type: "equity" });
    L.openAccount(id, { code: "expense:psp-fees", name: "Payment processing fees", type: "expense" }); L.openAccount(id, { code: "expense:bank-charges", name: "Bank charges", type: "expense" });
    for (let i = 1; i <= c.customers; i++) L.openAccount(id, { code: `wallet:c${String(i).padStart(3, "0")}`, name: `Customer ${i}`, type: "liability" });
    for (let i = 1; i <= c.merchants; i++) L.openAccount(id, { code: `merchant:m${String(i).padStart(2, "0")}`, name: `Merchant ${i}`, type: "liability" });
    if (c.merchants) L.openAccount(id, { code: "revenue:mdr", name: "Merchant discount fees", type: "revenue" });
    if (c.nostro) {
      L.openAccount(id, { code: "revenue:remit-fee", name: "Remittance fees", type: "revenue" });
      L.openAccount(id, { code: "bank:icici-nostro", name: "ICICI nostro (INR)", type: "asset", currency: "INR" });
      L.openAccount(id, { code: "equity:capital-inr", name: "Share capital (INR)", type: "equity", currency: "INR" });
      L.openAccount(id, { code: "fx:position-aed", name: "FX position AED", type: "equity", allowNegative: true });
      L.openAccount(id, { code: "fx:position-inr", name: "FX position INR", type: "equity", currency: "INR", allowNegative: true });
      L.post(id, { key: "init-nostro", memo: "Fund INR nostro", entries: [{ account: "bank:icici-nostro", side: "dr", amount: c.nostro * 100 }, { account: "equity:capital-inr", side: "cr", amount: c.nostro * 100 }], meta: { kind: "capital" } });
    }
    L.post(id, { key: "init-capital", memo: "Initial capital", entries: [{ account: c.bank, side: "dr", amount: c.capital * 100 }, { account: "equity:capital", side: "cr", amount: c.capital * 100 }], meta: { kind: "capital" } });
    // opening wallet balances, already settled by the PSP
    let gross = 0;
    for (const a of L.accounts(id, { prefix: "wallet:" })) { const amt = Math.round(c.avg * (2 + this.r() * 6)) * 100; gross += amt; L.post(id, { key: `open-${a.code}`, memo: "Opening top-up", entries: [{ account: c.psp, side: "dr", amount: amt }, { account: a.code, side: "cr", amount: amt }], meta: { kind: "topup" } }); }
    const fee = bps(gross, SETTLE_BPS); L.post(id, { key: "open-settle", memo: "Opening settlement", entries: [{ account: c.bank, side: "dr", amount: gross - fee }, { account: "expense:psp-fees", side: "dr", amount: fee }, { account: c.psp, side: "cr", amount: gross }], meta: { kind: "settlement" } });
    this.recon[id] = { ledger: [], bank: [], matches: [], breaks: [], stats: { matched: 0, ledger: 0, bank: 0, byType: {}, fees: 0 }, runs: 0 }; this.unsettled[id] = []; this.lastSettle[id] = 0; this.lastPays[id] = [];
  }
  // ---------- helpers ----------
  ri(n) { return Math.floor(this.r() * n); }
  poisson(lam) { if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * this.r.normal())); let k = 0, p = 1; const L = Math.exp(-lam); while ((p *= this.r()) > L) k++; return k; }
  amount(c, k = 1) { return Math.max(1, Math.round(Math.exp(Math.log(c.avg * k) + this.r.normal() * 0.7))) * 100; }
  wallet(c) { return `wallet:c${String(1 + this.ri(c.customers)).padStart(3, "0")}`; }
  merchant(c) { return `merchant:m${String(1 + this.ri(c.merchants)).padStart(2, "0")}`; }
  key() { return `req_${(++this.n).toString(36)}_${Math.floor(this.r() * 1e9).toString(36)}`; }
  /** Submit a request like a client would: may be retried with the same key over a flaky network. */
  submit(id, req, out, { retry = this.r.chance(this.retryRate) } = {}) {
    try { const res = this.L.post(id, req); out.push({ tenant: id, kind: req.meta?.kind, journal: res.journal, replay: res.replay }); if (retry) this.retries.push({ at: this.t + 0.3 + this.r() * 1.5, id, req, n: 1 + this.ri(2) }); return res.journal; }
    catch (e) { if (!(e instanceof LedgerError) && e.code !== "BAD_AMOUNT") throw e; out.push({ tenant: id, kind: req.meta?.kind, error: e, req }); return null; }
  }
  // ---------- flows ----------
  topup(c, out, amt = this.amount(c, 1.4)) { const w = this.wallet(c); const j = this.submit(c.id, { key: this.key(), ref: `tp_${this.n}`, memo: "Wallet top-up", entries: [{ account: c.psp, side: "dr", amount: amt }, { account: w, side: "cr", amount: amt }], meta: { kind: "topup" } }, out); if (j) this.unsettled[c.id].push({ id: j.id, at: j.at, amount: amt }); }
  pay(c, out, over = this.r.chance(this.overdraftRate)) {
    const w = this.wallet(c), m = this.merchant(c), avail = this.L.available(c.id, w); let amt = over ? avail + this.amount(c) : Math.min(this.amount(c), Math.floor((avail * 0.6) / 100) * 100); if (amt <= 0) return;
    const fee = bps(amt, c.mdr); const j = this.submit(c.id, { key: this.key(), ref: `pay_${this.n}`, memo: "QR payment", entries: [{ account: w, side: "dr", amount: amt }, { account: m, side: "cr", amount: amt - fee }, { account: "revenue:mdr", side: "cr", amount: fee }], meta: { kind: "pay" } }, out);
    if (j) { const lp = this.lastPays[c.id]; lp.push(j.id); if (lp.length > 50) lp.shift(); }
  }
  p2p(c, out) { const a = this.wallet(c), b = this.wallet(c); if (a === b) return; const amt = Math.min(this.amount(c, 0.6), Math.floor((this.L.available(c.id, a) * 0.5) / 100) * 100); if (amt <= 0) return; this.submit(c.id, { key: this.key(), memo: "Send money", entries: [{ account: a, side: "dr", amount: amt }, { account: b, side: "cr", amount: amt }], meta: { kind: "p2p" } }, out); }
  payout(c, out) {
    const m = this.merchant(c), bal = this.L.available(c.id, m); if (bal < c.avg * 300) return; const ref = `po_${++this.n}`;
    const j = this.submit(c.id, { key: this.key(), ref, memo: "Merchant payout (IMPS)", entries: [{ account: m, side: "dr", amount: bal }, { account: c.bank, side: "cr", amount: bal }], meta: { kind: "payout" } }, out, { retry: false });
    if (j) { this.expect(c.id, { id: j.id, at: j.at, amount: -bal, ref }); if (!(this.anomalies && this.r.chance(0.02))) this.bankLine(c.id, { at: this.t + 1 + this.r() * 4, amount: -bal, ref, desc: `IMPS ${ref}` }); else this.truth.returned++; }
  }
  withdraw(c, out) {
    const w = this.wallet(c), avail = this.L.available(c.id, w), amt = Math.floor((avail * (0.3 + this.r() * 0.5)) / 100) * 100; if (amt < 10000) return;
    try { const { hold } = this.L.hold(c.id, { account: w, to: c.bank, amount: amt, key: this.key(), ref: `wd_${this.n}`, memo: "Withdraw to bank", meta: { kind: "withdraw" } }); this.holds.push({ at: this.t + 2 + this.r() * 5, id: c.id, hold: hold.id, fail: this.r.chance(0.08) }); out.push({ tenant: c.id, kind: "hold", hold }); }
    catch (e) { out.push({ tenant: c.id, kind: "withdraw", error: e }); }
  }
  refund(c, out) { const lp = this.lastPays[c.id]; if (!lp.length) return; const id = lp.splice(this.ri(lp.length), 1)[0]; try { const r = this.L.reverse(c.id, id, { key: `refund-${id}`, memo: `Refund of ${id}` }); out.push({ tenant: c.id, kind: "refund", journal: r.journal, replay: r.replay }); } catch (e) { out.push({ tenant: c.id, kind: "refund", error: e }); } }
  remit(c, out) {
    const w = this.wallet(c), avail = this.L.available(c.id, w), amt = Math.min(this.amount(c), Math.floor((avail * 0.7) / 100) * 100); if (amt <= c.fee) return;
    const net = amt - c.fee, inr = Math.round(net * c.rate * (1 - 0.006)); // 0.6% FX margin stays in the AED position
    this.submit(c.id, { key: this.key(), ref: `rm_${this.n}`, memo: `Remit to India @ ${c.rate}`, entries: [{ account: w, side: "dr", amount: amt }, { account: "revenue:remit-fee", side: "cr", amount: c.fee }, { account: "fx:position-aed", side: "cr", amount: net }, { account: "fx:position-inr", side: "dr", amount: inr }, { account: "bank:icici-nostro", side: "cr", amount: inr }], meta: { kind: "remit" } }, out);
  }
  /** PSP pays out everything up to the cut-off, net of its fee, into the bank a few seconds later. */
  settle(c) {
    const items = this.unsettled[c.id]; if (!items.length) return; this.unsettled[c.id] = []; for (const x of items) this.expect(c.id, x);
    let pay = items; if (this.anomalies && items.length > 3 && this.r.chance(0.04)) { pay = items.slice(); pay.splice(this.ri(pay.length), 1); this.truth.missing++; }
    const gross = pay.reduce((s, x) => s + x.amount, 0); this.bankLine(c.id, { at: this.t + 3 + this.r() * 4, amount: gross - bps(gross, SETTLE_BPS), desc: `${c.pspName.split(" ")[0].toUpperCase()} SETTLEMENT` });
    if (this.anomalies && this.r.chance(0.25)) { this.bankLine(c.id, { at: this.t + 2 + this.r() * 6, amount: -(this.r.pick([59, 118, 177, 236]) * 100), desc: "Bank charges incl. GST" }); this.truth.charges++; }
  }
  expect(id, line) { this.recon[id].ledger.push(line); }
  bankLine(id, line) { this.bankPending.push({ ...line, tenant: id, id: `stmt_${id.split("-")[0]}_${++this.n}`, at: line.at }); }
  /** Reconcile what's pending; settlement matches post the bank/fee journal, old leftovers become breaks. */
  reconcile(id, out = []) {
    const R = this.recon[id], c = this.cfg[id], now = this.t * 1000, res = reconcile(R.ledger, R.bank, { dateTol: this.tol, settlementBps: SETTLE_BPS, feeBps: 0 });
    const byId = new Map(R.ledger.map((l) => [l.id, l])), bankById = new Map(R.bank.map((b) => [b.id, b]));
    for (const m of res.matches) {
      if (m.type === "settlement batch" || m.type === "net of fee" || (m.type === "amount+date" && bankById.get(m.bank[0]).amount > 0 && !byId.get(m.ledger[0]).ref)) {
        const gross = m.ledger.reduce((s, x) => s + byId.get(x).amount, 0), net = gross + m.diff, fee = gross - net;
        const entries = [{ account: c.bank, side: "dr", amount: net }, { account: c.psp, side: "cr", amount: gross }]; if (fee > 0) entries.push({ account: "expense:psp-fees", side: "dr", amount: fee });
        this.submit(id, { key: `settle-${m.bank[0]}`, ref: m.bank[0], memo: `PSP settlement (${m.ledger.length} top-ups)`, entries, meta: { kind: "settlement" } }, out, { retry: false });
      }
      R.matches.push({ ...m, at: now }); if (R.matches.length > 200) R.matches.shift();
    }
    const matchedL = new Set(res.matches.flatMap((m) => m.ledger)), matchedB = new Set(res.matches.flatMap((m) => m.bank)), stale = this.stale;
    for (const b of res.breaks) if (now - b.at > stale && !R.breaks.some((x) => x.id === b.id)) R.breaks.push({ ...b, tenant: id, status: "open" });
    R.ledger = R.ledger.filter((l) => !matchedL.has(l.id) && now - l.at <= stale); R.bank = R.bank.filter((b) => !matchedB.has(b.id) && now - b.at <= stale);
    const s = R.stats; s.matched += res.matches.length; s.ledger += matchedL.size; s.bank += matchedB.size; s.fees += res.stats.fees; for (const [k, v] of Object.entries(res.stats.byType)) s.byType[k] = (s.byType[k] || 0) + v; R.runs++;
    return { res, out };
  }
  /** Book an unmatched bank charge (or write off a missing item) so the books agree with the bank. */
  fixBreak(id, breakId, out = []) {
    const R = this.recon[id], c = this.cfg[id], b = R.breaks.find((x) => x.id === breakId && x.status === "open"); if (!b) return null;
    if (b.side === "bank" && b.amount < 0) this.submit(id, { key: `fix-${b.id}`, ref: b.id, memo: b.desc || "Bank charge", entries: [{ account: "expense:bank-charges", side: "dr", amount: -b.amount }, { account: c.bank, side: "cr", amount: -b.amount }], meta: { kind: "charge" } }, out, { retry: false });
    else if (b.side === "ledger" && b.amount > 0) this.submit(id, { key: `fix-${b.id}`, ref: b.id, memo: "Claim raised with PSP for unsettled top-up", entries: [{ account: "expense:psp-fees", side: "dr", amount: b.amount }, { account: c.psp, side: "cr", amount: b.amount }], meta: { kind: "writeoff" } }, out, { retry: false });
    else if (b.side === "ledger" && b.amount < 0) this.submit(id, { key: `fix-${b.id}`, ref: b.id, memo: "Payout returned by bank", entries: [{ account: c.bank, side: "dr", amount: -b.amount }, { account: "merchant:m01", side: "cr", amount: -b.amount }], meta: { kind: "return" } }, out, { retry: false });
    b.status = "fixed"; return b;
  }
  // ---------- scenarios ----------
  retryStorm(id, n = 40) { const out = [], c = this.cfg[id]; for (let i = 0; i < n / 4; i++) { const w = this.wallet(c), amt = this.amount(c), req = { key: this.key(), ref: `tp_${this.n}`, memo: "Wallet top-up (flaky network)", entries: [{ account: c.psp, side: "dr", amount: amt }, { account: w, side: "cr", amount: amt }], meta: { kind: "topup" } }; const j = this.submit(id, req, out, { retry: false }); if (j) this.unsettled[id].push({ id: j.id, at: j.at, amount: amt }); for (let k = 0; k < 3; k++) this.retries.push({ at: this.t + 0.1 + this.r() * 2, id, req, n: 1 }); } return out; }
  overdraft(id) { const out = [], c = this.cfg[id], w = this.wallet(c), avail = this.L.available(id, w), m = c.merchants ? this.merchant(c) : "fx:position-aed"; this.submit(id, { key: this.key(), memo: "Payment larger than balance", entries: [{ account: w, side: "dr", amount: avail + 100000 }, { account: m, side: "cr", amount: avail + 100000 }], meta: { kind: "pay" } }, out, { retry: false }); return out; }
  race(id) {
    const out = [], c = this.cfg[id]; let w = this.wallet(c); for (let i = 0; i < 10 && this.L.available(id, w) < 20000; i++) w = this.wallet(c);
    const amt = Math.floor((this.L.available(id, w) * 0.7) / 100) * 100; if (amt <= 0) return out;
    for (const k of ["A", "B"]) { try { const { hold } = this.L.hold(id, { account: w, to: c.bank, amount: amt, key: this.key(), ref: `race_${k}`, memo: `Withdrawal ${k} (concurrent)`, meta: { kind: "withdraw" } }); this.holds.push({ at: this.t + 2, id, hold: hold.id, fail: false }); out.push({ tenant: id, kind: "hold", hold, race: k }); } catch (e) { out.push({ tenant: id, kind: "withdraw", error: e, race: k }); } }
    return out;
  }
  // ---------- clock ----------
  step(dt) {
    const out = []; this.t += dt;
    for (const c of TENANTS) {
      const lam = this.rate * dt * (c.id === "gulf-remit" ? 0.5 : 1); const n = this.poisson(lam);
      for (let i = 0; i < n; i++) {
        if (c.nostro) { const k = this.r.weighted([["topup", 4], ["remit", 5], ["p2p", 1], ["withdraw", 0.4]], (x) => x[1])[0]; this[k](c, out); continue; }
        const k = this.r.weighted([["topup", 3], ["pay", 6], ["p2p", 2], ["payout", 0.5], ["withdraw", 0.5], ["refund", 0.25]], (x) => x[1])[0]; this[k](c, out);
      }
      if (this.t - this.lastSettle[c.id] >= this.settleEvery) { this.lastSettle[c.id] = this.t; this.settle(c); }
    }
    this.retries = this.retries.filter((r) => { if (r.at > this.t) return true; this.submit(r.id, r.req, out, { retry: false }); return --r.n > 0 && ((r.at = this.t + 0.5), true); });
    this.holds = this.holds.filter((h) => { if (h.at > this.t) return true; const ho = this.L.tenant(h.id).holds.get(h.hold); if (ho.status !== "pending") return false;
      if (h.fail) { this.L.void(h.id, h.hold, "bank rejected"); out.push({ tenant: h.id, kind: "void", hold: ho }); return false; }
      try { const r = this.L.commit(h.id, h.hold); out.push({ tenant: h.id, kind: "withdraw", journal: r.journal }); this.expect(h.id, { id: r.journal.id, at: r.journal.at, amount: -ho.amount, ref: ho.ref }); if (this.cfg[h.id].bank === ho.to) this.bankLine(h.id, { at: this.t + 1 + this.r() * 3, amount: -ho.amount, ref: ho.ref, desc: `NEFT ${ho.ref}` }); }
      catch (e) { out.push({ tenant: h.id, kind: "withdraw", error: e }); } return false; });
    this.bankPending = this.bankPending.filter((b) => { if (b.at > this.t) return true; this.recon[b.tenant].bank.push({ ...b, at: Math.round(b.at * 1000) }); return false; });
    return out;
  }
}
