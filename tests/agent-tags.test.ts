import assert from "node:assert/strict";
import test from "node:test";
import {
  AmbiguousAgentTagError,
  selectAgentFromGitHubPayload as selectAgentFromPayload
} from "../src/integrations/github/agent-tags.ts";
import { readConfig } from "../src/config/index.ts";

test("$agent selects the configured default Superset agent", () => {
  const selection = selectAgentFromPayload(
    {
      comment: { body: "$agent please investigate" }
    },
    readConfig({
      SUPERSET_DEFAULT_AGENT: "codex",
      SUPERSET_AGENT_TAGS: "codex,claude"
    }).agents.selection
  );

  assert.deepEqual(selection, {
    agent: "codex",
    tag: "agent",
    source: "text",
    usesDefaultAgent: true
  });
});

test("direct configured tags select that Superset agent", () => {
  const selection = selectAgentFromPayload(
    {
      comment: { body: "$agent $claude please investigate" }
    },
    readConfig({
      SUPERSET_DEFAULT_AGENT: "codex",
      SUPERSET_AGENT_TAGS: "codex,claude"
    }).agents.selection
  );

  assert.equal(selection?.agent, "claude");
  assert.equal(selection?.usesDefaultAgent, false);
});

test("issue_comment tags are read only from the new comment", () => {
  const selection = selectAgentFromPayload(
    {
      comment: { body: "Agent finished without a trigger tag." },
      issue: {
        body: "$codex please handle this",
        labels: [{ name: "codex" }]
      }
    },
    readConfig({
      SUPERSET_DEFAULT_AGENT: "codex",
      SUPERSET_AGENT_TAGS: "codex,claude"
    }).agents.selection,
    "issue_comment"
  );

  assert.equal(selection, undefined);
});

test("issue_comment direct tag is not made ambiguous by tags on the issue", () => {
  const selection = selectAgentFromPayload(
    {
      comment: { body: "$claude please handle this follow-up" },
      issue: {
        body: "$codex please handle this",
        labels: [{ name: "codex" }]
      }
    },
    readConfig({
      SUPERSET_DEFAULT_AGENT: "codex",
      SUPERSET_AGENT_TAGS: "codex,claude"
    }).agents.selection,
    "issue_comment"
  );

  assert.equal(selection?.agent, "claude");
  assert.equal(selection?.source, "text");
});

test("labels can select the default or a direct agent", () => {
  const config = readConfig({
    SUPERSET_DEFAULT_AGENT: "codex",
    SUPERSET_AGENT_TAGS: "codex,claude"
  }).agents.selection;

  assert.equal(
    selectAgentFromPayload({ issue: { labels: [{ name: "agent" }] } }, config)?.agent,
    "codex"
  );
  assert.equal(
    selectAgentFromPayload({ pull_request: { labels: [{ name: "claude" }] } }, config)?.agent,
    "claude"
  );
});

test("multiple direct agent tags are rejected as ambiguous", () => {
  assert.throws(
    () =>
      selectAgentFromPayload(
        {
          comment: { body: "$codex $claude" }
        },
        readConfig({
          SUPERSET_DEFAULT_AGENT: "codex",
          SUPERSET_AGENT_TAGS: "codex,claude"
        }).agents.selection
      ),
    AmbiguousAgentTagError
  );
});

test("agent-prefixed text tags do not bypass the configured allow-list", () => {
  const selection = selectAgentFromPayload(
    {
      comment: { body: "$agent:gpt-5.4" }
    },
    readConfig({
      SUPERSET_DEFAULT_AGENT: "codex",
      SUPERSET_AGENT_TAGS: "codex,claude"
    }).agents.selection
  );

  assert.equal(selection, undefined);
});
