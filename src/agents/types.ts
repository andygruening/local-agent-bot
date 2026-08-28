import type { AppConfig } from "../config/index.ts";
import type { WebhookContext } from "../core/webhook-context.ts";

export type AgentJobStatus =
  | "dry-run"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "timeout";

export type AgentJob = {
  jobId: string;
  status: AgentJobStatus;
  agent: string;
  runnerId: string;
  runnerName: string;
  command: string;
  args: string[];
  jobDir: string;
  stdoutPath: string;
  stderrPath: string;
  transcriptPath: string;
  agentOutputPath: string;
  resultPath: string;
  metadataPath: string;
  promptPath: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  sessionId?: string;
  label?: string;
  kind?: string;
  createStdoutPath?: string;
  createStderrPath?: string;
  terminalSnapshotPath?: string;
};

export type WorkerResult = {
  status: "completed" | "blocked";
  marker: "SUPERSET_WORKER_DONE" | "SUPERSET_WORKER_BLOCKED";
  task?: string;
  summary?: string;
  files?: string;
  checks?: string;
  handoff?: string;
  reason?: string;
  needs?: string;
};

export type AgentCompletionHandler = (
  job: AgentJob,
  result: WorkerResult | undefined
) => Promise<void>;

export type StartAgentJobOptions = {
  env?: NodeJS.ProcessEnv;
  onComplete?: AgentCompletionHandler;
};

export interface AgentRunner {
  id: string;
  displayName: string;
  start(
    config: AppConfig,
    context: WebhookContext,
    prompt: string,
    options?: StartAgentJobOptions
  ): Promise<AgentJob>;
}
