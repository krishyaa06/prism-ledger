// Multi-tenant double-entry ledger: atomic journals, idempotency keys, two-phase holds,
// reversals, point-in-time balances and a per-tenant SHA-256 hash chain.
import { sha256 } from "./lib/sha256.js";
import { toMinor, decimals } from "./money.js";

export const NORMAL = { asset: "dr", expense: "dr", liability: "cr", equity: "cr", revenue: "cr" };
export const GENESIS = "0".repeat(64);

export class LedgerError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); this.status = STATUS[code] || 400; }
}
const STATUS = { NOT_FOUND: 404, TENANT_NOT_FOUND: 404, ACCOUNT_NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409, VERSION_CONFLICT: 409, INSUFFICIENT_FUNDS: 422, UNBALANCED: 422, ALREADY_REVERSED: 409, HOLD_CLOSED: 409, ACCOUNT_FROZEN: 423 };

/** Deterministic JSON: sorted keys, no whitespace. The hash input must not depend on insertion order. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
export const journalBody = (j) => ({ seq: j.seq, tenant: j.tenant, key: j.key, ref: j.ref, memo: j.memo, at: j.at, entries: j.entries.map((e) => ({ account: e.account, side: e.side, amount: e.amount, currency: e.currency })), meta: j.meta });
export const hashJournal = (prev, j) => sha256(prev + "|" + canonical(journalBody(j)));

/** Merkle root over leaf hashes (duplicate the last leaf on odd levels). */
export function merkleRoot(leaves) {
  if (!leaves.length) return GENESIS; let lv = leaves.slice();
  while (lv.length > 1) { const nx = []; for (let i = 0; i < lv.length; i += 2) nx.push(sha256(lv[i] + (lv[i + 1] ?? lv[i]))); lv = nx; }
  return lv[0];
}
const signed = (acct, side, amt) => (side === acct.normal ? amt : -amt);

export class Ledger {
  constructor({ clock = () => Date.now(), idempotencyTTL = 24 * 3600e3 } = {}) {
    this.clock = clock; this.ttl = idempotencyTTL; this.tenants = new Map(); this.subs = [];
    this.stats = { posted: 0, replays: 0, rejected: 0, holds: 0, reversals: 0, byCode: {} };
  }
  on(fn) { this.subs.push(fn); return () => (this.subs = this.subs.filter((f) => f !== fn)); }
  emit(ev) { for (const f of this.subs) f(ev); }

  // ---------- tenants & accounts ----------
  createTenant(id, { name = id, currency = "INR" } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new LedgerError("BAD_REQUEST", `bad tenant id "${id}"`);
    if (this.tenants.has(id)) throw new LedgerError("CONFLICT", `tenant ${id} exists`);
    const t = { id, name, currency, accounts: new Map(), journals: [], idem: new Map(), holds: new Map(), head: GENESIS, holdSeq: 0 };
    this.tenants.set(id, t); return t;
  }
  tenant(id) { const t = this.tenants.get(id); if (!t) throw new LedgerError("TENANT_NOT_FOUND", `no tenant ${id}`); return t; }
  openAccount(tid, { code, name = code, type, currency, allowNegative = false, meta } = {}) {
    const t = this.tenant(tid);
    if (!/^[a-z0-9][a-z0-9:._-]{0,63}$/i.test(code || "")) throw new LedgerError("BAD_REQUEST", `bad account code "${code}"`);
    if (!NORMAL[type]) throw new LedgerError("BAD_REQUEST", `type must be one of ${Object.keys(NORMAL).join(", ")}`);
    if (t.accounts.has(code)) throw new LedgerError("CONFLICT", `account ${code} exists`);
    const cur = currency || t.currency; decimals(cur);
    const a = { code, name, type, normal: NORMAL[type], currency: cur, allowNegative, meta, balance: 0, pending: 0, dr: 0, cr: 0, version: 0, frozen: false, hist: [], openedAt: this.clock() };
    t.accounts.set(code, a); return a;
  }
  account(tid, code) { const a = this.tenant(tid).accounts.get(code); if (!a) throw new LedgerError("ACCOUNT_NOT_FOUND", `no account ${code} in ${tid}`); return a; }
  accounts(tid, { type, prefix } = {}) { return [...this.tenant(tid).accounts.values()].filter((a) => (!type || a.type === type) && (!prefix || a.code.startsWith(prefix))); }
  freeze(tid, code, on = true) { this.account(tid, code).frozen = on; }
  available(tid, code) { const a = this.account(tid, code); return a.balance - a.pending; }

