import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config/index.ts";
import type {
  AgentCompletionHandler,
  AgentJob,
  AgentRunner,
  StartAgentJobOptions,
  WorkerResult
} from "../types.ts";
import type { WebhookContext } from "../../core/webhook-context.ts";
import { parseWorkerResult } from "../shared/completion-envelope.ts";

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type SupersetCreateResult = {
  kind?: string;
  sessionId?: string;
  label?: string;
};

const baseEnvKeys = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
];
const maxLogPreviewChars = 2_000;

export const supersetAgentRunner: AgentRunner = {
  id: "superset",
  displayName: "Superset",
  start: startSupersetAgentJob
};

export async function startSupersetAgentJob(
  config: AppConfig,
  context: WebhookContext,
  prompt: string,
  options: StartAgentJobOptions = {}
): Promise<AgentJob> {
  const env = options.env ?? process.env;
  const onComplete = options.onComplete ?? noopCompletionHandler;

  await mkdir(context.jobDir, { recursive: true });
  await writeFile(context.promptPath, prompt);

  const createStdoutPath = path.join(context.jobDir, "superset-create.stdout.json");
  const createStderrPath = path.join(context.jobDir, "superset-create.stderr.log");
  const terminalSnapshotPath = path.join(context.jobDir, "superset-terminal-snapshot.json");
  const agentOutputPath = context.agentOutputPath;
  const resultPath = path.join(context.jobDir, "agent-result.json");
  const metadataPath = path.join(context.jobDir, "job.json");
  const startedAt = new Date().toISOString();
  const command = config.agents.superset.command;
  const agent = context.agentSelection.agent;
  const args = buildSupersetAgentCreateArgs(config, agent, prompt);
  const redactedArgs = redactPromptArg(args);

  logAgentJobStarting(config, context, redactedArgs);

  const baseJob: AgentJob = {
    jobId: context.jobId,
    status: "running",
    agent,
    runnerId: "superset",
    runnerName: "Superset",
    command,
    args: redactedArgs,
    jobDir: context.jobDir,
    stdoutPath: createStdoutPath,
    stderrPath: createStderrPath,
    transcriptPath: terminalSnapshotPath,
    createStdoutPath,
    createStderrPath,
    terminalSnapshotPath,
    agentOutputPath,
    resultPath,
    metadataPath,
    promptPath: context.promptPath,
    startedAt
  };

  if (config.core.dryRun) {
    const dryRunOutput = "Dry run; Superset agent was not launched.";
    const dryRunResult: WorkerResult = {
      status: "completed",
      marker: "SUPERSET_WORKER_DONE",
      task: context.jobId,
      summary: dryRunOutput
    };
    const job: AgentJob = {
      ...baseJob,
      status: "dry-run",
      finishedAt: startedAt
    };
    await writeJobMetadata(job);
    await writeAgentOutput(agentOutputPath, dryRunOutput);
    await writeAgentResult(resultPath, dryRunResult);
    await onComplete(job, dryRunResult);
    logAgentJobFinished(context, job, dryRunResult);
    return job;
  }

  let createResult: CommandResult;
  try {
    createResult = await runCommand(command, args, {
      cwd: process.cwd(),
      env: buildSupersetEnv(config.agents.superset, env)
    });
  } catch (error: unknown) {
    const failedJob: AgentJob = {
      ...baseJob,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage(error)
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logAgentJobFinished(context, failedJob, undefined);
    throw new SupersetAgentLaunchError(failedJob);
  }

  await Promise.all([
    writeFile(createStdoutPath, createResult.stdout),
    writeFile(createStderrPath, createResult.stderr)
  ]);

  if (createResult.exitCode !== 0) {
    const failedJob: AgentJob = {
      ...baseJob,
      status: "failed",
      finishedAt: new Date().toISOString(),
      exitCode: createResult.exitCode,
      signal: createResult.signal,
      error: createResult.stderr.trim() || "superset agents create failed"
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logAgentJobFinished(context, failedJob, undefined);
    throw new SupersetAgentLaunchError(failedJob);
  }

  let session: SupersetCreateResult;
  try {
    session = parseSupersetCreateResult(createResult.stdout);
  } catch (error: unknown) {
    const failedJob: AgentJob = {
      ...baseJob,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `Failed to parse superset agents create output: ${errorMessage(error)}`
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logAgentJobFinished(context, failedJob, undefined);
    throw new SupersetAgentLaunchError(failedJob);
  }

  if (!session.sessionId) {
    const failedJob: AgentJob = {
      ...baseJob,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: "superset agents create did not return a sessionId"
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logAgentJobFinished(context, failedJob, undefined);
    throw new SupersetAgentLaunchError(failedJob);
  }

  const runningJob: AgentJob = {
    ...baseJob,
    sessionId: session.sessionId,
    label: session.label,
    kind: session.kind
  };
  await writeJobMetadata(runningJob);
  logAgentJobStarted(context, runningJob);
  void monitorSupersetAgent(config, context, runningJob, env, onComplete);

  return runningJob;
}

export function buildSupersetAgentCreateArgs(
  config: AppConfig,
  agent: string,
  prompt: string
): string[] {
  const args = ["agents", "create"];

  if (config.agents.superset.workspaceId) {
    args.push("--workspace", config.agents.superset.workspaceId);
  }

  if (config.agents.superset.hostId) {
    args.push("--host", config.agents.superset.hostId);
  }

  args.push("--agent", agent, "--prompt", prompt, "--json", ...config.agents.superset.extraArgs);
  return args;
}

export function buildSupersetTerminalReadArgs(
  config: AppConfig,
  terminalId: string
): string[] {
  const args = ["terminals", "read"];

  if (config.agents.superset.workspaceId) {
    args.push("--workspace", config.agents.superset.workspaceId);
  }

  if (config.agents.superset.hostId) {
    args.push("--host", config.agents.superset.hostId);
  }

  args.push("--terminal", terminalId, "--json");
  return args;
}

export function buildSupersetEnv(
  config: Pick<AppConfig["agents"]["superset"], "envPassthrough">,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowedKeys = new Set([...baseEnvKeys, ...config.envPassthrough]);
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of allowedKeys) {
    const value = env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  return childEnv;
}

export class SupersetAgentLaunchError extends Error {
  readonly job: AgentJob;

  constructor(job: AgentJob) {
    super(job.error ?? "Superset agent launch failed");
    this.job = job;
  }
}

async function monitorSupersetAgent(
  config: AppConfig,
  context: WebhookContext,
  job: AgentJob,
  env: NodeJS.ProcessEnv,
  onComplete: AgentCompletionHandler
): Promise<void> {
  logAgentMonitorStarted(context, job, config);

  for (let poll = 1; poll <= config.agents.superset.terminalMaxPolls; poll += 1) {
    if (poll > 1) {
      await sleep(config.agents.superset.terminalPollIntervalMs);
    }

    const readResult = await runCommand(
      config.agents.superset.command,
      buildSupersetTerminalReadArgs(config, job.sessionId ?? ""),
      {
        cwd: process.cwd(),
        env: buildSupersetEnv(config.agents.superset, env)
      }
    );

    if (readResult.exitCode !== 0) {
      logAgentMonitorReadFailed(context, job, poll, readResult);
      continue;
    }

    let terminalText: string;
    try {
      terminalText = terminalTextFromJson(readResult.stdout);
    } catch (error: unknown) {
      logAgentMonitorParseFailed(context, job, poll, error);
      continue;
    }

    await writeFile(
      job.transcriptPath,
      `${JSON.stringify(
        {
          readAt: new Date().toISOString(),
          poll,
          sessionId: job.sessionId,
          text: terminalText
        },
        null,
        2
      )}\n`
    );
    const parsedWorkerResult = parseWorkerResult(terminalText, context.jobId);
    if (!parsedWorkerResult) {
      continue;
    }
    const workerResult = parsedWorkerResult.result;

    const finishedJob: AgentJob = {
      ...job,
      status: workerResult.status,
      finishedAt: new Date().toISOString()
    };

    await writeAgentResult(job.resultPath, workerResult);
    await writeJobMetadata(finishedJob);
    await onComplete(finishedJob, workerResult);
    logAgentJobFinished(context, finishedJob, workerResult);
    return;
  }

  const timedOutJob: AgentJob = {
    ...job,
    status: "timeout",
    finishedAt: new Date().toISOString(),
    error: "Timed out waiting for Superset worker completion envelope"
  };
  await writeJobMetadata(timedOutJob);
  await onComplete(timedOutJob, undefined);
  logAgentJobFinished(context, timedOutJob, undefined);
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}

function parseSupersetCreateResult(stdout: string): SupersetCreateResult {
  const parsed = parseJsonObject(stdout.trim());

  return {
    kind: readString(parsed.kind),
    sessionId: readString(parsed.sessionId),
    label: readString(parsed.label)
  };
}

function terminalTextFromJson(stdout: string): string {
  const parsed = parseJsonObject(stdout.trim());
  const text = readString(parsed.text);
  if (text !== undefined) {
    return text;
  }

  return stdout;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }

  return parsed as Record<string, unknown>;
}

async function writeJobMetadata(job: AgentJob): Promise<void> {
  await writeFile(job.metadataPath, `${JSON.stringify(job, null, 2)}\n`);
}

async function writeAgentResult(resultPath: string, result: WorkerResult): Promise<void> {
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function writeAgentOutput(agentOutputPath: string, output: string): Promise<void> {
  await writeFile(agentOutputPath, output);
}

function logAgentJobStarting(config: AppConfig, context: WebhookContext, args: string[]): void {
  console.log(
    "Starting Superset agent session:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        selectedAgent: context.agentSelection,
        command: config.agents.superset.command,
        args,
        workspaceId: config.agents.superset.workspaceId,
        hostId: config.agents.superset.hostId,
        dryRun: config.core.dryRun
      },
      null,
      2
    )
  );
}

function logAgentJobStarted(context: WebhookContext, job: AgentJob): void {
  console.log(
    "Superset agent session started:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        status: job.status,
        sessionId: job.sessionId,
        label: job.label,
        kind: job.kind,
        startedAt: job.startedAt,
        jobDir: job.jobDir,
        metadataPath: job.metadataPath,
        agentOutputPath: job.agentOutputPath,
        resultPath: job.resultPath
      },
      null,
      2
    )
  );
}

