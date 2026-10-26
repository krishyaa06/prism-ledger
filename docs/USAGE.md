# Prism Ledger — Usage

## Install

```bash
npm install github:krishyaa06/prism-ledger
# or run the CLI directly
npx github:krishyaa06/prism-ledger --help
```

## JavaScript API

```js
import { Ledger, reconcile } from "prism-ledger";

const L = new Ledger();
L.createTenant("acme", { currency: "INR" });
L.openAccount("acme", { code: "bank:hdfc", type: "asset" });
L.openAccount("acme", { code: "wallet:asha", type: "liability" });
L.openAccount("acme", { code: "merchant:chai", type: "liability" });
L.openAccount("acme", { code: "revenue:fees", type: "revenue" });

L.post("acme", { key: "tp-1", entries: [{ account: "bank:hdfc", dr: "2000" }, { account: "wallet:asha", cr: "2000" }] });

// three legs, strings are exact decimals, integers are minor units (paise)
const { journal, replay } = L.post("acme", {
  key: "pay-1", memo: "QR payment",
  entries: [{ account: "wallet:asha", dr: "120" }, { account: "merchant:chai", cr: "117.60" }, { account: "revenue:fees", cr: "2.40" }],
});
L.post("acme", { key: "pay-1", /* same body */ ... }).replay;     // true: retries never double-post

const { hold } = L.hold("acme", { account: "wallet:asha", to: "bank:hdfc", amount: "600" });
L.commit("acme", hold.id, { amount: "500" });                        // capture part, release the rest
L.reverse("acme", journal.id);                                       // refund
L.balance("acme", "wallet:asha", { asOf: Date.parse("2026-10-01") });
L.trialBalance("acme").balanced;                                     // true
L.verify("acme");                                                    // { ok, checked, head } or where it broke
L.anchor().root;                                                     // Merkle root over every tenant chain

reconcile(expectedLines, bankLines, { settlementBps: 150 });         // matches + categorised breaks
```

| Export | What it does |
|---|---|
| `new Ledger({ clock, idempotencyTTL })` | The ledger |
| `.createTenant(id, { name, currency })` · `.openAccount(t, { code, type, currency, allowNegative })` · `.freeze(t, code)` | Isolation and chart of accounts (`asset`, `liability`, `equity`, `revenue`, `expense`) |
| `.post(t, { key, ref, memo, at, entries, meta, ifVersion })` | Atomic journal → `{ journal, replay }`; errors are `LedgerError` with `code` and HTTP `status` |
| `.postBatch(t, reqs)` · `.reverse(t, id, { key })` | All-or-nothing batches, one-time reversals |
| `.hold(t, { account, to, amount, key, expiresAt })` · `.commit(t, id, { amount })` · `.void(t, id)` · `.expireHolds(t)` | Two-phase transfers |
| `.balance(t, code, { asOf \| asOfSeq })` · `.available(t, code)` · `.statement(t, code)` · `.trialBalance(t)` · `.balanceSheet(t)` | Reads |
| `.verify(t, { fromSeq })` · `.anchor()` · `.export(t)` · `.import(data)` | Integrity and persistence |
| `reconcile(ledger, bank, { dateTol, feeBps, settlementBps, batch })` · `subsetSum` · `parseCSV` | Reconciliation |
| `toMinor` · `fmtMoney` · `fmtShort` · `allocate` · `bps` · `CURRENCIES` | Exact money helpers |
| `new Platform({ seed, rate, settleEvery })` · `TENANTS` | Synthetic payments platform used by the simulator |
| `createServer(ledger)` from `src/node/server.js` | HTTP API |

## CLI

```bash
$ npx github:krishyaa06/prism-ledger demo
$ npx github:krishyaa06/prism-ledger simulate --minutes 5
$ npx github:krishyaa06/prism-ledger recon examples/expected.csv examples/bank.csv
$ npx github:krishyaa06/prism-ledger export --out ledger.json && npx github:krishyaa06/prism-ledger verify ledger.json
$ npx github:krishyaa06/prism-ledger bench
$ npx github:krishyaa06/prism-ledger serve --port 8788
```

| Command | Description |
|---|---|
| `ledger demo` | Postings, retries replayed, every rejection type, holds, reversal, trial balance, tamper detection |
| `ledger simulate [--minutes 5 --rate 14 --seed 7]` | Three tenants of traffic, continuous reconciliation, injected anomalies checked against ground truth |
| `ledger recon <expected.csv> <bank.csv> [--fee-bps 150 --days 3]` | Reconcile ledger cash lines with a bank statement |
| `ledger export [--out file]` · `ledger verify <file>` | Write a tenant export, then re-validate every journal and hash |
| `ledger bench [--n 100000]` | Posting throughput, latency percentiles and full-verify time |
| `ledger serve [--port 8788]` | HTTP API |

## Live simulator

Open [https://krishyaa06.github.io/prism-ledger/](https://krishyaa06.github.io/prism-ledger/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
