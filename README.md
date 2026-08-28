# local-agent-bot

local-agent-bot is a local Node.js TypeScript server that receives webhooks, saves each delivery to disk, and launches a configured agent CLI from the matching tag. GitHub is the first integration; the core and agent runner interfaces are split out so more integrations and CLIs can be added later.

## Requirements

- Node.js 22.6 or newer. This project uses Node's built-in TypeScript type stripping for local development.
- `pnpm`.
- One supported agent runner:
  - Superset CLI installed and authenticated. Check with `superset auth whoami --json`.
  - Codex CLI installed and authenticated. Check with `codex doctor`.
- GitHub CLI available and authenticated where this server runs. Check with `gh auth status`.
- A GitHub webhook secret. The server can run unsigned for local experiments, but signed webhooks are the safe default.

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env`:

- Set `GITHUB_WEBHOOK_SECRET` to the same secret configured in GitHub.
- Set `AGENT_RUNNER=superset` or `AGENT_RUNNER=codex`.
- For Superset, set `SUPERSET_WORKSPACE_ID` and use Superset agent preset/config IDs such as `codex` or `claude`.
- For Codex CLI, use model names such as `gpt-5.5` in `CODEX_DEFAULT_MODEL` and `AGENT_TAGS`.
- Keep `GITHUB_RESPONSE_ENABLED=true` to let the server add/remove reactions and post the final result comment with `gh`.
- Keep `GITHUB_CONTEXT_ENABLED=true` to let the server fetch issue/PR comments and activity with `gh` before launching the agent.
- Keep `HOST=127.0.0.1` for local-only listening. Use a tunnel such as ngrok or Cloudflare Tunnel to expose it to GitHub.

## Run Locally

```bash
pnpm dev
```

The webhook endpoint defaults to:

```text
http://127.0.0.1:8787/webhooks/github
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## GitHub Webhook Settings

In the GitHub repository or organization webhook settings:

- Payload URL: your public tunnel URL plus `/webhooks/github`.
- Content type: `application/json`.
- Secret: the value from `GITHUB_WEBHOOK_SECRET`.
- Events: choose the events you want the receiver to inspect.

To avoid launching agents for every event, set an allow-list:

```env
ALLOWED_EVENTS=push,pull_request,issues,issue_comment,workflow_run
```

## Agent Tags

The receiver only launches an agent when the triggering webhook object contains an agent tag in a comment/body or label.

- `$agent` in text or label `agent` launches `AGENT_DEFAULT`. If `AGENT_DEFAULT` is empty, it falls back to the selected runner's default.
- Direct text tags such as `$codex`, `$claude`, or `$gpt-5.5`, or matching labels, launch that configured agent/model when the tag is listed in `AGENT_TAGS`.
- For comment events, only the new comment body is scanned. Existing issue or pull request bodies and labels are ignored so the receiver does not relaunch itself when it posts a result comment.

With `AGENT_RUNNER=superset`, the selected value is passed to `superset agents create --agent`. Superset expects an agent preset ID or HostAgentConfig UUID, not a raw model name. List your local choices with:

```bash
superset agents list --local
```

With `AGENT_RUNNER=codex`, the selected value is passed to `codex exec --model`. For example:

```env
AGENT_RUNNER=codex
CODEX_DEFAULT_MODEL=gpt-5.5
AGENT_TAGS=gpt-5.5,gpt-5.4
```

If multiple direct agent tags are present, the request is rejected as ambiguous. Text tags using `agent:<value>` are not special; add the desired preset/config ID or model name to `AGENT_TAGS` and trigger it directly with `$<id>`.

## What Happens Per Delivery

Each accepted webhook creates a directory under `.webhook-events/`:

```text
.webhook-events/<timestamp>_<integration>_<event>_<delivery>/
  webhook.json
  headers.json
  raw-body.json
  payload.json
  github-context.json
  github-context.md
  prompt.md
  job.json
  <runner-specific stdout/stderr/transcript files>
  agent-output.md
  agent-result.json
  github-response.json
  github-result-comment.md
```

The selected runner is launched from `AGENT_RUNNER`.

Superset runs as:

```bash
superset agents create --workspace <SUPERSET_WORKSPACE_ID> --agent <selected-agent> --prompt "<generated prompt>" --json
```

The selected agent is determined by the webhook tag. After `agents create` returns a terminal session ID, the receiver polls:

```bash
superset terminals read --workspace <SUPERSET_WORKSPACE_ID> --terminal <session-id> --json
```

