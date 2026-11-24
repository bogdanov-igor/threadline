# Contributing to Threadline

Thank you for helping. Issues and pull requests are welcome in English or Russian.

## Setup

You need Node.js 24 (`.nvmrc`), pnpm 12 and, for the server catalog tests, Docker.

```bash
nvm use                      # or any other way to get Node 24
npm install -g pnpm@12
pnpm install
pnpm local                   # the whole service on your machine with the demo project, no database or sign-in
pnpm dev                     # interface with hot reload at http://localhost:5173, server on :8080
```

`pnpm dev` runs the server with `config/threadline.yaml`; copy `.env.example` to `.env` and set `THREADLINE_ALLOW_NO_LOGIN=1` to start it without sign-in. More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Tests

Run these before you open a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm test        # unit tests of packages/core, apps/server and apps/web
pnpm build
pnpm test:e2e    # Playwright; once: pnpm --filter @threadline/web exec playwright install chromium
```

- The server catalog tests need PostgreSQL 16. With Docker running they start a `postgres:16-alpine` container on port `55432` by themselves. Your own server: `THREADLINE_TEST_DATABASE_URL=postgres://user:password@host:port/postgres`, the user must be allowed to create databases.
- End-to-end tests start their own servers on ports 8089–8099 and 8495 with an embedded database and simulated logs; they never touch a running Threadline or a real Loki.
- A change in behaviour comes with a test. A bug fix comes with a test that fails without the fix.

## Code and texts

- TypeScript everywhere; the server runs straight from `.ts` files with Node 24, there is no build step for it.
- Shared logic (search, masking, catalog rules, flow model) belongs in `packages/core`, so the server and the interface agree.
- Every interface string goes into both `apps/web/src/i18n/ru.json` and `en.json`; a test checks that they match.
- Documentation pages live in `apps/web/src/features/docs/content/ru` and `en`. When you change what a user sees, update both languages.
- Never put real log lines, hosts, tokens, card numbers or personal data into the repository: tests and examples use invented values and `*.example` addresses.
- `pnpm format` runs Prettier.

## Commits

One commit, one change. The message is one plain sentence that says what changed and, if it is not obvious, why. Russian or English, no prefixes or tags:

```text
Search: a phone number with brackets is found in every spelling
```

## Pull requests

- Keep a pull request to one topic and fill in the template.
- Describe what changes for the user; add a screenshot for interface changes.
- All the checks above must pass. A reviewer may ask for tests or documentation before merging.
- By submitting a pull request you agree that your contribution is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), and that Igor Bogdanov and Aleksandr Ivanov may also license it to others on commercial terms. You keep the copyright to your work.

Security problems are not reported in issues: see [SECURITY.md](SECURITY.md).
