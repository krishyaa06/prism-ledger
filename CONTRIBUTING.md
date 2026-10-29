# Contributing to prism-ledger

Thanks for taking the time to contribute! prism-ledger is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism Ledger is the money core of a wallet, marketplace or payments company. Every movement is a journal of debit and credit legs that must balance per currency, and it is validated in full before anything is applied, so a journal either lands completely or not at all. Idempotency keys turn client retries into safe replays, and a key reused with a different payload is a 409 conflict. Holds reserve funds for card authorisations and withdrawals, then capture all or part of them. Each tenant has isolated accounts and its own SHA-256 hash chain: editing, deleting or reordering any journal is detected, and a Merkle root over all chains can be published as an external anchor. A reconciliation engine matches expected cash movements against bank statements by reference, by amount and date, net of fees, and as many-to-one settlement batches (using a bounded subset sum). Anything left over becomes a categorised break.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-ledger.git
cd prism-ledger
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-ledger/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
