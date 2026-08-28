import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config/index.ts";
import { buildAgentPrompt, type WebhookContext } from "../src/core/prompt.ts";
import { buildGitHubPromptSection } from "../src/integrations/github/prompt.ts";

test("buildAgentPrompt leaves GitHub responses to the receiver", () => {
  const config = readConfig({});
  const context = buildContext();
  context.integrationPrompt = buildGitHubPromptSection(config, context, undefined);
  const prompt = buildAgentPrompt(config, context);

  assert.match(prompt, /receiver owns GitHub reactions and final result comments/);
  assert.match(prompt, /Do not add reactions or post GitHub comments yourself/);
  assert.match(prompt, /agent-output\.md/);
  assert.match(prompt, /write the complete public GitHub response markdown to/);
  assert.match(prompt, /reads .*agent-output\.md/);
  assert.match(prompt, /Code-change delivery rule/);
  assert.match(prompt, /gh pr checkout <number> --repo <repo>/);
  assert.match(prompt, /gh pr create --repo <repo>/);
  assert.match(prompt, /do not leave changes only in the local workspace/);
  assert.match(prompt, /SUPERSET_WORKER_BLOCKED/);
  assert.match(prompt, /SUPERSET_WORKER_DONE/);
  assert.doesNotMatch(prompt, /summary from SUPERSET_WORKER_DONE/);
  assert.doesNotMatch(prompt, /SUPERSET_AGENT_OUTPUT/);
  assert.doesNotMatch(prompt, /Full parsed payload/);
  assert.doesNotMatch(prompt, /Raw request body/);
  assert.doesNotMatch(prompt, /Parsed payload:/);
  assert.doesNotMatch(prompt, /gh issue comment/);
});

function buildContext(): WebhookContext {
  const jobDir = "/tmp/job";

  return {
    integrationId: "github",
    integrationName: "GitHub",
    agentRunnerId: "superset",
    agentRunnerName: "Superset",
    receivedAt: "2026-08-28T00:00:00.000Z",
    eventName: "issue_comment",
    deliveryId: "delivery-1",
    jobId: "job-1",
    jobDir,
    envelopePath: path.join(jobDir, "webhook.json"),
    rawBodyPath: path.join(jobDir, "raw-body.json"),
    payloadPath: path.join(jobDir, "payload.json"),
    headersPath: path.join(jobDir, "headers.json"),
    promptPath: path.join(jobDir, "prompt.md"),
    agentOutputPath: path.join(jobDir, "agent-output.md"),
    agentSelection: {
      agent: "codex",
      tag: "agent",
      source: "text",
      usesDefaultAgent: true
    },
    integrationPrompt: {
      savedFiles: "",
      guidance: "",
      responseInstructions: "",
      inlineContext: ""
    },
    metadata: {
      action: "created",
      repositoryFullName: "octo/example",
      senderLogin: "octocat"
    },
    payload: {
      action: "created",
      comment: {
        body: "$codex please handle this",
        node_id: "COMMENT_NODE_ID"
      },
      issue: {
        number: 123,
        node_id: "ISSUE_NODE_ID"
      },
      repository: { full_name: "octo/example" },
      sender: { login: "octocat" }
    },
    headers: {},
    rawBodyBytes: 2
  };
}
