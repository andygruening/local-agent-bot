import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { AgentSelection } from "../core/agent-selection.ts";
import type { AgentJob, WorkerResult } from "../agents/types.ts";
import type { AppConfig } from "../config/index.ts";
import type { WebhookContext } from "../core/webhook-context.ts";

export type RawWebhookInput = {
  request: IncomingMessage;
  rawBody: Buffer;
};

export type WebhookMetadata = {
  action?: string;
  ref?: string;
  repositoryFullName?: string;
  senderLogin?: string;
};

export type IntegrationEvent = {
  integrationId: string;
  integrationName: string;
  eventName: string;
  deliveryId: string;
  payload: unknown;
  headers: IncomingHttpHeaders;
  rawBodyBytes: number;
  metadata: WebhookMetadata;
};

export type IntegrationTarget<TTarget = unknown> = {
  value: TTarget;
  summary: Record<string, unknown>;
};

export type IntegrationPromptSection = {
  savedFiles: string;
  guidance: string;
  responseInstructions: string;
  publicResponseName?: string;
  inlineContext: string;
};

export type PreparedIntegrationRun = {
  event: IntegrationEvent;
  prompt: IntegrationPromptSection;
};

export interface WebhookIntegration<
  TTarget = unknown,
  TRun extends PreparedIntegrationRun = PreparedIntegrationRun
> {
  id: string;
  displayName: string;
  targetNotFoundReason: string;

  routePath(config: AppConfig): string;
  receive(config: AppConfig, input: RawWebhookInput): Promise<IntegrationEvent> | IntegrationEvent;
  selectAgent(config: AppConfig, event: IntegrationEvent): AgentSelection | undefined;
  resolveTarget(event: IntegrationEvent): IntegrationTarget<TTarget> | undefined;
  prepareRun(
    config: AppConfig,
    context: WebhookContext,
    event: IntegrationEvent,
    target: IntegrationTarget<TTarget>
  ): Promise<TRun>;
  beginResponse(config: AppConfig, context: WebhookContext, run: TRun): Promise<TRun>;
  completeResponse(
    config: AppConfig,
    run: TRun,
    job: AgentJob,
    result: WorkerResult | undefined
  ): Promise<void>;
  acceptedResponse(run: TRun): Record<string, unknown> | undefined;
  summarizeForLog(event: IntegrationEvent): Record<string, unknown>;
}

export class IntegrationRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(code, { cause });
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class IntegrationOperationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly step: string;

  constructor(statusCode: number, code: string, step: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.step = step;
  }
}
