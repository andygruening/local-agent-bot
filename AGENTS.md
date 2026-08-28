# Repository Guidelines

## Project Purpose

`local-agent-bot` is a local Node.js TypeScript webhook receiver. It accepts GitHub webhook deliveries, saves each accepted event to disk, gathers GitHub issue or pull request context with `gh`, and launches a configured local agent runner such as Superset or Codex.

The core server, integrations, and agent runners are intentionally separated so additional webhook providers and runner CLIs can be added without coupling them to GitHub-specific behavior.

## Architecture Map

- `src/index.ts` - process bootstrap and server startup.
- `src/config/` - environment parsing and typed runtime configuration.
- `src/core/` - HTTP server, job persistence, webhook context, prompt generation, and agent selection.
- `src/integrations/` - integration contract plus GitHub parsing, context, reactions, comments, signatures, and response handling.
- `src/agents/` - agent runner contract plus Superset and Codex CLI implementations.
- `tests/` - Node test runner suites mirroring the source modules.
- `dist/` - generated build output. Do not edit by hand.
- `.webhook-events/` - local runtime delivery logs and agent artifacts. Do not commit.

## Toolchain

- Use Node.js 22.6 or newer.
- Use `pnpm` from the checked-in lockfile. Do not use npm, Yarn, or Bun for dependency changes.
- The package manager is pinned in `package.json` as `pnpm@11.20.0`.

## Common Commands

```bash
pnpm install
pnpm dev
pnpm check
pnpm build
pnpm start
```

- `pnpm check` runs TypeScript typechecking and all Node test suites.
- `pnpm build` cleans `dist/` and compiles with `tsconfig.build.json`.
- There is no lint or format script today; do not invent one for routine changes.

## Validation

Before finishing agent work that touches source, tests, config, or workflows, run:

```bash
pnpm check
pnpm build
```

For documentation-only changes, inspect the changed Markdown and run code checks only when the documented commands or behavior may have changed.

## Environment Policy

- Keep real secrets out of git.
- Use `.env.example` as the public template for supported settings.
- Local `.env`, `.env.local`, and `.env.*.local` files are private machine configuration.
- Do not log or commit webhook secrets, GitHub tokens, Superset API keys, OpenAI API keys, or captured delivery payloads containing private data.

## Coding Standards

- Keep modules focused around the existing contracts in `src/core`, `src/integrations`, and `src/agents`.
- Prefer typed data shapes and explicit parsing over ad hoc string handling.
- Use Node built-ins where the project already does, including the built-in test runner.
- Preserve the current ESM TypeScript style.
- Add tests beside the existing `tests/*.test.ts` suites for behavioral changes.
- Avoid broad refactors unless they are required for the requested change.

## Pull Request Workflow

- Work on a branch and open a pull request; do not push directly to `main`.
- Keep changes scoped to the issue or webhook request.
- Link the relevant issue or pull request in the PR body.
- Include the exact validation commands run and their outcomes.
- Note any skipped checks with a concrete reason.

## Safety Rules

- Do not run destructive git commands such as `git reset --hard` or `git checkout --` unless explicitly requested.
- Do not delete `.webhook-events/`, local env files, or generated logs unless the user asks.
- Do not change repository settings, branch protection, secrets, or deployment configuration without explicit approval.
- Do not post GitHub comments or reactions from an agent session when the webhook receiver owns response handling.
