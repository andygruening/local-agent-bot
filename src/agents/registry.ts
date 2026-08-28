import type { AppConfig } from "../config/index.ts";
import { codexAgentRunner } from "./codex/index.ts";
import { supersetAgentRunner } from "./superset/index.ts";
import type { AgentJob, AgentRunner, StartAgentJobOptions } from "./types.ts";
import type { WebhookContext } from "../core/webhook-context.ts";

const agentRunners: readonly AgentRunner[] = [
  supersetAgentRunner,
  codexAgentRunner
];

export function findAgentRunner(config: AppConfig): AgentRunner {
  const runner = agentRunners.find((candidate) => candidate.id === config.agents.runner);
  if (!runner) {
    throw new AgentRunnerConfigError(
      `AGENT_RUNNER must be one of ${agentRunners.map((candidate) => candidate.id).join(", ")}`
    );
  }

  return runner;
}

export function agentRunnerIds(): string[] {
  return agentRunners.map((runner) => runner.id);
}

export async function startConfiguredAgentJob(
  config: AppConfig,
  context: WebhookContext,
  prompt: string,
  options?: StartAgentJobOptions
): Promise<AgentJob> {
  return await findAgentRunner(config).start(config, context, prompt, options);
}

export class AgentRunnerConfigError extends Error {}
