#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { Ledger, Platform, TENANTS, reconcile, parseCSV, toMinor, fmtMoney, fmtShort } from "../src/index.js";
import { c, table, header, fail, bar, num } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes("--" + n);
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("ledger")} — Prism Ledger: multi-tenant double-entry ledger with idempotency, holds, hash-chain audit and reconciliation

  ledger demo                                      postings, idempotency, overdraft, holds, reversal, tamper detection
  ledger simulate [--minutes 5 --rate 14]          three tenants of synthetic payments traffic + continuous reconciliation
  ledger recon <expected.csv> <bank.csv> [--fee-bps 150 --days 3]   match ledger cash lines to a bank statement
  ledger verify <export.json>                      re-validate every journal and the hash chain of an export
  ledger export [--out ledger.json]                write a sample tenant export (try editing it, then verify)
  ledger bench [--n 100000]                        posting throughput and latency percentiles
  ledger serve [--port 8788]                       HTTP API
`;
const ok = (b) => (b ? c.green("✓") : c.red("✗"));
const pct = (q, a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0; };
function sample() {
  const L = new Ledger(); L.createTenant("acme", { name: "Acme Wallet" });
  for (const [code, type, name] of [["bank:hdfc", "asset", "HDFC current a/c"], ["equity:capital", "equity", "Share capital"], ["wallet:asha", "liability", "Asha"], ["wallet:ravi", "liability", "Ravi"], ["merchant:chai", "liability", "Chai point"], ["revenue:fees", "revenue", "Fees"]]) L.openAccount("acme", { code, type, name });
  return L;
}

try {
  if (!cmd || cmd === "help" || cmd === "--help") console.log(HELP);
  else if (cmd === "demo") {
    const L = sample(), T = "acme", bal = (a) => fmtMoney(L.account(T, a).balance), sec = (t) => console.log("\n" + c.bold(t));
    console.log(header("ledger demo", "one tenant, six accounts, every rule of the ledger exercised"));
    sec("1. Fund the business and two wallets (balanced journals only)");
    L.post(T, { key: "cap", memo: "capital", entries: [{ account: "bank:hdfc", dr: "500000" }, { account: "equity:capital", cr: "500000" }] });
    L.post(T, { key: "tp1", memo: "Asha tops up", entries: [{ account: "bank:hdfc", dr: "2000" }, { account: "wallet:asha", cr: "2000" }] });
    L.post(T, { key: "tp2", memo: "Ravi tops up", entries: [{ account: "bank:hdfc", dr: "750" }, { account: "wallet:ravi", cr: "750" }] });
    console.log(`  bank ${bal("bank:hdfc")} · asha ${bal("wallet:asha")} · ravi ${bal("wallet:ravi")}`);
    sec("2. A three-leg payment: Asha pays the chai shop ₹120, 2% fee to the platform");
    const p = L.post(T, { key: "pay-1", memo: "QR payment", entries: [{ account: "wallet:asha", dr: "120" }, { account: "merchant:chai", cr: "117.60" }, { account: "revenue:fees", cr: "2.40" }] }).journal;
    console.log(table(p.entries.map((e) => [e.account, e.side === "dr" ? fmtMoney(e.amount) : "", e.side === "cr" ? fmtMoney(e.amount) : ""]), { head: ["account", "debit", "credit"], align: ["l", "r", "r"] }));
    console.log(`  ${c.dim(p.id + " · prev " + p.prev.slice(0, 12) + "… → hash " + p.hash.slice(0, 12) + "…")}`);
    sec("3. The phone retries the same request three times (same Idempotency-Key)");
    for (let i = 0; i < 3; i++) { const r = L.post(T, { key: "pay-1", memo: "QR payment", entries: [{ account: "wallet:asha", dr: "120" }, { account: "merchant:chai", cr: "117.60" }, { account: "revenue:fees", cr: "2.40" }] }); console.log(`  retry ${i + 1}: ${r.replay ? c.green("replayed " + r.journal.id) : c.red("posted again")} · asha still ${bal("wallet:asha")}`); }
    try { L.post(T, { key: "pay-1", entries: [{ account: "wallet:asha", dr: "999" }, { account: "merchant:chai", cr: "999" }] }); } catch (e) { console.log(`  same key, different body: ${c.red(e.code)} ${c.dim(e.message)}`); }
    sec("4. Rejections leave the books untouched");
    for (const [label, req] of [["unbalanced", { entries: [{ account: "wallet:ravi", dr: "10" }, { account: "wallet:asha", cr: "9" }] }], ["overdraft", { entries: [{ account: "wallet:ravi", dr: "5000" }, { account: "wallet:asha", cr: "5000" }] }], ["unknown account", { entries: [{ account: "wallet:ravi", dr: "1" }, { account: "wallet:zoe", cr: "1" }] }], ["float amount", { entries: [{ account: "wallet:ravi", dr: 10.5 }, { account: "wallet:asha", cr: 10.5 }] }]]) {
      try { L.post(T, req); } catch (e) { console.log(`  ${label.padEnd(16)} ${c.red(e.code.padEnd(20))} ${c.dim(e.message)}`); }
    }
    sec("5. Two-phase withdrawal: hold ₹600, capture ₹500, the rest is released");
    const { hold } = L.hold(T, { account: "wallet:ravi", to: "bank:hdfc", amount: "600", key: "wd-1" });
    console.log(`  hold ${hold.id}: ravi balance ${bal("wallet:ravi")}, available ${fmtMoney(L.available(T, "wallet:ravi"))}`);
    try { L.post(T, { entries: [{ account: "wallet:ravi", dr: "300" }, { account: "wallet:asha", cr: "300" }] }); } catch (e) { console.log(`  spend ₹300 while held: ${c.red(e.code)} ${c.dim("(reserved funds cannot be spent twice)")}`); }
    L.commit(T, hold.id, { amount: "500" }); console.log(`  captured ₹500: ravi ${bal("wallet:ravi")}, available ${fmtMoney(L.available(T, "wallet:ravi"))}`);
    sec("6. Refund by reversal, then point-in-time balances");
    const r = L.reverse(T, p.id, { key: "refund-1" }).journal; console.log(`  ${r.id} reverses ${p.id} · asha ${bal("wallet:asha")} · chai ${bal("merchant:chai")}`);
    console.log(`  asha as of seq ${p.seq}: ${fmtMoney(L.balance(T, "wallet:asha", { asOfSeq: p.seq }))} · now: ${bal("wallet:asha")}`);
    sec("7. Trial balance and balance sheet");
    const tb = L.trialBalance(T); console.log(table([...tb.rows.map((x) => [x.code, x.type, x.dr ? fmtMoney(x.dr) : "", x.cr ? fmtMoney(x.cr) : ""]), [c.bold("total"), "", c.bold(fmtMoney(tb.totals.INR.dr)), c.bold(fmtMoney(tb.totals.INR.cr))]], { head: ["account", "type", "debit", "credit"], align: ["l", "l", "r", "r"] }));
    const bs = L.balanceSheet(T).INR; console.log(`  ${ok(bs.ok)} assets ${fmtMoney(bs.asset)} = liabilities ${fmtMoney(bs.liability)} + equity ${fmtMoney(bs.equity)} + earnings ${fmtMoney(bs.earnings)}`);
    sec("8. Someone edits a posted journal in the database");
    console.log(`  verify before: ${ok(L.verify(T).ok)} ${L.verify(T).checked} journals, head ${L.tenant(T).head.slice(0, 16)}…`);
    L.tenant(T).journals[1].entries[0].amount = 20000000; const v = L.verify(T); console.log(`  verify after:  ${ok(v.ok)} ${c.red(`journal #${v.at}: ${v.reason}`)}`);
    console.log(`  anchor root (publish this daily): ${L.anchor().root.slice(0, 32)}…`);
  } else if (cmd === "simulate") {
    const mins = +flag("minutes", 5), p = new Platform({ seed: +flag("seed", 7), rate: +flag("rate", 14) }), t0 = performance.now();
    console.log(header("ledger simulate", `${mins} min · ${TENANTS.length} tenants · PSP settles every ${p.settleEvery}s net of 1.5% · retries, overdrafts, bank charges, missing settlements, failed payouts`));
    let ev = 0; for (let i = 0; i < mins * 600; i++) { ev += p.step(0.1).length; if (i % 50 === 0) for (const id of p.L.tenants.keys()) p.reconcile(id); }
    p.rate = 0; for (let i = 0; i < 3000; i++) p.step(0.1); for (const id of p.L.tenants.keys()) p.reconcile(id); // drain so every anomaly surfaces
    const s = p.L.stats; console.log(`\n  ${num(s.posted)} journals · ${num(s.replays)} idempotent replays · ${num(s.rejected)} rejected (${Object.entries(s.byCode).map(([k, v]) => `${k} ${v}`).join(", ")}) · ${num(s.holds)} holds · ${num(s.reversals)} refunds`);
    console.log(table(TENANTS.map((t) => { const v = p.L.verify(t.id), tb = p.L.trialBalance(t.id), R = p.recon[t.id], bs = p.L.balanceSheet(t.id)[t.currency]; return [t.name, num(p.L.tenant(t.id).journals.length), fmtShort(bs.liability, t.currency), `${ok(tb.balanced)} ${ok(bs.ok)}`, `${ok(v.ok)} ${v.head.slice(0, 10)}`, num(R.stats.matched), `${R.breaks.length}`]; }), { head: ["tenant", "journals", "wallets owed", "TB / BS", "chain", "recon matched", "breaks"], align: ["l", "r", "r", "l", "l", "r", "r"] }));
    const br = Object.values(p.recon).flatMap((r) => r.breaks), cnt = {}; for (const b of br) cnt[b.reason] = (cnt[b.reason] || 0) + 1;
    console.log(`\n  ${c.bold("breaks found")}  ${Object.entries(cnt).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
    console.log(`  ${c.bold("ground truth")}  bank charges ${p.truth.charges} · top-ups the PSP never paid ${p.truth.missing} · payouts that never cleared ${p.truth.returned}`);
    const caught = (cnt["bank charge not booked"] || 0) === p.truth.charges && (cnt["expected funds not received"] || 0) === p.truth.missing && (cnt["payout not cleared"] || 0) === p.truth.returned;
    console.log(`  ${ok(caught)} every injected anomaly surfaced as exactly one break · ${num(ev)} events in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    const all = TENANTS.every((t) => p.L.verify(t.id).ok && p.L.trialBalance(t.id).balanced); if (!all || !caught) process.exit(1);
  } else if (cmd === "recon") {
    if (pos.length < 2) fail("usage: ledger recon <expected.csv> <bank.csv>");
    const rd = (f, pre) => parseCSV(readFileSync(f, "utf8")).map((x, i) => ({ ...x, id: x.id || `${pre}${i + 1}`, at: Date.parse(x.date), amount: toMinor(x.amount, flag("currency", "INR")) }));
    const L = rd(pos[0], "L"), B = rd(pos[1], "B"), r = reconcile(L, B, { settlementBps: +flag("fee-bps", 150), dateTol: +flag("days", 3) * 86400e3 });
    console.log(header("ledger recon", `${L.length} ledger lines vs ${B.length} bank lines`) + "\n");
    console.log(table(r.matches.map((m) => [c.cyan(m.type), m.bank.join(","), m.ledger.join(","), m.diff ? c.yellow(fmtMoney(m.diff)) : c.dim("0"), c.dim(m.type === "settlement batch" ? `${m.ledger.length} top-ups, fee ${fmtMoney(-m.diff)}` : m.diff ? `fee ${fmtMoney(-m.diff)}` : "")]), { head: ["match", "bank", "ledger", "diff", "note"] }));
    if (r.breaks.length) console.log("\n" + c.bold("breaks") + "\n" + table(r.breaks.map((b) => [c.red(b.reason), b.side, b.id, fmtMoney(b.amount), b.desc || b.ref || ""]), { head: ["reason", "side", "id", "amount", "detail"], align: ["l", "l", "l", "r", "l"] }));
    console.log(`\n  matched ${bar(r.stats.matchedPct, 24)} ${(r.stats.matchedPct * 100).toFixed(1)}% of lines · processor fees ${fmtMoney(r.stats.fees)}`);
  } else if (cmd === "export") {
    const L = sample(); L.post("acme", { key: "cap", entries: [{ account: "bank:hdfc", dr: "500000" }, { account: "equity:capital", cr: "500000" }] });
    L.post("acme", { key: "tp", entries: [{ account: "bank:hdfc", dr: "2000" }, { account: "wallet:asha", cr: "2000" }] }); L.post("acme", { key: "pay", entries: [{ account: "wallet:asha", dr: "120" }, { account: "merchant:chai", cr: "117.60" }, { account: "revenue:fees", cr: "2.40" }] });
    const out = flag("out", "ledger.json"); writeFileSync(out, JSON.stringify(L.export("acme"), null, 2)); console.log(`${ok(true)} wrote ${out} (${L.tenant("acme").journals.length} journals, head ${L.tenant("acme").head.slice(0, 16)}…)`);
  } else if (cmd === "verify") {
    if (!pos[0]) fail("usage: ledger verify <export.json>");
    const data = JSON.parse(readFileSync(pos[0], "utf8")), L = new Ledger();
    try { L.import(data); const v = L.verify(data.tenant.id), tb = L.trialBalance(data.tenant.id); console.log(`${ok(v.ok)} ${data.tenant.id}: ${v.checked} journals re-validated, chain intact, head ${v.head.slice(0, 16)}… · trial balance ${tb.balanced ? "balanced" : "UNBALANCED"}`); }
    catch (e) { console.log(`${ok(false)} ${c.red(e.code || "ERROR")} ${e.message}`); process.exit(1); }
  } else if (cmd === "bench") {
    const n = +flag("n", 100000), L = new Ledger(); L.createTenant("bench");
    for (let i = 0; i < 1000; i++) L.openAccount("bench", { code: "w" + i, type: "liability" }); L.openAccount("bench", { code: "bank", type: "asset" });
    L.post("bench", { entries: [{ account: "bank", dr: 1e12 }, ...Array.from({ length: 1000 }, (_, i) => ({ account: "w" + i, cr: 1e9 }))] });
    const lat = [], t0 = performance.now();
    for (let i = 0; i < n; i++) { const a = performance.now(); L.post("bench", { key: "k" + i, entries: [{ account: "w" + (i % 1000), dr: 100 }, { account: "w" + ((i * 7 + 1) % 1000), cr: 100 }] }); lat.push((performance.now() - a) * 1000); }
    const dt = (performance.now() - t0) / 1000, t1 = performance.now(), v = L.verify("bench"), vt = performance.now() - t1;
    console.log(header("ledger bench", `${num(n)} idempotent postings across 1,000 accounts, SHA-256 chained`));
    console.log(table([["throughput", num(n / dt) + " journals/s"], ["p50", lat.length && pct(0.5, lat).toFixed(1) + " µs"], ["p99", pct(0.99, lat).toFixed(1) + " µs"], ["full verify", `${num(v.checked)} journals in ${vt.toFixed(0)} ms ${ok(v.ok)}`]], { align: ["l", "r"] }));
  } else if (cmd === "serve") {
    const { createServer } = await import("../src/node/server.js"); const L = sample(); const port = +flag("port", 8788);
    L.post("acme", { key: "cap", entries: [{ account: "bank:hdfc", dr: "500000" }, { account: "equity:capital", cr: "500000" }] });
    createServer(L).listen(port, () => console.log(`${header("ledger serve")} http://localhost:${port}  ${c.dim("tenant acme · POST /v1/acme/journals (Idempotency-Key) · GET /v1/acme/trial-balance · POST /v1/acme/verify")}`));
  } else fail(`unknown command "${cmd}"\n\n${HELP}`);
} catch (e) { fail(e.message); }
