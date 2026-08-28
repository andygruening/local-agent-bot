import type { IncomingHttpHeaders } from "node:http";
import type { AgentSelection } from "./agent-selection.ts";
import type {
  IntegrationPromptSection,
  WebhookMetadata
} from "../integrations/types.ts";

export type WebhookContext = {
  integrationId: string;
  integrationName: string;
  agentRunnerId: string;
  agentRunnerName: string;
  receivedAt: string;
  eventName: string;
  deliveryId: string;
  jobId: string;
  jobDir: string;
  envelopePath: string;
  rawBodyPath: string;
  payloadPath: string;
  headersPath: string;
  promptPath: string;
  agentOutputPath: string;
  agentSelection: AgentSelection;
  integrationPrompt: IntegrationPromptSection;
  metadata: WebhookMetadata;
  payload: unknown;
  headers: IncomingHttpHeaders;
  rawBodyBytes: number;
};
