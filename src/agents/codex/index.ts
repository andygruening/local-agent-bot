import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentCompletionHandler,
  AgentJob,
  AgentRunner,
  StartAgentJobOptions,
  WorkerResult
} from "../types.ts";
import type { AppConfig } from "../../config/index.ts";
import type { WebhookContext } from "../../core/webhook-context.ts";
import { parseWorkerResult } from "../shared/completion-envelope.ts";
import { writeJsonFileAtomic } from "../shared/json-files.ts";

type CodexProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
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

export const codexAgentRunner: AgentRunner = {
  id: "codex",
  displayName: "Codex CLI",
  start: startCodexAgentJob
};

export async function startCodexAgentJob(
  config: AppConfig,
  context: WebhookContext,
  prompt: string,
  options: StartAgentJobOptions = {}
): Promise<AgentJob> {
  const env = options.env ?? process.env;
  const onComplete = options.onComplete ?? noopCompletionHandler;

  await mkdir(context.jobDir, { recursive: true });
  await writeFile(context.promptPath, prompt);

  const stdoutPath = path.join(context.jobDir, "codex-exec.stdout.log");
  const stderrPath = path.join(context.jobDir, "codex-exec.stderr.log");
  const lastMessagePath = path.join(context.jobDir, "codex-last-message.md");
  const agentOutputPath = context.agentOutputPath;
  const resultPath = path.join(context.jobDir, "agent-result.json");
  const metadataPath = path.join(context.jobDir, "job.json");
  const startedAt = new Date().toISOString();
  const command = config.agents.codex.command;
  const agent = context.agentSelection.agent;
  const args = buildCodexExecArgs(config, agent, lastMessagePath);

  logCodexJobStarting(config, context, args);

  const baseJob: AgentJob = {
    jobId: context.jobId,
    status: "running",
    agent,
    runnerId: "codex",
    runnerName: "Codex CLI",
    command,
    args,
    jobDir: context.jobDir,
    stdoutPath,
    stderrPath,
    transcriptPath: lastMessagePath,
    agentOutputPath,
    resultPath,
    metadataPath,
    promptPath: context.promptPath,
    startedAt
  };

  if (config.core.dryRun) {
    const dryRunOutput = "Dry run; Codex CLI was not launched.";
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
    await writeFile(agentOutputPath, dryRunOutput);
    await writeAgentResult(resultPath, dryRunResult);
    await onComplete(job, dryRunResult);
    logCodexJobFinished(context, job, dryRunResult);
    return job;
  }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: buildCodexEnv(config.agents.codex, env),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  try {
    await waitForSpawn(child);
  } catch (error: unknown) {
    const failedJob: AgentJob = {
      ...baseJob,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage(error)
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logCodexJobFinished(context, failedJob, undefined);
    throw new CodexAgentLaunchError(failedJob);
  }

  const runningJob: AgentJob = {
    ...baseJob,
    sessionId: String(child.pid),
    kind: "process"
  };
  await writeJobMetadata(runningJob);
  logCodexJobStarted(context, runningJob);
  void monitorCodexProcess(
    config,
    context,
    runningJob,
    child,
    stdoutChunks,
    stderrChunks,
    onComplete
  );
  child.stdin?.end(prompt);

  return runningJob;
}

export function buildCodexExecArgs(
  config: AppConfig,
  model: string,
  lastMessagePath: string
): string[] {
  const args = ["exec", "--model", model];

  const workingDirectory = config.agents.codex.workingDirectory ?? process.cwd();
  args.push("--cd", workingDirectory);

  if (config.agents.codex.sandbox) {
    args.push("--sandbox", config.agents.codex.sandbox);
  }

  if (config.agents.codex.approvalPolicy) {
    args.push("--ask-for-approval", config.agents.codex.approvalPolicy);
  }

  args.push(
    "--output-last-message",
    lastMessagePath,
    "--color",
    "never",
    ...config.agents.codex.extraArgs,
    "-"
  );

  return args;
}

export function buildCodexEnv(
  config: Pick<AppConfig["agents"]["codex"], "envPassthrough">,
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

export class CodexAgentLaunchError extends Error {
  readonly job: AgentJob;

  constructor(job: AgentJob) {
    super(job.error ?? "Codex CLI agent launch failed");
    this.job = job;
  }
}

async function monitorCodexProcess(
  config: AppConfig,
  context: WebhookContext,
  job: AgentJob,
  child: ReturnType<typeof spawn>,
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
  onComplete: AgentCompletionHandler
): Promise<void> {
  const processResult = await waitForProcess(child, config.agents.codex.execTimeoutMs);
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  await Promise.all([
    writeFile(job.stdoutPath, stdout),
    writeFile(job.stderrPath, stderr)
  ]);

  if (processResult.error) {
    const failedJob: AgentJob = {
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage(processResult.error)
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logCodexJobFinished(context, failedJob, undefined);
    return;
  }

  if (processResult.signal === "SIGTERM") {
    const timedOutJob: AgentJob = {
      ...job,
      status: "timeout",
      finishedAt: new Date().toISOString(),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      error: `Timed out after ${config.agents.codex.execTimeoutMs}ms waiting for Codex CLI`
    };
    await writeJobMetadata(timedOutJob);
    await onComplete(timedOutJob, undefined);
    logCodexJobFinished(context, timedOutJob, undefined);
    return;
  }

  if (processResult.exitCode !== 0) {
    const failedJob: AgentJob = {
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      error: stderr.trim() || `Codex CLI exited with code ${processResult.exitCode}`
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logCodexJobFinished(context, failedJob, undefined);
    return;
  }

  const finalMessage = await readOptionalFile(job.transcriptPath);
  const parsedWorkerResult =
    parseWorkerResult(finalMessage ?? "", context.jobId) ??
    parseWorkerResult(stdout, context.jobId);
  if (!parsedWorkerResult) {
    const failedJob: AgentJob = {
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      error: "Codex CLI completed without a valid worker completion envelope"
    };
    await writeJobMetadata(failedJob);
    await onComplete(failedJob, undefined);
    logCodexJobFinished(context, failedJob, undefined);
    return;
  }

  const workerResult = parsedWorkerResult.result;
  const finishedJob: AgentJob = {
    ...job,
    status: workerResult.status,
    finishedAt: new Date().toISOString(),
    exitCode: processResult.exitCode,
    signal: processResult.signal
  };

  await writeAgentResult(job.resultPath, workerResult);
  await writeJobMetadata(finishedJob);
  await onComplete(finishedJob, workerResult);
  logCodexJobFinished(context, finishedJob, workerResult);
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleSpawn = (): void => {
      child.off("error", handleError);
      resolve();
    };
    const handleError = (error: Error): void => {
      child.off("spawn", handleSpawn);
      reject(error);
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

async function waitForProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<CodexProcessResult> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  try {
    return await new Promise<CodexProcessResult>((resolve) => {
      child.once("error", (error) => {
        resolve({
          exitCode: null,
          signal: null,
          error
        });
      });
      child.once("close", (exitCode, signal) => {
        resolve({
          exitCode,
          signal: timedOut ? "SIGTERM" : signal
        });
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function writeJobMetadata(job: AgentJob): Promise<void> {
  await writeJsonFileAtomic(job.metadataPath, job);
}

async function writeAgentResult(resultPath: string, result: WorkerResult): Promise<void> {
  await writeJsonFileAtomic(resultPath, result);
}

function logCodexJobStarting(config: AppConfig, context: WebhookContext, args: string[]): void {
  console.log(
    "Starting Codex CLI agent process:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        selectedAgent: context.agentSelection,
        command: config.agents.codex.command,
        args,
        timeoutMs: config.agents.codex.execTimeoutMs,
        dryRun: config.core.dryRun
      },
      null,
      2
    )
  );
}

function logCodexJobStarted(context: WebhookContext, job: AgentJob): void {
  console.log(
    "Codex CLI agent process started:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        status: job.status,
        pid: job.sessionId,
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

function logCodexJobFinished(
  context: WebhookContext,
  job: AgentJob,
  result: WorkerResult | undefined
): void {
  console.log(
    "Codex CLI agent process finished:",
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        ...webhookContextSummary(context),
        agent: job.agent,
        status: job.status,
        pid: job.sessionId,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: durationMs(job.startedAt, job.finishedAt),
        exitCode: job.exitCode,
        signal: job.signal,
        error: truncate(job.error ?? "", maxLogPreviewChars) || undefined,
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
          stdoutPath: job.stdoutPath,
          stderrPath: job.stderrPath,
          transcriptPath: job.transcriptPath,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function noopCompletionHandler(): Promise<void> {}