Codex CLI runs as:

```bash
codex exec --model <selected-agent> --cd <working-directory> --output-last-message <job-dir>/codex-last-message.md -
```

The generated prompt is sent to Codex on stdin. The receiver returns `202` after the Codex process starts, then watches the process in the background until it exits.

Before launching the selected agent runner, the receiver uses `gh api` to add an `eyes` reaction to the triggering issue comment when possible, otherwise to the issue or pull request. Webhooks without an issue or pull request target are accepted but ignored with `github_response_target_not_found`.

Before launching the agent, the receiver fetches GitHub context with `gh api`:

- Target issue or pull request details.
- All issue comments.
- Issue events.
- Pull request review comments and reviews when the target is a PR.
- Open pull requests referenced by GitHub cross-references or explicit GitHub PR URLs in the issue/comments.

The receiver writes the full fetched JSON to `github-context.json` and a readable digest to `github-context.md`. The prompt tells the agent to read this context before acting. If the triggering comment appears to request integration or code changes, and the target or context includes a matching open PR, the prompt tells the agent to use that PR branch as the work target with `gh pr checkout`, then commit and push to that branch. If no matching open PR exists, the agent is instructed to create a branch, commit, push, and open a pull request with `gh pr create`. If the triggering comment does not ask for code changes, referenced PRs are context only and should not cause checkout/push/upload behavior.

The generated prompt asks the agent to write the GitHub-visible response to `agent-output.md` and then end with a `SUPERSET_WORKER_DONE` or `SUPERSET_WORKER_BLOCKED` envelope. The receiver ignores placeholder envelopes echoed from the prompt, waits for a valid final envelope for the current job, reads `agent-output.md`, posts that file with `gh issue comment`, logs the compact parsed result, writes that result to `agent-result.json`, adds `GITHUB_COMPLETION_REACTION` to the same target as the `eyes` reaction for completed runs, then removes the `eyes` reaction. If `agent-output.md` is missing or empty, the receiver logs a `read_agent_output` error and does not post scraped terminal text as a substitute.

GitHub's reactions API does not support a checkmark reaction content value. `GITHUB_COMPLETION_REACTION` defaults to `+1`; other supported completion values are `-1`, `laugh`, `confused`, `heart`, `hooray`, and `rocket`.

## Project Layout

```text
src/index.ts                    process bootstrap
src/config/                     grouped env parsing and config types
src/core/                       HTTP server, job persistence, prompts, tag selection
src/integrations/types.ts       integration contract
src/integrations/registry.ts    enabled integration registry
src/integrations/github/        GitHub webhook parsing, context, reactions, comments
src/agents/types.ts             agent runner contract
src/agents/registry.ts          enabled runner registry
src/agents/superset/            Superset CLI runner
src/agents/codex/               Codex CLI runner
src/agents/shared/              shared runner result parsing
```

## Safety Notes

- Leave `GITHUB_WEBHOOK_SECRET` set before exposing the server outside your machine.
- The server uses `spawn` with an argument array, not a shell string.
- Agent runners receive a minimal environment by default so repo-controlled commands do not inherit all of your shell secrets.
- Add required environment variables explicitly with `SUPERSET_ENV_PASSTHROUGH_JSON` or `CODEX_ENV_PASSTHROUGH_JSON`.
- `SUPERSET_API_KEY` and `SUPERSET_API_URL` are included by default when present.
- `OPENAI_API_KEY` and `CODEX_HOME` are included for Codex CLI by default when present.
- GitHub response and context commands receive a separate minimal environment controlled by `GITHUB_ENV_PASSTHROUGH_JSON`.

## Testing

```bash
pnpm check
```

Run without launching an agent:

```bash
DRY_RUN=true pnpm dev
```

Build compiled JavaScript:

```bash
pnpm build
pnpm start
```

## Manual Signed Test

With the server running and `GITHUB_WEBHOOK_SECRET=dev-secret`:

```bash
body='{"zen":"Keep it logically awesome.","comment":{"id":456,"body":"$codex"},"issue":{"number":123},"repository":{"full_name":"octo/example"},"sender":{"login":"octocat"}}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac 'dev-secret' -binary | xxd -p -c 256)"

curl -i http://127.0.0.1:8787/webhooks/github \
  -H "content-type: application/json" \
  -H "x-github-event: issue_comment" \
  -H "x-github-delivery: local-test" \
  -H "x-hub-signature-256: $sig" \
  --data "$body"
```
