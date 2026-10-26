import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, LedgerError, toMinor, fmtMoney, allocate, bps, reconcile, subsetSum, parseCSV, Platform, merkleRoot } from "../src/index.js";
import { createServer } from "../src/node/server.js";

let now = 1_000_000;
const mk = () => {
  const L = new Ledger({ clock: () => now });
  L.createTenant("acme", { currency: "INR" }); L.createTenant("globex", { currency: "INR" });
  for (const t of ["acme", "globex"]) {
    L.openAccount(t, { code: "bank", type: "asset" }); L.openAccount(t, { code: "capital", type: "equity" });
    L.openAccount(t, { code: "alice", type: "liability" }); L.openAccount(t, { code: "bob", type: "liability" }); L.openAccount(t, { code: "fees", type: "revenue" });
  }
  L.post("acme", { key: "seed", entries: [{ account: "bank", dr: "1000" }, { account: "alice", cr: "1000" }] });
  return L;
};
const xfer = (from, to, amount, key) => ({ key, entries: [{ account: from, side: "dr", amount }, { account: to, side: "cr", amount }] });

test("money: exact parsing, formatting, allocation and banker's rounding", () => {
  assert.equal(toMinor("1,234.50"), 123450); assert.equal(toMinor("0.1", "BTC"), 10000000); assert.equal(toMinor("5", "JPY"), 5);
  assert.throws(() => toMinor("1.234")); assert.throws(() => toMinor("1e3")); assert.throws(() => toMinor("1", "XYZ"));
  assert.equal(fmtMoney(1234567890), "₹1,23,45,678.90"); assert.equal(fmtMoney(-5, "USD"), "-$0.05");
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]); assert.equal(allocate(1001, [3, 7]).reduce((a, b) => a + b), 1001);
  assert.equal(bps(250, 200), 5); assert.equal(bps(25, 200), 0); assert.equal(bps(75, 200), 2); // 1.5 -> 2 (half to even)
});

test("posting: balanced journals apply atomically; unbalanced, unknown and overdraft are rejected with nothing changed", () => {
  const L = mk(); assert.equal(L.account("acme", "alice").balance, 100000);
  const { journal } = L.post("acme", { entries: [{ account: "alice", dr: "250" }, { account: "bob", cr: "245" }, { account: "fees", cr: "5" }] });
  assert.equal(L.account("acme", "bob").balance, 24500); assert.equal(L.account("acme", "fees").balance, 500); assert.equal(journal.seq, 2);
  const before = JSON.stringify(L.trialBalance("acme"));
  assert.throws(() => L.post("acme", { entries: [{ account: "alice", dr: "1" }, { account: "bob", cr: "2" }] }), (e) => e.code === "UNBALANCED");
  assert.throws(() => L.post("acme", xfer("alice", "nobody", 100)), (e) => e.code === "ACCOUNT_NOT_FOUND");
  assert.throws(() => L.post("acme", xfer("bob", "alice", 24501)), (e) => e.code === "INSUFFICIENT_FUNDS" && e.available === 24500);
  assert.throws(() => L.post("acme", xfer("alice", "bob", 12.5)), /integer minor units/);
  assert.equal(JSON.stringify(L.trialBalance("acme")), before); assert.ok(L.trialBalance("acme").balanced);
  assert.equal(L.stats.rejected, 4);
});

test("idempotency: same key + same payload replays, different payload conflicts, TTL expires", () => {
  const L = mk(); const a = L.post("acme", xfer("alice", "bob", 1000, "k1")), b = L.post("acme", { ...xfer("alice", "bob", "10.00", "k1") });
  assert.equal(b.replay, true); assert.equal(b.journal.id, a.journal.id); assert.equal(L.account("acme", "bob").balance, 1000); // "10.00" == 1000 paise
  assert.throws(() => L.post("acme", xfer("alice", "bob", 2000, "k1")), (e) => e.code === "IDEMPOTENCY_CONFLICT" && e.status === 409);
  now += 25 * 3600e3; assert.equal(L.post("acme", xfer("alice", "bob", 1000, "k1")).replay, false); now -= 25 * 3600e3;
});

