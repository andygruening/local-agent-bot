import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AmbiguousAgentTagError,
  type AgentSelection
} from "./agent-selection.ts";
import {
  PayloadTooLargeError,
  readRequestBody,
  sendJson,
  summarizeHeaders
} from "./http.ts";
import { persistWebhook } from "./jobs.ts";
import {
  AgentRunnerConfigError,
  findAgentRunner,
  startConfiguredAgentJob
} from "../agents/registry.ts";
import type { AgentJob, StartAgentJobOptions } from "../agents/types.ts";
import type { AppConfig } from "../config/index.ts";
import { findIntegrationForPath, integrationPaths } from "../integrations/registry.ts";
import {
  IntegrationOperationError,
  IntegrationRequestError,
  type IntegrationEvent,
  type WebhookIntegration
} from "../integrations/types.ts";
import { buildAgentPrompt } from "./prompt.ts";
import type { WebhookContext } from "./webhook-context.ts";

export type AgentLauncher = (
  config: AppConfig,
  context: WebhookContext,
  prompt: string,
  options?: StartAgentJobOptions
) => Promise<AgentJob>;

export function createWebhookServer(
  config: AppConfig,
  launchAgent: AgentLauncher = startConfiguredAgentJob
): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    handleRequest(config, launchAgent, request, response).catch((error: unknown) => {
      if (error instanceof IntegrationRequestError) {
        logRejectedRequest(request, error.statusCode, error.code, error.details);
        sendJson(response, error.statusCode, {
          ok: false,
          error: error.code
        });
        return;
      }

      if (error instanceof IntegrationOperationError) {
        logRejectedRequest(request, error.statusCode, error.code, {
          step: error.step,
          message: error.message
        });
        sendJson(response, error.statusCode, {
          ok: false,
          error: error.code,
          step: error.step
        });
        return;
      }

      if (error instanceof PayloadTooLargeError) {
        logRejectedRequest(request, 413, "payload_too_large", {
          maxBodyBytes: error.maxBodyBytes
        });
        sendJson(response, 413, {
          ok: false,
          error: "payload_too_large",
          maxBodyBytes: error.maxBodyBytes
        });
        return;
      }

      if (error instanceof AmbiguousAgentTagError) {
        logRejectedRequest(request, 400, "multiple_agent_tags", {
          agents: error.agents
        });
        sendJson(response, 400, {
          ok: false,
          error: "multiple_agent_tags",
          agents: error.agents
        });
        return;
      }

      if (error instanceof AgentRunnerConfigError) {
        logRejectedRequest(request, 500, "agent_runner_config_error", {
          message: error.message
        });
        sendJson(response, 500, {
          ok: false,
          error: "agent_runner_config_error"
        });
        return;
      }

      logRejectedRequest(request, 500, "internal_server_error", {
        error: serializeError(error)
      });
      sendJson(response, 500, {
        ok: false,
        error: "internal_server_error"
      });
    });
  });
}

async function handleRequest(
  config: AppConfig,
  launchAgent: AgentLauncher,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      webhookPath: config.integrations.github.webhookPath,
      integrations: integrationPaths(config),
      agentRunner: config.agents.runner,
      dryRun: config.core.dryRun
    });
    return;
  }

  const integration = findIntegrationForPath(config, requestUrl.pathname);
  if (request.method !== "POST" || !integration) {
    logRejectedRequest(request, 404, "not_found", {
      expectedMethod: "POST",
      expectedPaths: integrationPaths(config)
    });
    sendJson(response, 404, {
      ok: false,
      error: "not_found"
    });
    return;
  }

  const rawBody = await readRequestBody(request, config.core.maxBodyBytes);
  const event = await integration.receive(config, { request, rawBody });
  const agentSelection = integration.selectAgent(config, event);
  logIncomingWebhook(request, event, integration, agentSelection);

  if (config.core.allowedEvents && !config.core.allowedEvents.has(event.eventName)) {
    logIgnoredWebhook(request, event, integration, agentSelection, "event_not_allowed");
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      event: event.eventName,
      reason: "event_not_allowed"
    });
    return;
  }

  if (!agentSelection) {
    logIgnoredWebhook(request, event, integration, agentSelection, "agent_tag_not_found");
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      event: event.eventName,
      reason: "agent_tag_not_found"
    });
    return;
  }

  const target = integration.resolveTarget(event);
  if (!target) {
    logIgnoredWebhook(
      request,
      event,
      integration,
      agentSelection,
      integration.targetNotFoundReason
    );
    sendJson(response, 202, {
      ok: true,
      ignored: true,
      event: event.eventName,
      reason: integration.targetNotFoundReason
    });
    return;
  }

  const agentRunner = findAgentRunner(config);
  const context = await persistWebhook(
    config,
    integration,
    event,
    rawBody,
    agentSelection,
    agentRunner.id,
    agentRunner.displayName
  );
  logWebhookPersisted(context);

  const preparedRun = await integration.prepareRun(config, context, event, target);
  const contextWithPrompt: WebhookContext = {
    ...context,
    integrationPrompt: preparedRun.prompt
  };
  const activeRun = await integration.beginResponse(config, contextWithPrompt, preparedRun);
  const prompt = buildAgentPrompt(config, contextWithPrompt);
  logAgentLaunchStarting(contextWithPrompt, config);
  const job = await launchAgent(config, contextWithPrompt, prompt, {
    onComplete: async (agentJob, result) => {
      await integration.completeResponse(config, activeRun, agentJob, result);
    }
  });
  logAgentLaunchAccepted(contextWithPrompt, job);

  const body: Record<string, unknown> = {
    ok: true,
    integration: {
      id: integration.id,
      name: integration.displayName
    },
    agentRunner: {
      id: agentRunner.id,
      name: agentRunner.displayName,
      command: job.command,
      args: job.args,
      stdoutPath: job.stdoutPath,
      stderrPath: job.stderrPath,
      transcriptPath: job.transcriptPath,
      agentOutputPath: job.agentOutputPath,
      resultPath: job.resultPath,
      metadataPath: job.metadataPath
    },
    event: event.eventName,
    deliveryId: contextWithPrompt.deliveryId,
    jobId: contextWithPrompt.jobId,
    status: job.status,
    agent: job.agent,
    sessionId: job.sessionId,
    jobDir: contextWithPrompt.jobDir,
    superset: supersetResponse(job)
  };
  const integrationResponse = integration.acceptedResponse(activeRun);
  if (integrationResponse) {
    body[integration.id] = integrationResponse;
  }

  sendJson(response, 202, body);
}

