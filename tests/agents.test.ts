import assert from "node:assert/strict";
import test from "node:test";
import { agentRunnerIds, findAgentRunner } from "../src/agents/registry.ts";
import { readConfig } from "../src/config/index.ts";

test("agent runner registry exposes Superset and Codex runners", () => {
  assert.deepEqual(agentRunnerIds(), ["superset", "codex"]);
  assert.equal(findAgentRunner(readConfig({ AGENT_RUNNER: "superset" })).id, "superset");
  assert.equal(findAgentRunner(readConfig({ AGENT_RUNNER: "codex" })).id, "codex");
});

test("agent runner registry rejects unknown runners", () => {
  assert.throws(
    () => findAgentRunner(readConfig({ AGENT_RUNNER: "unknown" })),
    /AGENT_RUNNER must be one of superset, codex/
  );
});
