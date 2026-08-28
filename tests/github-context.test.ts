import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config/index.ts";
import { fetchGitHubIssueContext } from "../src/integrations/github/context.ts";
import type { GitHubResponseTarget } from "../src/integrations/github/response.ts";

test("fetchGitHubIssueContext fetches comments and referenced open PRs without exposing timeline items", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "github-context-"));
  const fakeGhPath = path.join(tempDir, "fake-gh.mjs");
  const argsPath = path.join(tempDir, "gh-args.jsonl");
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + "\\n");

if (args[0] !== "api") {
  process.stderr.write("unexpected command");
  process.exit(1);
}

const path = args[1];
const write = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};

if (path === "repos/octo/example/issues/123") {
  write({
    number: 123,
    title: "Connect webhook worker",
    state: "open",
    html_url: "https://github.com/octo/example/issues/123",
    user: { login: "octocat" },
    labels: [{ name: "agent" }],
    body: "Task body references https://github.com/octo/example/pull/456"
  });
}

if (path === "repos/octo/example/issues/123/comments") {
  write([[{
    id: 111,
    html_url: "https://github.com/octo/example/issues/123#issuecomment-111",
    user: { login: "andy" },
    created_at: "2026-08-28T00:00:00Z",
    body: "$codex please integrate this using https://github.com/octo/example/pull/456"
  }]]);
}

if (path === "repos/octo/example/issues/123/timeline") {
  write([[{
    id: 222,
    event: "cross-referenced",
    created_at: "2026-08-28T00:01:00Z",
    actor: { login: "andy" },
    source: {
      issue: {
        number: 456,
        state: "open",
        html_url: "https://github.com/octo/example/pull/456",
        repository: { full_name: "octo/example" },
        pull_request: {}
      }
    }
  }]]);
}

if (path === "repos/octo/example/issues/123/events") {
  write([[{
    id: 333,
    event: "labeled",
    created_at: "2026-08-28T00:02:00Z",
    actor: { login: "andy" }
  }]]);
}

if (path === "repos/octo/example/pulls/456") {
  write({
    number: 456,
    title: "Existing implementation PR",
    state: "open",
    draft: false,
    html_url: "https://github.com/octo/example/pull/456",
    user: { login: "contributor" },
    head: {
      ref: "feature/webhook-worker",
      sha: "abc123",
      repo: { full_name: "octo/example" }
    },
    base: {
      ref: "main",
      sha: "def456",
      repo: { full_name: "octo/example" }
    }
  });
}

process.stderr.write("unexpected path " + path);
process.exit(1);
`
  );
  await chmod(fakeGhPath, 0o755);

  const config = readConfig({
    GITHUB_COMMAND: fakeGhPath
  });
  const target = buildTarget();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const state = await fetchGitHubIssueContext(config, tempDir, target, {
      comment: {
        body: "$codex please integrate this"
      }
    });
    const args = await readFile(argsPath, "utf8");
    const markdown = await readFile(state.markdownPath, "utf8");
    const raw = JSON.parse(await readFile(state.rawPath, "utf8")) as {
      issueComments: unknown[];
      issueEvents: unknown[];
      linkedOpenPullRequests: unknown[];
    } & Record<string, unknown>;

    assert.equal(state.codeChangeRequested, true);
    assert.deepEqual(state.codeChangeIntent.matchedTerms, ["integrate"]);
    assert.equal(state.counts.issueComments, 1);
    assert.equal(state.counts.issueEvents, 1);
    assert.equal(state.linkedOpenPullRequests[0]?.number, 456);
    assert.match(markdown, /please integrate this using/);
    assert.match(markdown, /gh pr checkout 456 --repo octo\/example/);
    assert.match(markdown, /commit and push to the checked-out branch/);
    assert.match(markdown, /gh pr create --repo <repo>/);
    assert.match(markdown, /Do not report code changes as done while they exist only in the local workspace/);
    assert.match(markdown, /Code-change request detected: yes/);
    assert.doesNotMatch(markdown, /Timeline Actions/);
    assert.doesNotMatch(markdown, /cross-referenced/);
    assert.equal(raw.issueComments.length, 1);
    assert.equal("timelineItems" in raw, false);
    assert.equal(raw.issueEvents.length, 1);
    assert.equal(raw.linkedOpenPullRequests.length, 1);
    assert.match(args, /repos\/octo\/example\/issues\/123\/comments/);
    assert.match(args, /repos\/octo\/example\/issues\/123\/timeline/);
    assert.match(args, /repos\/octo\/example\/issues\/123\/events/);
    assert.match(args, /repos\/octo\/example\/pulls\/456/);
    assert.doesNotMatch(logs.join("\n"), /please integrate this using/);
  } finally {
    console.log = originalLog;
  }
});

test("fetchGitHubIssueContext can be disabled", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "github-context-disabled-"));
  const state = await fetchGitHubIssueContext(
    readConfig({ GITHUB_CONTEXT_ENABLED: "false" }),
    tempDir,
    buildTarget(),
    {}
  );
  const markdown = await readFile(state.markdownPath, "utf8");

  assert.equal(state.skippedReason, "github_context_disabled");
  assert.equal(state.codeChangeRequested, false);
  assert.equal(markdown, "");
});

function buildTarget(): GitHubResponseTarget {
  return {
    repo: "octo/example",
    issueNumber: 123,
    reactionTarget: {
      kind: "issue-comment",
      apiPath: "repos/octo/example/issues/comments/111/reactions"
    }
  };
}