test("tenants are isolated: separate accounts, balances and hash chains", () => {
  const L = mk(); assert.throws(() => L.post("globex", xfer("alice", "bob", 1)), (e) => e.code === "INSUFFICIENT_FUNDS");
  assert.equal(L.account("globex", "alice").balance, 0); assert.notEqual(L.tenant("acme").head, L.tenant("globex").head);
  L.post("globex", { entries: [{ account: "bank", dr: 5 }, { account: "capital", cr: 5 }] }); const r1 = L.anchor().root;
  L.post("acme", xfer("alice", "bob", 1)); assert.notEqual(L.anchor().root, r1); assert.equal(merkleRoot([]), "0".repeat(64));
});

test("batch: all-or-nothing with rollback of balances, chain head and idempotency keys", () => {
  const L = mk(), head = L.tenant("acme").head;
  assert.throws(() => L.postBatch("acme", [xfer("alice", "bob", 50000, "b1"), xfer("bob", "fees", 10000, "b2"), xfer("alice", "bob", 60000, "b3")]), (e) => e.code === "INSUFFICIENT_FUNDS" && e.batchIndex === 2);
  assert.equal(L.account("acme", "alice").balance, 100000); assert.equal(L.account("acme", "bob").balance, 0); assert.equal(L.tenant("acme").head, head);
  assert.equal(L.tenant("acme").journals.length, 1); assert.equal(L.post("acme", xfer("alice", "bob", 7, "b1")).replay, false); assert.ok(L.verify("acme").ok);
});

test("holds: reserve, partial capture, void, and no double spend of reserved funds", () => {
  const L = mk(); const { hold } = L.hold("acme", { account: "alice", to: "bob", amount: 70000, key: "h1" });
  assert.equal(L.available("acme", "alice"), 30000); assert.equal(L.account("acme", "alice").balance, 100000);
  assert.throws(() => L.hold("acme", { account: "alice", to: "bob", amount: 40000 }), (e) => e.code === "INSUFFICIENT_FUNDS");
  assert.throws(() => L.post("acme", xfer("alice", "bob", 40000)), (e) => e.code === "INSUFFICIENT_FUNDS");
  assert.equal(L.hold("acme", { account: "alice", to: "bob", amount: 70000, key: "h1" }).replay, true);
  L.commit("acme", hold.id, { amount: 50000 }); assert.equal(L.account("acme", "alice").balance, 50000); assert.equal(L.available("acme", "alice"), 50000);
  assert.throws(() => L.commit("acme", hold.id), (e) => e.code === "HOLD_CLOSED");
  const h2 = L.hold("acme", { account: "alice", to: "bob", amount: 100, expiresAt: now + 10 }).hold; now += 20; assert.equal(L.expireHolds("acme").length, 1); now -= 20;
  assert.equal(h2.status, "expired"); assert.equal(L.available("acme", "alice"), 50000);
});

test("reversals, point-in-time balances and statements", () => {
  const L = mk(); const t0 = now; now += 1000; const j = L.post("acme", xfer("alice", "bob", 30000)).journal; now += 1000;
  const r = L.reverse("acme", j.id); assert.equal(r.journal.meta.reverses, j.id); assert.equal(L.account("acme", "bob").balance, 0);
  assert.throws(() => L.reverse("acme", j.id), (e) => e.code === "ALREADY_REVERSED");
  assert.equal(L.balance("acme", "bob", { asOf: t0 + 1500 }), 30000); assert.equal(L.balance("acme", "bob", { asOf: t0 }), 0); assert.equal(L.balance("acme", "alice", { asOfSeq: 2 }), 70000);
  assert.deepEqual(L.statement("acme", "alice").map((s) => [s.delta, s.balance]), [[100000, 100000], [-30000, 70000], [30000, 100000]]);
});

