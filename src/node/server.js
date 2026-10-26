// HTTP API over a Ledger. JSON in, JSON out. Idempotency-Key header is honoured on every write.
import http from "node:http";
import { LedgerError } from "../ledger.js";
import { reconcile, parseCSV } from "../recon.js";
import { toMinor } from "../money.js";

export function createServer(ledger, { maxBody = 1 << 20 } = {}) {
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > maxBody) { no(new LedgerError("BAD_REQUEST", "body too large")); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", no); });
  const json = async (req) => { const b = await read(req); if (!b) return {}; try { return JSON.parse(b); } catch { throw new LedgerError("BAD_REQUEST", "invalid JSON"); } };
  const pubAcct = (a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency, balance: a.balance, pending: a.pending, available: a.balance - a.pending, version: a.version, frozen: a.frozen });
  const pubJ = (j) => ({ id: j.id, seq: j.seq, key: j.key, ref: j.ref, memo: j.memo, at: j.at, entries: j.entries, meta: j.meta, prev: j.prev, hash: j.hash, reversedBy: j.reversedBy });

  return http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x"), p = u.pathname.split("/").filter(Boolean), m = req.method, idem = req.headers["idempotency-key"];
      if (u.pathname === "/healthz") return send(res, 200, { ok: true, tenants: ledger.tenants.size, ...ledger.stats });
      if (p[0] !== "v1") return send(res, 404, { error: "NOT_FOUND" });
      if (p[1] === "anchor" && m === "GET") return send(res, 200, ledger.anchor());
      if (p[1] === "tenants" && m === "POST") { const b = await json(req); const t = ledger.createTenant(b.id, b); return send(res, 201, { id: t.id, name: t.name, currency: t.currency }); }
      const tid = p[1]; ledger.tenant(tid);
      if (p[2] === "accounts") {
        if (m === "POST" && !p[3]) { const b = await json(req); return send(res, 201, pubAcct(ledger.openAccount(tid, b))); }
        if (m === "GET" && !p[3]) return send(res, 200, ledger.accounts(tid, { type: u.searchParams.get("type") || undefined, prefix: u.searchParams.get("prefix") || undefined }).map(pubAcct));
        if (m === "GET" && p[4] === "statement") return send(res, 200, ledger.statement(tid, p[3], { limit: +(u.searchParams.get("limit") || 1000) }));
        if (m === "GET") { const a = pubAcct(ledger.account(tid, p[3])), asOf = u.searchParams.get("asOf"); if (asOf != null) a.balanceAsOf = ledger.balance(tid, p[3], { asOf: isNaN(+asOf) ? Date.parse(asOf) : +asOf }); return send(res, 200, a); }
      }
      if (p[2] === "journals") {
        if (m === "POST" && !p[3]) { const b = await json(req); const r = ledger.post(tid, { ...b, key: idem ?? b.key }); return send(res, r.replay ? 200 : 201, pubJ(r.journal), r.replay ? { "idempotent-replayed": "true" } : {}); }
        if (m === "POST" && p[4] === "reverse") { const b = await json(req); const r = ledger.reverse(tid, p[3], { key: idem ?? b.key, memo: b.memo }); return send(res, r.replay ? 200 : 201, pubJ(r.journal)); }
        if (m === "POST" && p[3] === "batch") { const b = await json(req); return send(res, 201, ledger.postBatch(tid, b.journals || []).map((r) => pubJ(r.journal))); }
        if (m === "GET" && p[3]) { const j = ledger.journal(tid, p[3]); return j ? send(res, 200, pubJ(j)) : send(res, 404, { error: "NOT_FOUND" }); }
        if (m === "GET") { const js = ledger.tenant(tid).journals, n = Math.min(500, +(u.searchParams.get("limit") || 50)); return send(res, 200, js.slice(-n).map(pubJ)); }
      }
      if (p[2] === "holds") {
        if (m === "POST" && !p[3]) { const b = await json(req); const r = ledger.hold(tid, { ...b, key: idem ?? b.key }); return send(res, r.replay ? 200 : 201, r.hold); }
        if (m === "POST" && p[4] === "commit") { const b = await json(req); return send(res, 201, pubJ(ledger.commit(tid, p[3], b).journal)); }
        if (m === "POST" && p[4] === "void") return send(res, 200, ledger.void(tid, p[3]));
      }
      if (p[2] === "trial-balance" && m === "GET") return send(res, 200, ledger.trialBalance(tid));
      if (p[2] === "balance-sheet" && m === "GET") return send(res, 200, ledger.balanceSheet(tid));
      if (p[2] === "verify" && m === "POST") { const v = ledger.verify(tid); return send(res, v.ok ? 200 : 409, v); }
      if (p[2] === "export" && m === "GET") return send(res, 200, ledger.export(tid));
      if (p[2] === "reconcile" && m === "POST") {
        const b = await json(req), cur = ledger.tenant(tid).currency, num = (x) => (typeof x.amount === "string" ? toMinor(x.amount, cur) : x.amount);
        const bank = (b.csv ? parseCSV(b.csv) : b.bank || []).map((x, i) => ({ ...x, id: x.id || `b${i + 1}`, at: typeof x.at === "number" ? x.at : Date.parse(x.date || x.at), amount: num(x) }));
        let lines = b.ledger; if (!lines && b.account) lines = ledger.statement(tid, b.account).map((s) => ({ id: s.journal, at: s.at, amount: s.delta, ref: s.ref }));
        return send(res, 200, reconcile(lines || [], bank, b.options || {}));
      }
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      const code = e instanceof LedgerError ? e.status : e.code === "BAD_AMOUNT" ? 400 : 500;
      const { message, status, stack, ...extra } = e; send(res, code, { error: e.code || "INTERNAL", message: e.message, ...extra });
    }
  });
}
