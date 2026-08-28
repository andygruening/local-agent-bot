import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentJob, WorkerResult } from "../../agents/types.ts";
import type { AppConfig, GitHubReactionContent } from "../../config/index.ts";
import { runGh } from "./gh.ts";
export { buildGitHubEnv } from "./gh.ts";

export type GitHubReactionTargetKind =
  | "issue"
  | "issue-comment"
  | "pull-request-review-comment";

export type GitHubResponseTarget = {
  repo: string;
  issueNumber: number;
  reactionTarget: {
    kind: GitHubReactionTargetKind;
    apiPath: string;
  };
};

export type GitHubResponseState = {
  target: GitHubResponseTarget;
  responsePath: string;
  commentBodyPath: string;
  processingReaction?: {
    id: number;
    apiPath: string;
    deleteApiPath: string;
    content: "eyes";
    createdAt: string;
  };
  completionReaction?: {
    id: number;
    apiPath: string;
    deleteApiPath: string;
    content: Exclude<GitHubReactionContent, "eyes">;
    createdAt: string;
  };
  completedAt?: string;
  commentPosted?: boolean;
  processingReactionRemoved?: boolean;
  errors: GitHubResponseErrorRecord[];
};

export type GitHubResponseErrorRecord = {
  step: string;
  message: string;
};

export class GitHubResponseError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

class AgentOutputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

export function extractGitHubResponseTarget(
  payload: unknown,
  eventName: string
): GitHubResponseTarget | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const repo = readString(isRecord(payload.repository) ? payload.repository.full_name : undefined);
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : undefined;
  const issueNumber = readPositiveInteger(issue?.number) ?? readPositiveInteger(pullRequest?.number);

  if (!repo || !issueNumber) {
    return undefined;
  }

  const comment = isRecord(payload.comment) ? payload.comment : undefined;
  const commentId = readPositiveInteger(comment?.id);
  if (commentId && eventName === "issue_comment") {
    return {
      repo,
      issueNumber,
      reactionTarget: {
        kind: "issue-comment",
        apiPath: `repos/${repo}/issues/comments/${commentId}/reactions`
      }
    };
  }

  if (commentId && eventName === "pull_request_review_comment") {
    return {
      repo,
      issueNumber,
      reactionTarget: {
        kind: "pull-request-review-comment",
        apiPath: `repos/${repo}/pulls/comments/${commentId}/reactions`
      }
    };
  }

  return {
    repo,
    issueNumber,
    reactionTarget: {
      kind: "issue",
      apiPath: `repos/${repo}/issues/${issueNumber}/reactions`
    }
  };
}

export async function beginGitHubResponse(
  config: AppConfig,
  jobDir: string,
  target: GitHubResponseTarget
): Promise<GitHubResponseState> {
  const state: GitHubResponseState = {
    target,
    responsePath: path.join(jobDir, "github-response.json"),
    commentBodyPath: path.join(jobDir, "github-result-comment.md"),
    errors: []
  };

  if (!config.integrations.github.responseEnabled || config.core.dryRun) {
    await writeGitHubResponseState(state);
    logGitHubResponse("GitHub processing reaction skipped:", {
      reason: config.core.dryRun ? "dry_run" : "github_response_disabled",
      target
    });
    return state;
  }

  await assertGhAuthenticated(config);
  state.processingReaction = await createGitHubReaction(
    config,
    target.reactionTarget.apiPath,
    "eyes",
    "add_processing_reaction"
  );
  await writeGitHubResponseState(state);
  logGitHubResponse("GitHub processing reaction added:", {
    target,
    reaction: state.processingReaction
  });
  return state;
}

