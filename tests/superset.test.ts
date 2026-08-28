import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config/index.ts";
import { startSupersetAgentJob } from "../src/agents/superset/index.ts";
import type { WebhookContext } from "../src/core/prompt.ts";

test("startSupersetAgentJob launches tagged agent and logs terminal result", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "superset-job-"));
  const fakeSupersetPath = path.join(tempDir, "fake-superset.mjs");
  const argsPath = path.join(tempDir, "args.jsonl");
  const readCountPath = path.join(tempDir, "read-count.txt");
  const workerOutputPath = path.join(tempDir, "job", "agent-output.md");
  const publicAgentOutput = "Agent finished the requested work.\n\n- Added focused tests.";
  const promptEcho =
    "› You are a new Superset terminal agent session launched by a local GitHub webhook receiver.\n\n  ```text\n  SUPERSET_WORKER_DONE\n  task: job-1\n  summary: <one-line outcome>\n  files: <comma-separated paths or none>\n  checks: <commands and outcomes>\n  handoff: <next-step context or none>\n  ```\n\n• Working (9s • esc to interrupt)\n";
  const completedTerminalText = `${promptEcho}\n${publicAgentOutput}\nSUPERSET_WORKER_DONE\ntask: job-1\nsummary: fake agent result\nfiles: none\nchecks: fake check passed\nhandoff: none\n`;
  await writeFile(
    fakeSupersetPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");

if (process.argv[2] === "agents" && process.argv[3] === "create") {
  process.stdout.write(JSON.stringify({ kind: "terminal", sessionId: "terminal-1", label: "fake-agent" }), () => {
    process.exit(0);
  });
} else if (process.argv[2] === "terminals" && process.argv[3] === "read") {
  const readCountPath = ${JSON.stringify(readCountPath)};
  const count = existsSync(readCountPath) ? Number(readFileSync(readCountPath, "utf8")) : 0;
  writeFileSync(readCountPath, String(count + 1));
  if (count === 0) {
    process.stdout.write(JSON.stringify({ text: ${JSON.stringify(promptEcho)} }), () => {
      process.exit(0);
    });
  } else {
    writeFileSync(${JSON.stringify(workerOutputPath)}, ${JSON.stringify(publicAgentOutput)});
    process.stdout.write(JSON.stringify({
      text: ${JSON.stringify(completedTerminalText)}
    }), () => {
      process.exit(0);
    });
  }
} else {
  process.stderr.write("unexpected command", () => {
    process.exit(1);
  });
}
`
  );
  await chmod(fakeSupersetPath, 0o755);

  const config = readConfig({
    SUPERSET_COMMAND: fakeSupersetPath,
    SUPERSET_WORKSPACE_ID: "workspace-1",
    SUPERSET_TERMINAL_POLL_INTERVAL_MS: "1",
    SUPERSET_TERMINAL_MAX_POLLS: "3",
    WEBHOOK_EVENT_DIR: tempDir
  });
  const context = buildWebhookContext(tempDir);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const job = await startSupersetAgentJob(config, context, "test prompt should not be logged");
    await waitFor(async () => {
      const metadata = JSON.parse(await readFile(job.metadataPath, "utf8")) as { status: string };
      return metadata.status === "completed";
    });

    const metadata = JSON.parse(await readFile(job.metadataPath, "utf8")) as {
      status: string;
      agent: string;
      runnerId: string;
      sessionId: string;
      args: string[];
      stdoutPath: string;
      agentOutputPath: string;
    };
    const result = JSON.parse(await readFile(job.resultPath, "utf8")) as {
      summary: string;
      checks: string;
    };
    const savedAgentOutput = await readFile(job.agentOutputPath, "utf8");
    const fakeArgs = await readFile(argsPath, "utf8");

    assert.equal(metadata.status, "completed");
    assert.equal(metadata.agent, "claude");
    assert.equal(metadata.runnerId, "superset");
    assert.equal(metadata.sessionId, "terminal-1");
    assert.equal(metadata.stdoutPath, job.stdoutPath);
    assert.equal(metadata.agentOutputPath, job.agentOutputPath);
    assert.deepEqual(metadata.args, [
      "agents",
      "create",
      "--workspace",
      "workspace-1",
      "--agent",
      "claude",
      "--prompt",
      "<prompt omitted>",
      "--json"
    ]);
    assert.equal(result.summary, "fake agent result");
    assert.equal(result.checks, "fake check passed");
    assert.equal(savedAgentOutput, publicAgentOutput);
    assert.match(fakeArgs, /"claude"/);
    assert.match(fakeArgs, /test prompt should not be logged/);
    assert.doesNotMatch(fakeArgs, /"--max-lines"/);
    assert.match(fakeArgs, /"terminals","read"/);
    assert.equal((fakeArgs.match(/"terminals","read"/g) ?? []).length, 2);
    assert.match(logs.join("\n"), /Starting Superset agent session:/);
    assert.match(logs.join("\n"), /Superset agent session started:/);
    assert.match(logs.join("\n"), /Superset agent session finished:/);
    assert.match(logs.join("\n"), /fake agent result/);
    assert.doesNotMatch(logs.join("\n"), /test prompt should not be logged/);
  } finally {
    console.log = originalLog;
  }
});

function buildWebhookContext(tempDir: string): WebhookContext {
  const jobDir = path.join(tempDir, "job");

  return {
    integrationId: "github",
    integrationName: "GitHub",
    agentRunnerId: "superset",
    agentRunnerName: "Superset",
    receivedAt: "2026-08-28T00:00:00.000Z",
    eventName: "issues",
    deliveryId: "delivery-2",
    jobId: "job-1",
    jobDir,
    envelopePath: path.join(jobDir, "webhook.json"),
    rawBodyPath: path.join(jobDir, "raw-body.json"),
    payloadPath: path.join(jobDir, "payload.json"),
    headersPath: path.join(jobDir, "headers.json"),
    promptPath: path.join(jobDir, "prompt.md"),
    agentOutputPath: path.join(jobDir, "agent-output.md"),
    agentSelection: {
      agent: "claude",
      tag: "claude",
      source: "text",
      usesDefaultAgent: false
    },
    integrationPrompt: {
      savedFiles: "- GitHub issue/PR context: skipped (github_context_disabled)",
      guidance: "No extended GitHub issue/PR context was fetched for this delivery.",
      responseInstructions:
        "The webhook receiver owns GitHub reactions and final result comments. Do not add reactions or post GitHub comments yourself.",
      inlineContext: ""
    },
    metadata: {
      action: "opened",
      repositoryFullName: "octo/example",
      senderLogin: "octocat"
    },
    payload: {
      action: "opened",
      repository: { full_name: "octo/example" },
      sender: { login: "octocat" }
    },
    headers: {},
    rawBodyBytes: 2
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2_000) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error("Timed out waiting for condition");
}
