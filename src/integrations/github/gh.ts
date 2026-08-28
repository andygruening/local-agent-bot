import { spawn } from "node:child_process";
import type { GitHubIntegrationConfig } from "../../config/index.ts";

export type GhCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const baseEnvKeys = [
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
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

export function buildGitHubEnv(
  config: Pick<GitHubIntegrationConfig, "envPassthrough">,
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

export async function runGh(
  config: Pick<GitHubIntegrationConfig, "command" | "envPassthrough">,
  args: string[]
): Promise<GhCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(config.command, args, {
      env: buildGitHubEnv(config),
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