export async function completeGitHubResponse(
  config: AppConfig,
  state: GitHubResponseState | undefined,
  job: AgentJob,
  result: WorkerResult | undefined
): Promise<GitHubResponseState | undefined> {
  if (!state) {
    return undefined;
  }

  state.completedAt = new Date().toISOString();
  let commentBody: string | undefined;
  try {
    commentBody = await buildResultComment(job, result);
    await writeFile(state.commentBodyPath, commentBody);
  } catch (error: unknown) {
    state.errors.push({
      step: error instanceof AgentOutputError ? "read_agent_output" : "build_result_comment",
      message: errorMessage(error)
    });
    await writeFile(state.commentBodyPath, "");
  }

  if (!config.integrations.github.responseEnabled || config.core.dryRun) {
    await writeGitHubResponseState(state);
    logGitHubResponse("GitHub result comment skipped:", {
      reason: config.core.dryRun ? "dry_run" : "github_response_disabled",
      target: state.target,
      commentBodyPath: state.commentBodyPath
    });
    return state;
  }

  if (commentBody !== undefined) {
    try {
      const commentResult = await runGh(config.integrations.github, [
        "issue",
        "comment",
        String(state.target.issueNumber),
        "--repo",
        state.target.repo,
        "--body-file",
        state.commentBodyPath
      ]);
      if (commentResult.exitCode !== 0) {
        state.errors.push({
          step: "post_result_comment",
          message: commentResult.stderr.trim()
        });
      } else {
        state.commentPosted = true;
        logGitHubResponse("GitHub result comment posted:", {
          repo: state.target.repo,
          issueNumber: state.target.issueNumber,
          commentBodyPath: state.commentBodyPath
        });
      }
    } catch (error: unknown) {
      state.errors.push({
        step: "post_result_comment",
        message: errorMessage(error)
      });
    }
  } else {
    logGitHubResponse("GitHub result comment skipped:", {
      reason: "agent_output_missing",
      target: state.target,
      commentBodyPath: state.commentBodyPath
    });
  }

  if (commentBody !== undefined && shouldAddCompletionReaction(job, result)) {
    try {
      state.completionReaction = await createGitHubReaction(
        config,
        state.target.reactionTarget.apiPath,
        config.integrations.github.completionReaction,
        "add_completion_reaction"
      );
      logGitHubResponse("GitHub completion reaction added:", {
        target: state.target,
        reaction: state.completionReaction
      });
    } catch (error: unknown) {
      state.errors.push({
        step: "add_completion_reaction",
        message: errorMessage(error)
      });
    }
  }

  if (state.processingReaction) {
    try {
      const deleteResult = await runGh(config.integrations.github, [
        "api",
        "--method",
        "DELETE",
        state.processingReaction.deleteApiPath,
        "-H",
        "Accept: application/vnd.github+json"
      ]);
      if (deleteResult.exitCode !== 0) {
        state.errors.push({
          step: "remove_processing_reaction",
          message: deleteResult.stderr.trim()
        });
      } else {
        state.processingReactionRemoved = true;
        logGitHubResponse("GitHub processing reaction removed:", {
          target: state.target,
          reactionId: state.processingReaction.id
        });
      }
    } catch (error: unknown) {
      state.errors.push({
        step: "remove_processing_reaction",
        message: errorMessage(error)
      });
    }
  }

  await writeGitHubResponseState(state);
  if (state.errors.length > 0) {
    logGitHubResponse("GitHub response completed with errors:", {
      target: state.target,
      errors: state.errors
    });
  }

  return state;
}

export async function buildResultComment(
  job: AgentJob,
  result: WorkerResult | undefined
): Promise<string> {
  if (result) {
    const output = await readAgentOutput(job.agentOutputPath);
    if (output !== undefined && output.trim()) {
      return output;
    }

    throw new AgentOutputError(
      job.agentOutputPath,
      `Agent did not write a non-empty agent output file at ${job.agentOutputPath}`
    );
  }

  return job.error ?? "Agent did not report an output.";
}

async function assertGhAuthenticated(config: AppConfig): Promise<void> {
  const result = await runGh(config.integrations.github, ["auth", "status"]);
  if (result.exitCode !== 0) {
    throw new GitHubResponseError("gh_auth_status", result.stderr.trim());
  }
}

async function createGitHubReaction<TContent extends GitHubReactionContent>(
  config: AppConfig,
  apiPath: string,
  content: TContent,
  step: string
): Promise<{
  id: number;
  apiPath: string;
  deleteApiPath: string;
  content: TContent;
  createdAt: string;
}> {
  const result = await runGh(config.integrations.github, [
    "api",
    "--method",
    "POST",
    apiPath,
    "-H",
    "Accept: application/vnd.github+json",
    "-f",
    `content=${content}`
  ]);
  if (result.exitCode !== 0) {
    throw new GitHubResponseError(step, result.stderr.trim());
  }

  const reaction = parseJsonObject(result.stdout);
  const reactionId = readPositiveInteger(reaction.id);
  if (!reactionId) {
    throw new GitHubResponseError(step, "GitHub did not return a reaction id");
  }

  return {
    id: reactionId,
    apiPath,
    deleteApiPath: `${apiPath}/${reactionId}`,
    content,
    createdAt: new Date().toISOString()
  };
}

async function writeGitHubResponseState(state: GitHubResponseState): Promise<void> {
  await writeFile(state.responsePath, `${JSON.stringify(state, null, 2)}\n`);
}

function shouldAddCompletionReaction(job: AgentJob, result: WorkerResult | undefined): boolean {
  return result?.status === "completed" || job.status === "completed";
}

async function readAgentOutput(agentOutputPath: string): Promise<string | undefined> {
  try {
    return await readFile(agentOutputPath, "utf8");
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }

  return parsed as Record<string, unknown>;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function logGitHubResponse(message: string, details: Record<string, unknown>): void {
  console.log(message, JSON.stringify({ at: new Date().toISOString(), ...details }, null, 2));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
