import type { AppConfig } from "../config/index.ts";
import type { WebhookContext } from "./webhook-context.ts";

export type { WebhookContext } from "./webhook-context.ts";

export function buildAgentPrompt(config: AppConfig, context: WebhookContext): string {
  const prefix = config.core.promptPrefix ? `${config.core.promptPrefix.trim()}\n\n` : "";
  const savedFiles = context.integrationPrompt.savedFiles
    ? `${context.integrationPrompt.savedFiles}\n`
    : "";
  const publicResponseName = context.integrationPrompt.publicResponseName ?? "response";

  return `${prefix}You are a new Superset terminal agent session launched by a local ${context.integrationName} webhook receiver.

Webhook metadata:
- Integration: ${context.integrationName}
- Event: ${context.eventName}
- Delivery ID: ${context.deliveryId}
- Received at: ${context.receivedAt}
- Task ID: ${context.jobId}
- Agent runner: ${context.agentRunnerName}
- Selected agent: ${context.agentSelection.agent}
- Trigger tag: ${context.agentSelection.tag} (${context.agentSelection.source})
- Repository: ${context.metadata.repositoryFullName ?? "unknown"}
- Action: ${context.metadata.action ?? "none"}
- Ref: ${context.metadata.ref ?? "none"}
- Sender: ${context.metadata.senderLogin ?? "unknown"}

Task context saved in this workspace:
- Prompt used for this run: ${context.promptPath}
${savedFiles}
Use the webhook metadata and ${context.integrationName} context as the source of truth. Infer the requested work from the webhook event, make the smallest appropriate changes, and verify them when possible. If the event is informational or unsafe to act on, write a concise explanation and stop without making changes.

${context.integrationPrompt.guidance}

${context.integrationPrompt.responseInstructions} Before your final response, write the complete public ${publicResponseName} markdown to ${context.agentOutputPath}. That file must contain only the response text to post, with no prompt text, terminal logs, or completion envelope. Then end your final terminal response with exactly one of these envelopes so the receiver knows the session is complete. The receiver waits for a valid final envelope, reads ${context.agentOutputPath}, and posts that file as the result comment.

End your final response with exactly one of these envelopes:

\`\`\`text
SUPERSET_WORKER_DONE
task: ${context.jobId}
summary: <one-line outcome>
files: <comma-separated paths or none>
checks: <commands and outcomes>
handoff: <next-step context or none>
\`\`\`

\`\`\`text
SUPERSET_WORKER_BLOCKED
task: ${context.jobId}
reason: <specific blocker>
needs: <decision, access, or dependency required>
\`\`\`

${context.integrationPrompt.inlineContext}`;
}