function logIncomingWebhook(
  request: IncomingMessage,
  event: IntegrationEvent,
  integration: WebhookIntegration,
  agentSelection: AgentSelection | undefined
): void {
  console.log(
    `Received ${integration.displayName} webhook:`,
    JSON.stringify(webhookRequestSummary(request, event, integration, agentSelection), null, 2)
  );
}

function logIgnoredWebhook(
  request: IncomingMessage,
  event: IntegrationEvent,
  integration: WebhookIntegration,
  agentSelection: AgentSelection | undefined,
  reason: string
): void {
  console.warn(
    `Ignored ${integration.displayName} webhook:`,
    JSON.stringify(
      {
        reason,
        ...webhookRequestSummary(request, event, integration, agentSelection)
      },
      null,
      2
    )
  );
}

function logRejectedRequest(
  request: IncomingMessage,
  statusCode: number,
  reason: string,
  details?: Record<string, unknown>
): void {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  console.warn(
    "Rejected request:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        statusCode,
        reason,
        method: request.method,
        pathname: requestUrl.pathname,
        remoteAddress: request.socket.remoteAddress,
        headers: summarizeHeaders(request),
        ...details
      },
      null,
      2
    )
  );
}

function logWebhookPersisted(context: WebhookContext): void {
  console.log(
    `Saved ${context.integrationName} webhook data:`,
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        integration: context.integrationName,
        agentRunner: context.agentRunnerName,
        eventName: context.eventName,
        deliveryId: context.deliveryId,
        jobId: context.jobId,
        rawBodyBytes: context.rawBodyBytes,
        jobDir: context.jobDir,
        payloadPath: context.payloadPath
      },
      null,
      2
    )
  );
}

function logAgentLaunchStarting(context: WebhookContext, config: AppConfig): void {
  console.log(
    "Starting agent for webhook:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        integration: context.integrationName,
        agentRunner: {
          id: context.agentRunnerId,
          name: context.agentRunnerName
        },
        eventName: context.eventName,
        deliveryId: context.deliveryId,
        jobId: context.jobId,
        selectedAgent: context.agentSelection,
        dryRun: config.core.dryRun
      },
      null,
      2
    )
  );
}

function logAgentLaunchAccepted(context: WebhookContext, job: AgentJob): void {
  console.log(
    "Agent launch accepted:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        integration: context.integrationName,
        agentRunner: context.agentRunnerName,
        eventName: context.eventName,
        deliveryId: context.deliveryId,
        jobId: job.jobId,
        status: job.status,
        agent: job.agent,
        sessionId: job.sessionId,
        jobDir: job.jobDir,
        stdoutPath: job.stdoutPath,
        stderrPath: job.stderrPath,
        transcriptPath: job.transcriptPath,
        metadataPath: job.metadataPath,
        agentOutputPath: job.agentOutputPath,
        resultPath: job.resultPath
      },
      null,
      2
    )
  );
}

function webhookRequestSummary(
  request: IncomingMessage,
  event: IntegrationEvent,
  integration: WebhookIntegration,
  agentSelection: AgentSelection | undefined
): Record<string, unknown> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  return {
    receivedAt: new Date().toISOString(),
    integration: integration.displayName,
    method: request.method,
    pathname: requestUrl.pathname,
    eventName: event.eventName,
    deliveryId: event.deliveryId,
    ...integration.summarizeForLog(event),
    selectedAgent: agentSelection,
    rawBodyBytes: event.rawBodyBytes,
    payloadKeys: topLevelKeys(event.payload),
    remoteAddress: request.socket.remoteAddress,
    headers: summarizeHeaders(request)
  };
}

function supersetResponse(job: AgentJob): Record<string, unknown> | undefined {
  if (job.runnerId !== "superset") {
    return undefined;
  }

  return {
    command: job.command,
    args: job.args,
    createStdoutPath: job.createStdoutPath ?? job.stdoutPath,
    createStderrPath: job.createStderrPath ?? job.stderrPath,
    terminalSnapshotPath: job.terminalSnapshotPath ?? job.transcriptPath,
    agentOutputPath: job.agentOutputPath,
    resultPath: job.resultPath,
    metadataPath: job.metadataPath
  };
}

function topLevelKeys(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return Object.keys(value).slice(0, 25);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    message: String(error)
  };
}