  // ---------- posting ----------
  /** Normalise and validate a request without mutating anything. Returns the journal to apply. */
  /** Resolve accounts, sides and amounts. Integer numbers are minor units; strings are decimal major units ("1234.50"). */
  normalize(tid, req) {
    const t = this.tenant(tid);
    if (!req || !Array.isArray(req.entries) || req.entries.length < 2) throw new LedgerError("UNBALANCED", "a journal needs at least two entries");
    return req.entries.map((e, i) => {
      const a = t.accounts.get(e.account); if (!a) throw new LedgerError("ACCOUNT_NOT_FOUND", `entry ${i}: no account ${e.account} in ${tid}`, { account: e.account });
      const side = e.side || (e.dr != null ? "dr" : e.cr != null ? "cr" : null); if (side !== "dr" && side !== "cr") throw new LedgerError("BAD_REQUEST", `entry ${i}: side must be dr or cr`);
      if (e.currency && e.currency !== a.currency) throw new LedgerError("BAD_REQUEST", `entry ${i}: ${a.code} is ${a.currency}, not ${e.currency}`);
      const raw = e.amount ?? e[side];
      if (typeof raw === "number" && !Number.isSafeInteger(raw)) throw new LedgerError("BAD_AMOUNT", `entry ${i}: numeric amounts are integer minor units; pass "${raw}" as a string for decimals`);
      const amount = typeof raw === "number" ? raw : toMinor(raw, a.currency);
      if (!(amount > 0)) throw new LedgerError("BAD_AMOUNT", `entry ${i}: amount must be positive`);
      return { account: a.code, side, amount, currency: a.currency };
    });
  }
  /** Validate a request without mutating anything. Returns the journal to apply. */
  prepare(tid, req, entries = this.normalize(tid, req)) {
    const t = this.tenant(tid);
    const sums = {}; for (const e of entries) { const s = (sums[e.currency] ||= { dr: 0, cr: 0 }); s[e.side] += e.amount; }
    for (const [cur, s] of Object.entries(sums)) if (s.dr !== s.cr) throw new LedgerError("UNBALANCED", `${cur} debits ${s.dr} ≠ credits ${s.cr}`, { currency: cur, dr: s.dr, cr: s.cr });
    const delta = new Map(); for (const e of entries) { const a = t.accounts.get(e.account); delta.set(a, (delta.get(a) || 0) + signed(a, e.side, e.amount)); }
    for (const [a, d] of delta) {
      if (a.frozen) throw new LedgerError("ACCOUNT_FROZEN", `${a.code} is frozen`, { account: a.code });
      if (req.ifVersion && req.ifVersion[a.code] != null && req.ifVersion[a.code] !== a.version) throw new LedgerError("VERSION_CONFLICT", `${a.code} is at version ${a.version}, expected ${req.ifVersion[a.code]}`, { account: a.code });
      const release = req._release?.account === a.code ? req._release.amount : 0;
      if (!a.allowNegative && d < 0 && a.balance + d - (a.pending - release) < 0) throw new LedgerError("INSUFFICIENT_FUNDS", `${a.code} has ${a.balance - a.pending + release} available, needs ${-d}`, { account: a.code, available: a.balance - a.pending + release, needed: -d });
      if (!Number.isSafeInteger(a.balance + d)) throw new LedgerError("BAD_AMOUNT", `${a.code} balance overflow`);
    }
    const last = t.journals.at(-1), at = Math.max(req.at ?? this.clock(), last ? last.at : 0);
    return { seq: t.journals.length + 1, tenant: tid, key: req.key, ref: req.ref, memo: req.memo, at, entries, meta: req.meta, delta };
  }
  fingerprint(entries, req) { return sha256(canonical({ entries: entries.map((e) => [e.account, e.side, e.amount]), ref: req.ref, memo: req.memo, meta: req.meta })); }

