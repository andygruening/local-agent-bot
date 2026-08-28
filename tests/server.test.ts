import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { readConfig } from "../src/config/index.ts";
import { createWebhookServer, type AgentLauncher } from "../src/core/server.ts";

test("webhook endpoint persists payload and launches a Superset agent", async () => {
  const eventDir = await mkdtemp(path.join(tmpdir(), "webhook-receiver-"));
  const secret = "webhook-secret";
  const config = readConfig({
    GITHUB_WEBHOOK_SECRET: secret,
    WEBHOOK_EVENT_DIR: eventDir,
    SUPERSET_WORKSPACE_ID: "workspace-1",
    GITHUB_CONTEXT_ENABLED: "false",
    GITHUB_RESPONSE_ENABLED: "false"
  });
  const launched: string[] = [];
  const launcher: AgentLauncher = async (_config, context, prompt) => {
    launched.push(prompt);
    return {
      jobId: context.jobId,
      status: "running",
      agent: context.agentSelection.agent,
      runnerId: "superset",
      runnerName: "Superset",
      command: "superset",
      args: ["agents", "create", "--agent", context.agentSelection.agent],
      jobDir: context.jobDir,
      stdoutPath: path.join(context.jobDir, "superset-create.stdout.json"),
      stderrPath: path.join(context.jobDir, "superset-create.stderr.log"),
      transcriptPath: path.join(context.jobDir, "superset-terminal-snapshot.json"),
      createStdoutPath: path.join(context.jobDir, "superset-create.stdout.json"),
      createStderrPath: path.join(context.jobDir, "superset-create.stderr.log"),
      terminalSnapshotPath: path.join(context.jobDir, "superset-terminal-snapshot.json"),
      agentOutputPath: path.join(context.jobDir, "agent-output.md"),
      resultPath: path.join(context.jobDir, "agent-result.json"),
      metadataPath: path.join(context.jobDir, "job.json"),
      promptPath: context.promptPath,
      startedAt: new Date().toISOString()
    };
  };
  const server = createWebhookServer(config, launcher);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  await listen(server);

  try {
    const payload = {
      action: "opened",
      comment: { body: "$codex please handle this" },
      issue: { number: 123 },
      repository: { full_name: "octo/example" },
      sender: { login: "octocat" }
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const response = await fetch(serverUrl(server, config.integrations.github.webhookPath), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature
      },
      body: rawBody
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as {
      jobDir: string;
      jobId: string;
      github: {
        contextSkippedReason: string;
      };
    };
    assert.equal(launched.length, 1);
    assert.match(launched[0] ?? "", /pull_request/);
    assert.match(launched[0] ?? "", /octo\/example/);
    assert.match(launched[0] ?? "", /Selected agent: codex/);
    assert.match(launched[0] ?? "", /GitHub issue\/PR context: skipped/);
    assert.equal(body.github.contextSkippedReason, "github_context_disabled");

    const persistedPayload = JSON.parse(
      await readFile(path.join(body.jobDir, "payload.json"), "utf8")
    ) as typeof payload;
    assert.deepEqual(persistedPayload, payload);
    assert.match(body.jobId, /pull_request_delivery-1/);
    assert.match(logs.join("\n"), /Received GitHub webhook:/);
    assert.match(logs.join("\n"), /octo\/example/);
    assert.match(logs.join("\n"), /codex/);
    assert.doesNotMatch(logs.join("\n"), /"payload":/);
    assert.doesNotMatch(logs.join("\n"), /x-hub-signature-256/);
  } finally {
    console.log = originalLog;
    await close(server);
  }
});

test("webhook endpoint rejects invalid signatures", async () => {
  const eventDir = await mkdtemp(path.join(tmpdir(), "webhook-receiver-"));
  const config = readConfig({
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    WEBHOOK_EVENT_DIR: eventDir,
    SUPERSET_WORKSPACE_ID: "workspace-1",
    GITHUB_CONTEXT_ENABLED: "false",
    GITHUB_RESPONSE_ENABLED: "false"
  });
  const server = createWebhookServer(config, async () => {
    throw new Error("launcher should not be called");
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  await listen(server);

  try {
    const response = await fetch(serverUrl(server, config.integrations.github.webhookPath), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=wrong"
      },
      body: "{}"
    });

    assert.equal(response.status, 401);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Rejected request:/);
    assert.match(warnings[0] ?? "", /invalid_signature/);
    assert.doesNotMatch(warnings[0] ?? "", /sha256=wrong/);
  } finally {
    console.warn = originalWarn;
    await close(server);
  }
});

test("webhook endpoint ignores valid requests without an agent tag", async () => {
  const eventDir = await mkdtemp(path.join(tmpdir(), "webhook-receiver-"));
  const secret = "webhook-secret";
  const config = readConfig({
    GITHUB_WEBHOOK_SECRET: secret,
    WEBHOOK_EVENT_DIR: eventDir,
    SUPERSET_WORKSPACE_ID: "workspace-1",
    GITHUB_CONTEXT_ENABLED: "false",
    GITHUB_RESPONSE_ENABLED: "false"
  });
  const server = createWebhookServer(config, async () => {
    throw new Error("launcher should not be called");
  });
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  await listen(server);

  try {
    const payload = {
      action: "opened",
      comment: { body: "please investigate" },
      repository: { full_name: "octo/example" },
      sender: { login: "octocat" }
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const response = await fetch(serverUrl(server, config.integrations.github.webhookPath), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature
      },
      body: rawBody
    });
    const body = (await response.json()) as { ignored: boolean; reason: string };

    assert.equal(response.status, 202);
    assert.equal(body.ignored, true);
    assert.equal(body.reason, "agent_tag_not_found");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await close(server);
  }
});

test("webhook endpoint does not relaunch from issue tags on untagged comments", async () => {
  const eventDir = await mkdtemp(path.join(tmpdir(), "webhook-receiver-"));
  const secret = "webhook-secret";
  const config = readConfig({
    GITHUB_WEBHOOK_SECRET: secret,
    WEBHOOK_EVENT_DIR: eventDir,
    SUPERSET_WORKSPACE_ID: "workspace-1",
    GITHUB_CONTEXT_ENABLED: "false",
    GITHUB_RESPONSE_ENABLED: "false"
  });
  const server = createWebhookServer(config, async () => {
    throw new Error("launcher should not be called");
  });
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  await listen(server);

  try {
    const payload = {
      action: "created",
      comment: { body: "Completed without a trigger tag." },
      issue: {
        number: 123,
        body: "$codex please handle this",
        labels: [{ name: "codex" }]
      },
      repository: { full_name: "octo/example" },
      sender: { login: "octocat" }
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const response = await fetch(serverUrl(server, config.integrations.github.webhookPath), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-3",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature
      },
      body: rawBody
    });
    const body = (await response.json()) as { ignored: boolean; reason: string };

    assert.equal(response.status, 202);
    assert.equal(body.ignored, true);
    assert.equal(body.reason, "agent_tag_not_found");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await close(server);
  }
});

function listen(server: ReturnType<typeof createWebhookServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: ReturnType<typeof createWebhookServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function serverUrl(server: ReturnType<typeof createWebhookServer>, pathname: string): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${pathname}`;
}