test("hash chain: edits, deletes, reorders and balance tampering are all detected; export/import round-trips", () => {
  const L = mk(); for (let i = 0; i < 20; i++) L.post("acme", xfer(i % 2 ? "bob" : "alice", i % 2 ? "alice" : "bob", 1000 - i));
  assert.deepEqual(L.verify("acme").ok, true); const T = L.tenant("acme"), dump = L.export("acme");
  const L2 = new Ledger({ clock: () => now }); L2.import(dump); assert.equal(L2.tenant("acme").head, T.head); assert.equal(L2.account("acme", "bob").balance, L.account("acme", "bob").balance);
  T.journals[7].entries[0].amount += 1; let v = L.verify("acme"); assert.equal(v.ok, false); assert.equal(v.at, 8); assert.match(v.reason, /edited/); T.journals[7].entries[0].amount -= 1;
  [T.journals[3], T.journals[4]] = [T.journals[4], T.journals[3]]; assert.match(L.verify("acme").reason, /sequence/); [T.journals[3], T.journals[4]] = [T.journals[4], T.journals[3]];
  L.account("acme", "bob").balance += 1; assert.match(L.verify("acme").reason, /balance of bob/); L.account("acme", "bob").balance -= 1;
  const last = T.journals.pop(); assert.match(L.verify("acme").reason, /head/); T.journals.push(last); assert.ok(L.verify("acme").ok);
  dump.journals[5].memo = "x"; assert.throws(() => new Ledger().import(dump), (e) => e.code === "INTEGRITY");
});

test("multi-currency: each currency balances on its own (FX via position accounts)", () => {
  const L = new Ledger(); L.createTenant("fx", { currency: "AED" });
  for (const [code, type, currency, allowNegative] of [["w", "liability"], ["bank", "asset"], ["nostro", "asset", "INR"], ["cap", "equity", "INR"], ["pos-aed", "equity", "AED", true], ["pos-inr", "equity", "INR", true]]) L.openAccount("fx", { code, type, currency, allowNegative });
  L.post("fx", { entries: [{ account: "bank", dr: "100" }, { account: "w", cr: "100" }] }); L.post("fx", { entries: [{ account: "nostro", dr: "10000" }, { account: "cap", cr: "10000" }] });
  assert.throws(() => L.post("fx", { entries: [{ account: "w", dr: "100" }, { account: "nostro", cr: "2271" }] }), (e) => e.code === "UNBALANCED");
  L.post("fx", { entries: [{ account: "w", dr: "100" }, { account: "pos-aed", cr: "100" }, { account: "pos-inr", dr: "2271" }, { account: "nostro", cr: "2271" }] });
  const bs = L.balanceSheet("fx"); assert.ok(bs.AED.ok && bs.INR.ok); assert.equal(L.account("fx", "nostro").balance, 772900); assert.ok(L.trialBalance("fx").balanced);
});

test("reconciliation: reference, amount+date, net of fee, settlement batch, missing item, breaks", () => {
  const D = 86400e3, L = [{ id: "po", at: 0, amount: -7000, ref: "PO1" }, { id: "w", at: 0, amount: -5000 }, { id: "t1", at: 10, amount: 10000 }, { id: "t2", at: 20, amount: 25000 }, { id: "t3", at: 30, amount: 5000 }, { id: "t4", at: 40, amount: 12000 }, { id: "solo", at: 50, amount: 20000 }];
  const B = [{ id: "1", at: D, amount: -7000, ref: "PO1" }, { id: "2", at: D, amount: -5000 }, { id: "3", at: D, amount: 40000 - 600 }, { id: "4", at: D, amount: 19700 }, { id: "5", at: D, amount: -11800, desc: "Bank charges incl. GST" }];
  const r = reconcile(L, B, { settlementBps: 150 }), by = Object.fromEntries(r.matches.map((m) => [m.bank[0], m]));
  assert.equal(by["1"].type, "reference"); assert.equal(by["2"].type, "amount+date"); assert.equal(by["4"].type, "net of fee");
  assert.equal(by["3"].type, "settlement batch"); assert.deepEqual(by["3"].ledger, ["t1", "t2", "t3"]);
  assert.deepEqual(r.breaks.map((b) => [b.id, b.reason]), [["5", "bank charge not booked"], ["t4", "expected funds not received"]]);
  const r2 = reconcile(L.filter((x) => x.id !== "solo"), [{ id: "x", at: D, amount: (10000 + 5000 + 12000) - bps(27000, 150) }], { settlementBps: 150 });
  assert.deepEqual(r2.matches[0].ledger, ["t1", "t3", "t4"]); assert.equal(r2.breaks.find((b) => b.side === "ledger" && b.amount > 0).id, "t2"); // t2 left out of the batch
  assert.deepEqual(subsetSum([{ amount: 3 }, { amount: 9 }, { amount: 4 }], 7, 7).map((x) => x.amount), [3, 4]);
  assert.deepEqual(parseCSV('id,desc\n1,"a, ""b"""\r\n2,x\n'), [{ id: "1", desc: 'a, "b"' }, { id: "2", desc: "x" }]);
});