  /** Atomically post a balanced journal. Same key + same payload returns the original (replay). */
  post(tid, req) {
    const t = this.tenant(tid), now = this.clock();
    try {
      const entries = this.normalize(tid, req); let fp;
      if (req.key != null) {
        fp = this.fingerprint(entries, req); const hit = t.idem.get(req.key);
        if (hit && now - hit.at <= this.ttl) {
          if (hit.fp !== fp) throw new LedgerError("IDEMPOTENCY_CONFLICT", `key ${req.key} was used with a different payload`, { journal: hit.id });
          this.stats.replays++; const j = t.journals[hit.seq - 1]; this.emit({ type: "replay", tenant: tid, journal: j, key: req.key }); return { journal: j, replay: true };
        }
      }
      const j = this.prepare(tid, req, entries); this.apply(t, j);
      if (req.key != null) t.idem.set(req.key, { fp, seq: j.seq, id: j.id, at: now });
      this.stats.posted++; this.emit({ type: "posted", tenant: tid, journal: j }); return { journal: j, replay: false };
    } catch (e) {
      if (e instanceof LedgerError || e.code === "BAD_AMOUNT") { this.stats.rejected++; this.stats.byCode[e.code] = (this.stats.byCode[e.code] || 0) + 1; this.emit({ type: "rejected", tenant: tid, req, error: e }); }
      throw e;
    }
  }
  /** Never fails: everything was validated in prepare(). */
  apply(t, j) {
    for (const [a, d] of j.delta) { a.balance += d; a.version++; a.hist.push(j.seq, a.balance); }
    for (const e of j.entries) t.accounts.get(e.account)[e.side] += e.amount;
    delete j.delta; j.id = `jrn_${t.id}_${j.seq}`; j.prev = t.head; j.hash = hashJournal(t.head, j); t.head = j.hash; t.journals.push(j);
  }
  /** All-or-nothing batch: if any journal fails, everything posted by the batch is rolled back. */
  postBatch(tid, reqs) {
    const t = this.tenant(tid), mark = t.journals.length, keys = [], out = [];
    try { for (const r of reqs) { const res = this.post(tid, r); out.push(res); if (!res.replay && r.key != null) keys.push(r.key); } return out; }
    catch (e) { this._rollback(t, mark, keys); this.stats.posted -= out.filter((r) => !r.replay).length; throw Object.assign(e, { batchIndex: out.length }); }
  }
  _rollback(t, mark, keys) {
    while (t.journals.length > mark) {
      const j = t.journals.pop();
      for (const e of j.entries) { const a = t.accounts.get(e.account); a[e.side] -= e.amount; }
      const seen = new Set(); for (const e of j.entries) { const a = t.accounts.get(e.account); if (seen.has(a)) continue; seen.add(a); a.hist.length -= 2; a.balance = a.hist.length ? a.hist.at(-1) : 0; a.version--; }
      t.head = j.prev;
    }
    for (const k of keys) t.idem.delete(k);
  }
  /** Post an exact mirror of a journal. Each journal can be reversed once. */
  reverse(tid, id, { key, memo } = {}) {
    const t = this.tenant(tid), j = t.journals.find((x) => x.id === id); if (!j) throw new LedgerError("NOT_FOUND", `no journal ${id}`);
    if (j.reversedBy) { if (key != null && t.idem.get(key)?.id === j.reversedBy) return { journal: t.journals.find((x) => x.id === j.reversedBy), replay: true }; throw new LedgerError("ALREADY_REVERSED", `${id} was reversed by ${j.reversedBy}`); }
    const r = this.post(tid, { key, ref: j.ref, memo: memo || `reversal of ${id}`, entries: j.entries.map((e) => ({ account: e.account, side: e.side === "dr" ? "cr" : "dr", amount: e.amount })), meta: { reverses: id } });
    if (!r.replay) { j.reversedBy = r.journal.id; this.stats.reversals++; } return r;
  }

