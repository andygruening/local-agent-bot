import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSelection } from "./agent-selection.ts";
import type { WebhookContext } from "./webhook-context.ts";
import type { AppConfig } from "../config/index.ts";
import type {
  IntegrationEvent,
  IntegrationPromptSection,
  WebhookIntegration
} from "../integrations/types.ts";

export async function persistWebhook(
  config: AppConfig,
  integration: WebhookIntegration,
  event: IntegrationEvent,
  rawBody: Buffer,
  agentSelection: AgentSelection,
  agentRunnerId: string,
  agentRunnerName: string
): Promise<WebhookContext> {
  const receivedAt = new Date().toISOString();
  const jobId = buildJobId(receivedAt, integration.id, event.eventName, event.deliveryId);
  const jobDir = path.join(config.core.eventDir, jobId);
  const envelopePath = path.join(jobDir, "webhook.json");
  const rawBodyPath = path.join(jobDir, "raw-body.json");
  const payloadPath = path.join(jobDir, "payload.json");
  const headersPath = path.join(jobDir, "headers.json");
  const promptPath = path.join(jobDir, "prompt.md");
  const agentOutputPath = path.join(jobDir, "agent-output.md");

  await mkdir(jobDir, { recursive: true });
  await Promise.all([
    writeFile(rawBodyPath, rawBody),
    writeFile(payloadPath, `${JSON.stringify(event.payload, null, 2)}\n`),
    writeFile(headersPath, `${JSON.stringify(event.headers, null, 2)}\n`)
  ]);

  const context: WebhookContext = {
    integrationId: integration.id,
    integrationName: integration.displayName,
    agentRunnerId,
    agentRunnerName,
    receivedAt,
    eventName: event.eventName,
    deliveryId: event.deliveryId,
    jobId,
    jobDir,
    envelopePath,
    rawBodyPath,
    payloadPath,
    headersPath,
    promptPath,
    agentOutputPath,
    agentSelection,
    integrationPrompt: emptyIntegrationPrompt(),
    metadata: event.metadata,
    payload: event.payload,
    headers: event.headers,
    rawBodyBytes: event.rawBodyBytes
  };

  await writeFile(
    envelopePath,
    `${JSON.stringify(
      {
        integration: {
          id: integration.id,
          name: integration.displayName
        },
        agentRunner: {
          id: agentRunnerId,
          name: agentRunnerName
        },
        receivedAt,
        eventName: event.eventName,
        deliveryId: event.deliveryId,
        jobId,
        agentSelection,
        headers: event.headers,
        payload: event.payload
      },
      null,
      2
    )}\n`
  );

  return context;
}

function emptyIntegrationPrompt(): IntegrationPromptSection {
  return {
    savedFiles: "",
    guidance: "",
    responseInstructions: "",
    inlineContext: ""
  };
}

function buildJobId(
  receivedAt: string,
  integrationId: string,
  eventName: string,
  deliveryId: string
): string {
  const timestamp = receivedAt.replaceAll(":", "-").replaceAll(".", "-");
  return `${timestamp}_${sanitizePathSegment(integrationId)}_${sanitizePathSegment(eventName)}_${sanitizePathSegment(deliveryId)}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "unknown";
}
