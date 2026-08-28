import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config/index.ts";

test("readConfig applies safe local defaults", () => {
  const config = readConfig({});

  assert.equal(config.core.host, "127.0.0.1");
  assert.equal(config.core.port, 8787);
  assert.equal(config.integrations.github.webhookPath, "/webhooks/github");
  assert.equal(config.agents.runner, "superset");
  assert.equal(config.agents.selection.triggerTag, "agent");
  assert.equal(config.agents.selection.defaultAgent, "codex");
  assert.deepEqual(config.agents.selection.tags, ["codex", "claude"]);
  assert.equal(config.agents.superset.command, "superset");
  assert.equal(config.agents.superset.defaultAgent, "codex");
  assert.deepEqual(config.agents.superset.tags, ["codex", "claude"]);
  assert.deepEqual(config.agents.superset.extraArgs, []);
  assert.deepEqual(config.agents.superset.envPassthrough, [
    "SUPERSET_API_KEY",
    "SUPERSET_API_URL"
  ]);
  assert.equal(config.agents.codex.command, "codex");
  assert.equal(config.agents.codex.defaultModel, "gpt-5.5");
  assert.deepEqual(config.agents.codex.extraArgs, []);
  assert.deepEqual(config.agents.codex.envPassthrough, ["OPENAI_API_KEY", "CODEX_HOME"]);
  assert.equal(config.agents.codex.sandbox, undefined);
  assert.equal(config.agents.codex.approvalPolicy, undefined);
  assert.equal(config.agents.codex.workingDirectory, undefined);
  assert.equal(config.agents.codex.execTimeoutMs, 3_600_000);
  assert.equal(config.integrations.github.responseEnabled, true);
  assert.equal(config.integrations.github.contextEnabled, true);
  assert.equal(config.integrations.github.contextInlineMaxBytes, 120_000);
  assert.equal(config.integrations.github.command, "gh");
  assert.equal(config.integrations.github.completionReaction, "+1");
  assert.deepEqual(config.integrations.github.envPassthrough, ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]);
});

test("readConfig parses allow-lists and JSON argument arrays", () => {
  const config = readConfig({
    AGENT_RUNNER: "codex",
    AGENT_DEFAULT: "gpt-5.5",
    AGENT_TAGS: "gpt-5.5, gpt-5.4",
    ALLOWED_EVENTS: "push, pull_request",
    SUPERSET_DEFAULT_AGENT: "claude",
    SUPERSET_AGENT_TAGS: "codex, claude",
    SUPERSET_EXTRA_ARGS_JSON: "[\"--effort\",\"high\"]",
    SUPERSET_ENV_PASSTHROUGH_JSON: "[\"SUPERSET_API_KEY\"]",
    CODEX_COMMAND: "/opt/bin/codex",
    CODEX_DEFAULT_MODEL: "gpt-5.5",
    CODEX_EXTRA_ARGS_JSON: "[\"--search\"]",
    CODEX_ENV_PASSTHROUGH_JSON: "[\"OPENAI_API_KEY\"]",
    CODEX_SANDBOX: "workspace-write",
    CODEX_APPROVAL_POLICY: "never",
    CODEX_WORKING_DIRECTORY: "/tmp/project",
    CODEX_EXEC_TIMEOUT_MS: "12345",
    GITHUB_CONTEXT_ENABLED: "false",
    GITHUB_CONTEXT_INLINE_MAX_BYTES: "1234",
    GITHUB_COMPLETION_REACTION: "rocket",
    GITHUB_ENV_PASSTHROUGH_JSON: "[\"GH_TOKEN\"]"
  });

  assert.equal(config.core.allowedEvents?.has("push"), true);
  assert.equal(config.core.allowedEvents?.has("pull_request"), true);
  assert.equal(config.agents.runner, "codex");
  assert.equal(config.agents.selection.defaultAgent, "gpt-5.5");
  assert.deepEqual(config.agents.selection.tags, ["gpt-5.5", "gpt-5.4"]);
  assert.equal(config.agents.superset.defaultAgent, "claude");
  assert.deepEqual(config.agents.superset.tags, ["codex", "claude"]);
  assert.deepEqual(config.agents.superset.extraArgs, ["--effort", "high"]);
  assert.deepEqual(config.agents.superset.envPassthrough, ["SUPERSET_API_KEY"]);
  assert.equal(config.agents.codex.command, "/opt/bin/codex");
  assert.equal(config.agents.codex.defaultModel, "gpt-5.5");
  assert.deepEqual(config.agents.codex.extraArgs, ["--search"]);
  assert.deepEqual(config.agents.codex.envPassthrough, ["OPENAI_API_KEY"]);
  assert.equal(config.agents.codex.sandbox, "workspace-write");
  assert.equal(config.agents.codex.approvalPolicy, "never");
  assert.equal(config.agents.codex.workingDirectory, "/tmp/project");
  assert.equal(config.agents.codex.execTimeoutMs, 12345);
  assert.equal(config.integrations.github.contextEnabled, false);
  assert.equal(config.integrations.github.contextInlineMaxBytes, 1234);
  assert.equal(config.integrations.github.completionReaction, "rocket");
  assert.deepEqual(config.integrations.github.envPassthrough, ["GH_TOKEN"]);
});

test("readConfig rejects unsafe config shapes", () => {
  assert.throws(() => readConfig({ SUPERSET_EXTRA_ARGS_JSON: "\"--effort\"" }));
  assert.throws(() => readConfig({ CODEX_EXTRA_ARGS_JSON: "\"--search\"" }));
  assert.throws(() => readConfig({ CODEX_ENV_PASSTHROUGH_JSON: "\"OPENAI_API_KEY\"" }));
  assert.throws(() => readConfig({ CODEX_SANDBOX: "full" }));
  assert.throws(() => readConfig({ CODEX_APPROVAL_POLICY: "always" }));
  assert.throws(() => readConfig({ CODEX_EXEC_TIMEOUT_MS: "0" }));
  assert.throws(() => readConfig({ GITHUB_ENV_PASSTHROUGH_JSON: "\"GH_TOKEN\"" }));
  assert.throws(() => readConfig({ GITHUB_COMPLETION_REACTION: "eyes" }));
  assert.throws(() => readConfig({ GITHUB_COMPLETION_REACTION: "white_check_mark" }));
  assert.throws(() => readConfig({ GITHUB_CONTEXT_INLINE_MAX_BYTES: "0" }));
  assert.throws(() => readConfig({ SUPERSET_TERMINAL_MAX_POLLS: "0" }));
});

test("readConfig keeps compatibility with previous model-named env vars", () => {
  const config = readConfig({
    SUPERSET_DEFAULT_AGENT_MODEL: "codex",
    SUPERSET_AGENT_MODEL_TAGS: "codex,claude"
  });

  assert.equal(config.agents.superset.defaultAgent, "codex");
  assert.deepEqual(config.agents.superset.tags, ["codex", "claude"]);
  assert.equal(config.agents.selection.defaultAgent, "codex");
  assert.deepEqual(config.agents.selection.tags, ["codex", "claude"]);
});

test("readConfig uses Codex model defaults when Codex is the selected runner", () => {
  const config = readConfig({
    AGENT_RUNNER: "codex"
  });

  assert.equal(config.agents.selection.defaultAgent, "gpt-5.5");
  assert.deepEqual(config.agents.selection.tags, ["gpt-5.5"]);
});
