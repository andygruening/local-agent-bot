import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config/index.ts";
import {
  buildCodexEnv,
  buildCodexExecArgs,
  startCodexAgentJob
} from "../src/agents/codex/index.ts";
import type { WebhookContext } from "../src/core/prompt.ts";

test("buildCodexExecArgs runs Codex non-interactively with selected model", () => {
  const args = buildCodexExecArgs(
    readConfig({
      AGENT_RUNNER: "codex",
      CODEX_SANDBOX: "workspace-write",
      CODEX_APPROVAL_POLICY: "never",
      CODEX_WORKING_DIRECTORY: "/tmp/project",
      CODEX_EXTRA_ARGS_JSON: "[\"--search\"]"
    }),
    "gpt-5.5",
    "/tmp/job/codex-last-message.md"
  );

  assert.deepEqual(args, [
    "exec",
    "--model",
    "gpt-5.5",
    "--cd",
    "/tmp/project",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--output-last-message",
    "/tmp/job/codex-last-message.md",
    "--color",
    "never",
    "--search",
    "-"
  ]);
});

test("startCodexAgentJob launches codex exec and records the completed result", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-job-"));
  const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
  const argsPath = path.join(tempDir, "args.jsonl");
  const workerOutputPath = path.join(tempDir, "job", "agent-output.md");
  const publicAgentOutput = "Codex finished the requested work.";
  const finalMessage = `${publicAgentOutput}
SUPERSET_WORKER_DONE
task: job-1
summary: codex agent result
files: none
checks: fake check passed
handoff: none
`;

  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + "\\n");

let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (!stdin.includes("test prompt should not be logged")) {
    process.stderr.write("missing prompt", () => {
      process.exit(1);
    });
    return;
  }

  const outputIndex = args.indexOf("--output-last-message");
  writeFileSync(args[outputIndex + 1], ${JSON.stringify(finalMessage)});
  writeFileSync(${JSON.stringify(workerOutputPath)}, ${JSON.stringify(publicAgentOutput)});
  process.stdout.write("codex stdout", () => {
    process.exit(0);
  });
});
`
  );
  await chmod(fakeCodexPath, 0o755);

  const config = readConfig({
    AGENT_RUNNER: "codex",
    AGENT_DEFAULT: "gpt-5.5",
    AGENT_TAGS: "gpt-5.5",
    CODEX_COMMAND: fakeCodexPath,
    CODEX_SANDBOX: "workspace-write",
    CODEX_APPROVAL_POLICY: "never",
    CODEX_EXEC_TIMEOUT_MS: "5000",
    WEBHOOK_EVENT_DIR: tempDir
  });
  const context = buildWebhookContext(tempDir);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const job = await startCodexAgentJob(config, context, "test prompt should not be logged");
    await waitFor(async () => {
      const metadata = JSON.parse(await readFile(job.metadataPath, "utf8")) as { status: string };
      return metadata.status === "completed";
    });

    const metadata = JSON.parse(await readFile(job.metadataPath, "utf8")) as {
      status: string;
      agent: string;
      runnerId: string;
      stdoutPath: string;
      transcriptPath: string;
    };
    const result = JSON.parse(await readFile(job.resultPath, "utf8")) as {
      summary: string;
      checks: string;
    };
    const savedAgentOutput = await readFile(job.agentOutputPath, "utf8");
    const args = await readFile(argsPath, "utf8");

    assert.equal(metadata.status, "completed");
    assert.equal(metadata.agent, "gpt-5.5");
    assert.equal(metadata.runnerId, "codex");
    assert.equal(metadata.stdoutPath, job.stdoutPath);
    assert.equal(metadata.transcriptPath, job.transcriptPath);
    assert.equal(result.summary, "codex agent result");
    assert.equal(result.checks, "fake check passed");
    assert.equal(savedAgentOutput, publicAgentOutput);
    assert.match(args, /"exec","--model","gpt-5.5"/);
    assert.match(args, /"--output-last-message"/);
    assert.match(args, /"workspace-write"/);
    assert.doesNotMatch(logs.join("\n"), /test prompt should not be logged/);
  } finally {
    console.log = originalLog;
  }
});

test("buildCodexEnv passes only the configured minimal environment", () => {
  assert.deepEqual(
    buildCodexEnv(
      readConfig({ CODEX_ENV_PASSTHROUGH_JSON: "[\"OPENAI_API_KEY\"]" }).agents.codex,
      {
        HOME: "/home/test",
        PATH: "/bin",
        OPENAI_API_KEY: "key",
        SECRET: "do-not-pass"
      }
    ),
    {
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_API_KEY: "key"
    }
  );
});

function buildWebhookContext(tempDir: string): WebhookContext {
  const jobDir = path.join(tempDir, "job");

  return {
    integrationId: "github",
    integrationName: "GitHub",
    agentRunnerId: "codex",
    agentRunnerName: "Codex CLI",
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
      agent: "gpt-5.5",
      tag: "agent",
      source: "text",
      usesDefaultAgent: true
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