function logAgentMonitorStarted(context: WebhookContext, job: AgentJob, config: AppConfig): void {
  console.log(
    "Monitoring Superset agent session:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        sessionId: job.sessionId,
        pollIntervalMs: config.agents.superset.terminalPollIntervalMs,
        maxPolls: config.agents.superset.terminalMaxPolls,
        terminalRead: "full"
      },
      null,
      2
    )
  );
}

function logAgentMonitorReadFailed(
  context: WebhookContext,
  job: AgentJob,
  poll: number,
  readResult: CommandResult
): void {
  console.warn(
    "Superset agent monitor read failed:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        sessionId: job.sessionId,
        poll,
        exitCode: readResult.exitCode,
        signal: readResult.signal,
        stderrPreview: truncate(readResult.stderr.trim(), maxLogPreviewChars)
      },
      null,
      2
    )
  );
}

function logAgentMonitorParseFailed(
  context: WebhookContext,
  job: AgentJob,
  poll: number,
  error: unknown
): void {
  console.warn(
    "Superset agent monitor parse failed:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        sessionId: job.sessionId,
        poll,
        error: serializeError(error)
      },
      null,
      2
    )
  );
}

function logAgentJobFinished(
  context: WebhookContext,
  job: AgentJob,
  result: WorkerResult | undefined
): void {
  console.log(
    "Superset agent session finished:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        status: job.status,
        sessionId: job.sessionId,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: durationMs(job.startedAt, job.finishedAt),
        exitCode: job.exitCode,
        signal: job.signal,
        error: job.error,
        result: result
          ? {
              marker: result.marker,
              task: result.task,
              summary: result.summary,
              files: result.files,
              checks: result.checks,
              handoff: result.handoff,
              reason: result.reason,
              needs: result.needs,
              agentOutputPath: job.agentOutputPath,
              resultPath: job.resultPath
            }
          : undefined,
        logs: {
          createStdoutPath: job.createStdoutPath,
          createStderrPath: job.createStderrPath,
          terminalSnapshotPath: job.terminalSnapshotPath,
          agentOutputPath: job.agentOutputPath,
          metadataPath: job.metadataPath
        }
      },
      null,
      2
    )
  );
}

function webhookContextSummary(context: WebhookContext): Record<string, unknown> {
  return {
    integration: context.integrationName,
    eventName: context.eventName,
    deliveryId: context.deliveryId,
    jobId: context.jobId,
    repository: context.metadata.repositoryFullName,
    action: context.metadata.action,
    ref: context.metadata.ref,
    sender: context.metadata.senderLogin
  };
}

async function noopCompletionHandler(): Promise<void> {}

function redactPromptArg(args: string[]): string[] {
  const redacted = [...args];
  const promptIndex = redacted.indexOf("--prompt");

  if (promptIndex !== -1 && redacted[promptIndex + 1] !== undefined) {
    redacted[promptIndex + 1] = "<prompt omitted>";
  }

  return redacted;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

function durationMs(startedAt: string, finishedAt: string | undefined): number | undefined {
  if (!finishedAt) {
    return undefined;
  }

  return new Date(finishedAt).getTime() - new Date(startedAt).getTime();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
