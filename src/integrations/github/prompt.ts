import type { AppConfig } from "../../config/index.ts";
import type { WebhookContext } from "../../core/webhook-context.ts";
import type { IntegrationPromptSection } from "../types.ts";
import type { GitHubIssueContextState } from "./context.ts";

export function buildGitHubPromptSection(
  config: AppConfig,
  context: WebhookContext,
  githubContext: GitHubIssueContextState | undefined
): IntegrationPromptSection {
  const contextPrompt = githubIssueContextPrompt(githubContext);

  void config;
  return {
    savedFiles: contextPrompt.savedFiles,
    guidance: `${contextPrompt.guidance}

Code-change delivery rule: if the requested work requires repository code changes, do not leave changes only in the local workspace. Use \`git status\` before and after editing. When the target is a pull request, or the issue/PR context identifies an existing open PR that clearly matches the task, use that PR branch as the work target with \`gh pr checkout <number> --repo <repo>\`, commit your changes, and push to the existing PR branch. If no matching open PR exists, create a new branch, commit your changes, push the branch, and open a pull request with \`gh pr create --repo <repo>\`. Include the PR number or URL in ${context.agentOutputPath} and in the \`handoff\` field. If you cannot push changes or create/update a pull request, finish with \`SUPERSET_WORKER_BLOCKED\` instead of \`SUPERSET_WORKER_DONE\`.`,
    responseInstructions:
      "The webhook receiver owns GitHub reactions and final result comments. Do not add reactions or post GitHub comments yourself.",
    publicResponseName: "GitHub response",
    inlineContext: contextPrompt.inlineContext
  };
}

function githubIssueContextPrompt(
  githubContext: GitHubIssueContextState | undefined
): {
  savedFiles: string;
  guidance: string;
  inlineContext: string;
} {
  if (!githubContext) {
    return {
      savedFiles: "",
      guidance: "No extended GitHub issue/PR context was fetched for this delivery.",
      inlineContext: ""
    };
  }

  if (githubContext.skippedReason) {
    return {
      savedFiles: `- GitHub issue/PR context: skipped (${githubContext.skippedReason})`,
      guidance: "No extended GitHub issue/PR context was fetched for this delivery.",
      inlineContext: ""
    };
  }

  const openPullRequests = githubContext.linkedOpenPullRequests
    .map((pullRequest) => `${pullRequest.repo}#${pullRequest.number}`)
    .join(", ");
  const savedFiles = [
    `- GitHub issue/PR context digest: ${githubContext.markdownPath}`,
    `- Raw GitHub issue/PR context JSON: ${githubContext.rawPath}`
  ].join("\n");
  const guidance = [
    "Read the GitHub issue/PR context digest before acting. Use the raw JSON when you need exact issue, comment, review, or pull request fields.",
    `The receiver detected code-change intent from the triggering text: ${githubContext.codeChangeRequested ? "yes" : "no"}.`,
    `Referenced open pull requests: ${openPullRequests || "none"}.`,
    githubContext.codeChangeRequested
      ? "When the target is a pull request, or the issue/PR context includes an existing open PR that clearly matches this task, use that PR branch as the work target. Prefer `gh pr checkout <number> --repo <repo>` before editing, then commit and push to the checked-out branch. If no referenced open PR clearly matches, create a new branch, commit the smallest appropriate change, push it, and open a pull request with `gh pr create --repo <repo>`."
      : "Do not checkout, push, or upload source-code changes merely because a PR is referenced. Treat referenced PRs as context unless the triggering text asks you to integrate something or make code changes."
  ].join("\n");
  const inlineContext = githubContext.inlineMarkdown
    ? `GitHub issue/PR context digest:\n\n\`\`\`markdown\n${githubContext.inlineMarkdown}\`\`\``
    : `The GitHub issue/PR context digest is ${githubContext.markdownBytes} bytes, so it was not inlined here. Read ${githubContext.markdownPath}.`;

  return {
    savedFiles,
    guidance,
    inlineContext
  };
}
