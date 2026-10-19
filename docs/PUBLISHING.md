# Publishing This Repository

The project is git-initialized with all work on `main` and a ready-made
`.gitignore` (dependencies, build output, and `.env` are excluded —
`.env.example` is committed as the template). GitHub authentication uses
your own credentials, so the push happens from your machine.

## 1. Create the repository on GitHub

<https://github.com/new> — name it `usage-metering-quota-engine`, set
visibility to **Public**, and do **not** initialize a README, `.gitignore`,
or license (this repository already has all three).

## 2. Push

```bash
git remote add origin https://github.com/<your-username>/usage-metering-quota-engine.git
git push -u origin main
```

Rename the branch first if needed: `git branch -M main`.

## 3. Verify the fresh-clone experience

```bash
git clone https://github.com/<your-username>/usage-metering-quota-engine.git
cd usage-metering-quota-engine
npm install
npm test          # 127 tests; boots its own embedded PostgreSQL
npm run serve     # dashboard on http://localhost:3000
```

## What CI does on push

The committed workflow (`.github/workflows/ci.yml`) runs on every push:
type-check, production build, and the full test suite on a bare GitHub
runner — the suites boot their own embedded PostgreSQL, so no secrets or
services are required. The benchmark job is manual (`workflow_dispatch`)
and uploads `perf/results/` as artifacts.

## Repository hygiene notes

- No secrets are committed: API keys are generated at runtime by the engine;
  the committed benchmark and plan data contain only synthetic UUIDs.
- Committed artifacts: `perf/results/` (report + metrics), `docs/`
  (architecture, proofs, Q&A, publishing), migrations, tests, Dockerfile,
  compose file, and the dashboard.
