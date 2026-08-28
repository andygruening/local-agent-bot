import type { AppConfig } from "../../config/index.ts";
import type { AgentSelection } from "../../core/agent-selection.ts";
import type { AgentJob, WorkerResult } from "../../agents/types.ts";
import type { WebhookContext } from "../../core/webhook-context.ts";
import {
  type IntegrationEvent,
  IntegrationOperationError,
  IntegrationRequestError,
  type IntegrationTarget,
  type PreparedIntegrationRun,
  type RawWebhookInput,
  type WebhookIntegration,
  type WebhookMetadata
} from "../types.ts";
import {
  fetchGitHubIssueContext,
  GitHubContextError,
  type GitHubIssueContextState
} from "./context.ts";
import { buildGitHubPromptSection } from "./prompt.ts";
import {
  beginGitHubResponse,
  completeGitHubResponse,
  extractGitHubResponseTarget,
  GitHubResponseError,
  type GitHubResponseState,
  type GitHubResponseTarget
} from "./response.ts";
import { selectAgentFromGitHubPayload } from "./agent-tags.ts";
import {
  deliveryIdFromHeaders,
  eventNameFromHeaders,
  getHeader,
  verifyGitHubSignature
} from "./signature.ts";

export { GitHubContextError } from "./context.ts";
export { GitHubResponseError } from "./response.ts";

export type GitHubIntegrationRun = PreparedIntegrationRun & {
  target: GitHubResponseTarget;
  githubIssueContext: GitHubIssueContextState;
  githubResponse?: GitHubResponseState;
};

export const githubIntegration: WebhookIntegration<
  GitHubResponseTarget,
  GitHubIntegrationRun
> = {
  id: "github",
  displayName: "GitHub",
  targetNotFoundReason: "github_response_target_not_found",

  routePath(config: AppConfig): string {
    return config.integrations.github.webhookPath;
  },

  receive(config: AppConfig, input: RawWebhookInput): IntegrationEvent {
    const secret = config.integrations.github.webhookSecret;
    if (secret) {
      const signature = getHeader(input.request.headers, "x-hub-signature-256");
      if (!verifyGitHubSignature(secret, input.rawBody, signature)) {
        throw new IntegrationRequestError(401, "invalid_signature", {
          rawBodyBytes: input.rawBody.byteLength,
          hasSignature: Boolean(signature)
        });
      }
    } else {
      console.warn("GITHUB_WEBHOOK_SECRET is not set; accepting unsigned webhook requests.");
    }

    const payload = parseJsonPayload(input.rawBody);
    return {
      integrationId: "github",
      integrationName: "GitHub",
      eventName: eventNameFromHeaders(input.request.headers),
      deliveryId: deliveryIdFromHeaders(input.request.headers),
      payload,
      headers: input.request.headers,
      rawBodyBytes: input.rawBody.byteLength,
      metadata: extractGitHubMetadata(payload)
    };
  },

  selectAgent(config: AppConfig, event: IntegrationEvent): AgentSelection | undefined {
    return selectAgentFromGitHubPayload(event.payload, config.agents.selection, event.eventName);
  },

  resolveTarget(event: IntegrationEvent): IntegrationTarget<GitHubResponseTarget> | undefined {
    const target = extractGitHubResponseTarget(event.payload, event.eventName);
    if (!target) {
      return undefined;
    }

    return {
      value: target,
      summary: {
        repo: target.repo,
        issueNumber: target.issueNumber,
        reactionTargetKind: target.reactionTarget.kind
      }
    };
  },

  async prepareRun(
    config: AppConfig,
    context: WebhookContext,
    event: IntegrationEvent,
    target: IntegrationTarget<GitHubResponseTarget>
  ): Promise<GitHubIntegrationRun> {
    let githubIssueContext: GitHubIssueContextState;
    try {
      githubIssueContext = await fetchGitHubIssueContext(
        config,
        context.jobDir,
        target.value,
        event.payload
      );
    } catch (error: unknown) {
      if (error instanceof GitHubContextError) {
        throw new IntegrationOperationError(
          502,
          "github_context_failed",
          error.step,
          error.message
        );
      }

      throw error;
    }

    return {
      event,
      target: target.value,
      githubIssueContext,
      prompt: buildGitHubPromptSection(config, context, githubIssueContext)
    };
  },

  async beginResponse(
    config: AppConfig,
    context: WebhookContext,
    run: GitHubIntegrationRun
  ): Promise<GitHubIntegrationRun> {
    let githubResponse: GitHubResponseState;
    try {
      githubResponse = await beginGitHubResponse(config, context.jobDir, run.target);
    } catch (error: unknown) {
      if (error instanceof GitHubResponseError) {
        throw new IntegrationOperationError(
          502,
          "github_response_failed",
          error.step,
          error.message
        );
      }

      throw error;
    }
    return {
      ...run,
      githubResponse
    };
  },

  async completeResponse(
    config: AppConfig,
    run: GitHubIntegrationRun,
    job: AgentJob,
    result: WorkerResult | undefined
  ): Promise<void> {
    await completeGitHubResponse(config, run.githubResponse, job, result);
  },

  acceptedResponse(run: GitHubIntegrationRun): Record<string, unknown> | undefined {
    const githubResponse = run.githubResponse;
    if (!githubResponse) {
      return undefined;
    }

    return {
      repo: githubResponse.target.repo,
      issueNumber: githubResponse.target.issueNumber,
      responsePath: githubResponse.responsePath,
      commentBodyPath: githubResponse.commentBodyPath,
      processingReactionId: githubResponse.processingReaction?.id,
      contextPath: run.githubIssueContext.rawPath,
      contextMarkdownPath: run.githubIssueContext.markdownPath,
      contextSkippedReason: run.githubIssueContext.skippedReason,
      codeChangeRequested: run.githubIssueContext.codeChangeRequested,
      linkedOpenPullRequests: run.githubIssueContext.linkedOpenPullRequests.map((pullRequest) => ({
        repo: pullRequest.repo,
        number: pullRequest.number,
        title: pullRequest.title
      }))
    };
  },

  summarizeForLog(event: IntegrationEvent): Record<string, unknown> {
    return {
      repository: event.metadata.repositoryFullName,
      action: event.metadata.action,
      ref: event.metadata.ref,
      sender: event.metadata.senderLogin,
      githubHookId: getHeader(event.headers, "x-github-hook-id")
    };
  }
};

function parseJsonPayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch (error) {
    throw new IntegrationRequestError(
      400,
      "invalid_json",
      {
        rawBodyBytes: rawBody.byteLength
      },
      error
    );
  }
}

function extractGitHubMetadata(payload: unknown): WebhookMetadata {
  if (!isRecord(payload)) {
    return {};
  }

  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  const sender = isRecord(payload.sender) ? payload.sender : undefined;

  return {
    action: readString(payload.action),
    ref: readString(payload.ref),
    repositoryFullName: readString(repository?.full_name),
    senderLogin: readString(sender?.login)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