test("simulated platform: deterministic, books always balance, chain verifies, anomalies surface as breaks", () => {
  const run = () => { const p = new Platform({ seed: 3 }); for (let i = 0; i < 4000; i++) { p.step(0.1); if (i % 40 === 0) for (const id of p.L.tenants.keys()) p.reconcile(id); } return p; };
  const a = run(), b = run(); assert.deepEqual(a.L.anchor().root, b.L.anchor().root);
  for (const id of a.L.tenants.keys()) { assert.ok(a.L.verify(id).ok); assert.ok(a.L.trialBalance(id).balanced); for (const s of Object.values(a.L.balanceSheet(id))) assert.ok(s.ok); for (const acc of a.L.accounts(id)) if (!acc.allowNegative) assert.ok(acc.balance >= 0, acc.code); }
  assert.ok(a.L.stats.replays > 50 && a.L.stats.rejected > 10); const R = a.recon["kirana-pay"]; assert.ok(R.stats.byType["settlement batch"] >= 8 && R.stats.byType.reference > 100);
  const charge = Object.values(a.recon).flatMap((r) => r.breaks).find((x) => x.reason === "bank charge not booked"); assert.ok(charge);
  const bank = a.L.account(charge.tenant, a.cfg[charge.tenant].bank).balance; a.fixBreak(charge.tenant, charge.id); assert.equal(a.L.account(charge.tenant, a.cfg[charge.tenant].bank).balance, bank + charge.amount);
  const race = a.race("campus-wallet"); assert.equal(race.filter((x) => x.error?.code === "INSUFFICIENT_FUNDS").length, 1);
});

test("HTTP API: idempotent journals, errors with codes, holds, verify, reconcile", async () => {
  const L = mk(), srv = createServer(L).listen(0); await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`, call = async (m, p, body, h = {}) => { const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json", ...h }, body: body && JSON.stringify(body) }); return { s: r.status, h: r.headers, b: await r.json() }; };
  try {
    const j = { entries: [{ account: "alice", dr: "100" }, { account: "bob", cr: "100" }] };
    const a = await call("POST", "/v1/acme/journals", j, { "idempotency-key": "x1" }), b = await call("POST", "/v1/acme/journals", j, { "idempotency-key": "x1" });
    assert.equal(a.s, 201); assert.equal(b.s, 200); assert.equal(b.h.get("idempotent-replayed"), "true"); assert.equal(a.b.hash, b.b.hash);
    assert.equal((await call("POST", "/v1/acme/journals", { entries: [{ account: "bob", dr: "999" }, { account: "alice", cr: "999" }] })).b.error, "INSUFFICIENT_FUNDS");
    assert.equal((await call("GET", "/v1/acme/accounts/bob")).b.balance, 10000); assert.equal((await call("GET", "/v1/nope/accounts")).s, 404);
    const h = await call("POST", "/v1/acme/holds", { account: "alice", to: "bob", amount: "50" }); assert.equal(h.s, 201); assert.equal((await call("POST", `/v1/acme/holds/${h.b.id}/commit`, {})).s, 201);
    assert.equal((await call("POST", "/v1/acme/verify")).b.ok, true); assert.equal((await call("GET", "/v1/acme/trial-balance")).b.balanced, true);
    const rc = await call("POST", "/v1/acme/reconcile", { account: "bank", csv: "date,amount,desc\n1970-01-01,1000.00,deposit\n1970-01-01,-1.18,Bank charges\n", options: { dateTol: 30 * 86400e3 } });
    assert.equal(rc.b.matches.length, 1); assert.equal(rc.b.breaks[0].reason, "bank charge not booked");
  } finally { srv.close(); }
});
