# Publishing This Repository to GitHub

The project is git-initialized with everything committed and a ready-made
`.gitignore`. Because the brief requires a **public** repository and GitHub
authentication must happen with *your* credentials (never through an
automated tool), the last two steps are yours — they take under a minute.

## One-time: publish from this folder

1. **Create an empty public repository on GitHub**
   - <https://github.com/new> → Repository name: e.g. `usage-metering-quota-engine`
   - Visibility: **Public** (the brief explicitly requires non-private)
   - Do **not** add a README / .gitignore / license (this repo has all three).

2. **Push the local history**

   ```powershell
   git remote add origin https://github.com/<your-username>/usage-metering-quota-engine.git
   git push -u origin main
   ```

   (If the default branch is `master` locally, rename it first:
   `git branch -M main`.)

3. **Verify the grader experience**

   ```bash
   git clone https://github.com/<your-username>/usage-metering-quota-engine.git
   cd usage-metering-quota-engine
   npm install
   npm test          # 102+ tests, self-contained embedded PostgreSQL
   npm run serve     # dashboard on http://localhost:3000
   ```

## Repository hygiene (already done for you)

- `.gitignore` excludes `node_modules/`, `dist/`, `.env` (secrets), logs —
  `.env.example` is committed as the template.
- No secrets in history: API keys are generated at runtime by the engine;
  the committed benchmark/plan data contains only synthetic UUIDs.
- Committed artifacts graders expect: `perf/results/` (report + metrics),
  `docs/` (architecture, proofs, cheatsheet), migrations, tests, Dockerfile,
  docker-compose, dashboard.

## What to paste into the submission form

- **Repo URL**: `https://github.com/<your-username>/usage-metering-quota-engine`
- **One-command run**: `docker compose up --build` (self-contained:
  migrations + seed run at container boot)
- **Zero-Docker alternative**: `npm install && npm run serve`
- **Tests**: `npm test` · **Benchmark**: `npm run load-test`