  // ---------- two-phase holds ----------
  /** Reserve funds now, move them later (card auth, withdrawal to bank). */
  hold(tid, { account, to, amount, key, ref, memo, expiresAt, meta }) {
    const t = this.tenant(tid), a = this.account(tid, account); this.account(tid, to);
    if (key != null) { const h = [...t.holds.values()].find((x) => x.key === key); if (h) return { hold: h, replay: true }; }
    const amt = typeof amount === "number" && Number.isInteger(amount) ? amount : toMinor(amount, a.currency);
    if (!(amt > 0)) throw new LedgerError("BAD_AMOUNT", "hold amount must be positive");
    if (!a.allowNegative && a.balance - a.pending < amt) { this.stats.rejected++; this.stats.byCode.INSUFFICIENT_FUNDS = (this.stats.byCode.INSUFFICIENT_FUNDS || 0) + 1; const e = new LedgerError("INSUFFICIENT_FUNDS", `${account} has ${a.balance - a.pending} available, needs ${amt}`, { account, available: a.balance - a.pending, needed: amt }); this.emit({ type: "rejected", tenant: tid, req: { hold: true, account, amount: amt }, error: e }); throw e; }
    const h = { id: `hld_${tid}_${++t.holdSeq}`, key, account, to, amount: amt, ref, memo, meta, status: "pending", at: this.clock(), expiresAt };
    a.pending += amt; t.holds.set(h.id, h); this.stats.holds++; this.emit({ type: "hold", tenant: tid, hold: h }); return { hold: h, replay: false };
  }
  /** Capture all or part of a hold; the remainder is released. */
  commit(tid, holdId, { amount } = {}) {
    const t = this.tenant(tid), h = t.holds.get(holdId); if (!h) throw new LedgerError("NOT_FOUND", `no hold ${holdId}`);
    if (h.status !== "pending") throw new LedgerError("HOLD_CLOSED", `${holdId} is ${h.status}`);
    const a = this.account(tid, h.account), amt = amount == null ? h.amount : typeof amount === "number" ? amount : toMinor(amount, a.currency);
    if (!(amt > 0) || amt > h.amount) throw new LedgerError("BAD_AMOUNT", `capture must be between 1 and ${h.amount}`);
    const r = this.post(tid, { key: `${h.id}:commit`, ref: h.ref, memo: h.memo || `capture ${h.id}`, entries: [{ account: h.account, side: a.normal === "cr" ? "dr" : "cr", amount: amt }, { account: h.to, side: a.normal === "cr" ? "cr" : "dr", amount: amt }], meta: { ...h.meta, hold: h.id }, _release: { account: h.account, amount: h.amount } });
    a.pending -= h.amount; h.status = "committed"; h.captured = amt; h.journal = r.journal.id; this.emit({ type: "commit", tenant: tid, hold: h, journal: r.journal }); return r;
  }
  void(tid, holdId, reason = "voided") {
    const t = this.tenant(tid), h = t.holds.get(holdId); if (!h) throw new LedgerError("NOT_FOUND", `no hold ${holdId}`);
    if (h.status !== "pending") throw new LedgerError("HOLD_CLOSED", `${holdId} is ${h.status}`);
    this.account(tid, h.account).pending -= h.amount; h.status = reason; this.emit({ type: "void", tenant: tid, hold: h }); return h;
  }
  expireHolds(tid, now = this.clock()) { const out = []; for (const h of this.tenant(tid).holds.values()) if (h.status === "pending" && h.expiresAt != null && h.expiresAt <= now) out.push(this.void(tid, h.id, "expired")); return out; }

  // ---------- reads ----------
  /** Balance as of a sequence number or a timestamp (binary search over the account's history). */
  balance(tid, code, { asOf, asOfSeq } = {}) {
    const t = this.tenant(tid), a = this.account(tid, code);
    let seq = asOfSeq; if (asOf != null) { let lo = 0, hi = t.journals.length; while (lo < hi) { const m = (lo + hi) >> 1; t.journals[m].at <= asOf ? (lo = m + 1) : (hi = m); } seq = lo; }
    if (seq == null) return a.balance; let lo = 0, hi = a.hist.length / 2;
    while (lo < hi) { const m = (lo + hi) >> 1; a.hist[m * 2] <= seq ? (lo = m + 1) : (hi = m); }
    return lo ? a.hist[lo * 2 - 1] : 0;
  }
  /** Account statement with running balance. */
  statement(tid, code, { from = 0, to = Infinity, limit = 1000 } = {}) {
    const t = this.tenant(tid), a = this.account(tid, code), out = [];
    for (let i = 0; i < a.hist.length && out.length < limit; i += 2) {
      const j = t.journals[a.hist[i] - 1]; if (j.at < from || j.at > to) continue;
      let d = 0; for (const e of j.entries) if (e.account === code) d += signed(a, e.side, e.amount);
      out.push({ journal: j.id, at: j.at, ref: j.ref, memo: j.memo, delta: d, balance: a.hist[i + 1] });
    }
    return out;
  }
  trialBalance(tid, { asOfSeq } = {}) {
    const t = this.tenant(tid), rows = [], totals = {};
    for (const a of t.accounts.values()) {
      const b = asOfSeq == null ? a.balance : this.balance(tid, a.code, { asOfSeq }); const dr = (a.normal === "dr") === b >= 0 ? Math.abs(b) : 0, cr = dr ? 0 : Math.abs(b);
      rows.push({ code: a.code, name: a.name, type: a.type, currency: a.currency, dr, cr, balance: b });
      const s = (totals[a.currency] ||= { dr: 0, cr: 0 }); s.dr += dr; s.cr += cr;
    }
    return { rows, totals, balanced: Object.values(totals).every((s) => s.dr === s.cr) };
  }
  /** Assets = Liabilities + Equity + (Revenue − Expenses), per currency. */
  balanceSheet(tid) {
    const by = {}; for (const a of this.tenant(tid).accounts.values()) { const s = (by[a.currency] ||= { asset: 0, liability: 0, equity: 0, revenue: 0, expense: 0 }); s[a.type] += a.balance; }
    for (const s of Object.values(by)) { s.earnings = s.revenue - s.expense; s.ok = s.asset === s.liability + s.equity + s.earnings; }
    return by;
  }
  journal(tid, id) { return this.tenant(tid).journals.find((j) => j.id === id) || null; }

  // ---------- integrity ----------
  /** Recompute the hash chain and every balance from the journal. Detects any edit, insert, delete or reorder. */
  verify(tid, { fromSeq = 1 } = {}) {
    const t = this.tenant(tid), full = fromSeq <= 1, start = Math.max(0, fromSeq - 1); let prev = start ? t.journals[start - 1].hash : GENESIS; const bal = new Map();
    for (let i = start; i < t.journals.length; i++) {
      const j = t.journals[i];
      if (j.seq !== i + 1) return { ok: false, at: i + 1, id: j.id, reason: `sequence gap: expected ${i + 1}, found ${j.seq}`, checked: i };
      if (j.prev !== prev) return { ok: false, at: j.seq, id: j.id, reason: "prev hash does not link to the previous journal", checked: i };
      const h = hashJournal(prev, j); if (h !== j.hash) return { ok: false, at: j.seq, id: j.id, reason: "content does not match its hash (edited after posting)", checked: i, expected: j.hash, actual: h };
      const sums = {}; for (const e of j.entries) { const s = (sums[e.currency] ||= [0, 0]); s[e.side === "dr" ? 0 : 1] += e.amount; const a = t.accounts.get(e.account); bal.set(e.account, (bal.get(e.account) || 0) + signed(a, e.side, e.amount)); }
      for (const [c, s] of Object.entries(sums)) if (s[0] !== s[1]) return { ok: false, at: j.seq, id: j.id, reason: `${c} unbalanced`, checked: i };
      prev = h;
    }
    if (prev !== t.head) return { ok: false, at: t.journals.length, reason: "head hash mismatch (journals truncated)", checked: t.journals.length };
    if (!full) return { ok: true, checked: t.journals.length - start, head: t.head, partial: true };
    for (const a of t.accounts.values()) if ((bal.get(a.code) || 0) !== a.balance) return { ok: false, reason: `balance of ${a.code} is ${a.balance} but journals say ${bal.get(a.code) || 0}`, account: a.code, checked: t.journals.length };
    return { ok: true, checked: t.journals.length, head: t.head };
  }
  /** One root hash committing to every tenant's chain head; publish it to make history externally checkable. */
  anchor() { const heads = [...this.tenants.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => sha256(t.id + ":" + t.head)); return { root: merkleRoot(heads), tenants: this.tenants.size, at: this.clock() }; }

  // ---------- persistence ----------
  export(tid) {
    const t = this.tenant(tid);
    return { tenant: { id: t.id, name: t.name, currency: t.currency }, accounts: [...t.accounts.values()].map(({ code, name, type, currency, allowNegative, meta }) => ({ code, name, type, currency, allowNegative, meta })), journals: t.journals.map((j) => ({ ...journalBody(j), id: j.id, prev: j.prev, hash: j.hash, reversedBy: j.reversedBy })), head: t.head };
  }
  /** Rebuild a tenant from an export, re-validating every journal and checking every stored hash. */
  import(data) {
    const t = this.createTenant(data.tenant.id, data.tenant); for (const a of data.accounts) this.openAccount(t.id, a);
    for (const raw of data.journals) {
      const j = this.prepare(t.id, { ...raw, entries: raw.entries.map((e) => ({ ...e })) }); j.at = raw.at; this.apply(t, j);
      if (raw.hash && raw.hash !== j.hash) throw new LedgerError("INTEGRITY", `journal ${raw.seq} hash mismatch on import`, { at: raw.seq });
      if (raw.reversedBy) j.reversedBy = raw.reversedBy; if (raw.key != null) t.idem.set(raw.key, { fp: this.fingerprint(j.entries, raw), seq: j.seq, id: j.id, at: this.clock() });
    }
    if (data.head && data.head !== t.head) throw new LedgerError("INTEGRITY", "head hash mismatch on import"); return t;
  }
}
