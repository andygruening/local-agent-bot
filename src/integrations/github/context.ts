import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config/index.ts";
import { runGh } from "./gh.ts";
import type { GitHubResponseTarget } from "./response.ts";

export type GitHubIssueContextState = {
  target: {
    repo: string;
    issueNumber: number;
  };
  fetchedAt: string;
  rawPath: string;
  markdownPath: string;
  inlineMarkdown?: string;
  markdownBytes: number;
  skippedReason?: "dry_run" | "github_context_disabled";
  codeChangeRequested: boolean;
  codeChangeIntent: {
    source: string;
    matchedTerms: string[];
  };
  issue: GitHubIssueSummary | undefined;
  currentPullRequest: GitHubPullRequestSummary | undefined;
  linkedOpenPullRequests: GitHubPullRequestSummary[];
  counts: {
    issueComments: number;
    issueEvents: number;
    pullRequestReviewComments: number;
    pullRequestReviews: number;
  };
};

export type GitHubIssueSummary = {
  number: number | undefined;
  title: string | undefined;
  state: string | undefined;
  author: string | undefined;
  url: string | undefined;
  labels: string[];
  isPullRequest: boolean;
};

export type GitHubPullRequestSummary = {
  repo: string;
  number: number;
  title: string | undefined;
  state: string | undefined;
  url: string | undefined;
  draft: boolean | undefined;
  author: string | undefined;
  head: {
    repo: string | undefined;
    ref: string | undefined;
    sha: string | undefined;
  };
  base: {
    repo: string | undefined;
    ref: string | undefined;
    sha: string | undefined;
  };
};

export class GitHubContextError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

type RawGitHubIssueContext = {
  target: {
    repo: string;
    issueNumber: number;
  };
  fetchedAt: string;
  codeChangeIntent: GitHubIssueContextState["codeChangeIntent"];
  codeChangeRequested: boolean;
  issue: unknown;
  issueComments: unknown[];
  issueEvents: unknown[];
  currentPullRequest?: unknown;
  pullRequestReviewComments: unknown[];
  pullRequestReviews: unknown[];
  linkedOpenPullRequests: unknown[];
};

type PullRequestReference = {
  repo: string;
  number: number;
};

const codeChangePatterns: Array<{ term: string; pattern: RegExp }> = [
  { term: "integrate", pattern: /\bintegrat(?:e|es|ed|ing|ion)\b/i },
  { term: "implement", pattern: /\bimplement(?:s|ed|ing|ation)?\b/i },
  { term: "fix", pattern: /\bfix(?:es|ed|ing)?\b/i },
  { term: "change", pattern: /\bchang(?:e|es|ed|ing)\b/i },
  { term: "modify", pattern: /\bmodif(?:y|ies|ied|ying)\b/i },
  { term: "update", pattern: /\bupdat(?:e|es|ed|ing)\b/i },
  { term: "add", pattern: /\badd(?:s|ed|ing)?\b/i },
  { term: "remove", pattern: /\bremov(?:e|es|ed|ing)\b/i },
  { term: "refactor", pattern: /\brefactor(?:s|ed|ing)?\b/i },
  { term: "migrate", pattern: /\bmigrat(?:e|es|ed|ing|ion)\b/i },
  { term: "wire", pattern: /\bwir(?:e|es|ed|ing)\b/i },
  { term: "build", pattern: /\bbuild(?:s|ing)?\b|\bbuilt\b/i },
  { term: "code", pattern: /\b(?:code|source code)\b/i },
  { term: "push", pattern: /\bpush(?:es|ed|ing)?\b/i },
  { term: "commit", pattern: /\bcommit(?:s|ted|ting)?\b/i },
  { term: "pull request", pattern: /\b(?:open|create|update)\s+(?:a\s+)?(?:pr|pull request)\b/i }
];

export async function fetchGitHubIssueContext(
  config: AppConfig,
  jobDir: string,
  target: GitHubResponseTarget,
  payload: unknown
): Promise<GitHubIssueContextState> {
  const rawPath = path.join(jobDir, "github-context.json");
  const markdownPath = path.join(jobDir, "github-context.md");
  const skippedReason = config.core.dryRun
    ? "dry_run"
    : config.integrations.github.contextEnabled
      ? undefined
      : "github_context_disabled";

  if (skippedReason) {
    const state: GitHubIssueContextState = {
      target: targetForState(target),
      fetchedAt: new Date().toISOString(),
      rawPath,
      markdownPath,
      markdownBytes: 0,
      skippedReason,
      codeChangeRequested: false,
      codeChangeIntent: {
        source: "not evaluated",
        matchedTerms: []
      },
      issue: undefined,
      currentPullRequest: undefined,
      linkedOpenPullRequests: [],
      counts: {
        issueComments: 0,
        issueEvents: 0,
        pullRequestReviewComments: 0,
        pullRequestReviews: 0
      }
    };
    await writeFile(rawPath, `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(markdownPath, "");
    logGitHubContext("GitHub issue context skipped:", {
      reason: skippedReason,
      target: state.target
    });
    return state;
  }

  const fetchedAt = new Date().toISOString();
  const [issue, issueComments, timelineItems, issueEvents] = await Promise.all([
    ghApiJson(config, `repos/${target.repo}/issues/${target.issueNumber}`, "fetch_issue"),
    ghApiJsonList(
      config,
      `repos/${target.repo}/issues/${target.issueNumber}/comments`,
      "fetch_issue_comments"
    ),
    ghApiJsonList(
      config,
      `repos/${target.repo}/issues/${target.issueNumber}/timeline`,
      "fetch_issue_timeline"
    ),
    ghApiJsonList(
      config,
      `repos/${target.repo}/issues/${target.issueNumber}/events`,
      "fetch_issue_events"
    )
  ]);

  const issueIsPullRequest = isPullRequestIssue(issue) || isRecord(payload) && isRecord(payload.pull_request);
  const [currentPullRequest, pullRequestReviewComments, pullRequestReviews] = issueIsPullRequest
    ? await Promise.all([
        ghApiJson(config, `repos/${target.repo}/pulls/${target.issueNumber}`, "fetch_pull_request"),
        ghApiJsonList(
          config,
          `repos/${target.repo}/pulls/${target.issueNumber}/comments`,
          "fetch_pull_request_review_comments"
        ),
        ghApiJsonList(
          config,
          `repos/${target.repo}/pulls/${target.issueNumber}/reviews`,
          "fetch_pull_request_reviews"
        )
      ])
    : [undefined, [], []];

  const codeChangeIntent = detectCodeChangeIntent(payload);
  const linkedOpenPullRequests = await fetchLinkedOpenPullRequests(
    config,
    target.repo,
    issue,
    issueComments,
    timelineItems
  );
  const rawContext: RawGitHubIssueContext = {
    target: targetForState(target),
    fetchedAt,
    codeChangeIntent,
    codeChangeRequested: codeChangeIntent.matchedTerms.length > 0,
    issue,
    issueComments,
    issueEvents,
    currentPullRequest,
    pullRequestReviewComments,
    pullRequestReviews,
    linkedOpenPullRequests
  };
  const stateBase = buildStateBase(
    target,
    fetchedAt,
    rawPath,
    markdownPath,
    rawContext
  );
  const markdown = buildGitHubContextMarkdown(rawContext, stateBase);
  const markdownBytes = Buffer.byteLength(markdown);
  const state: GitHubIssueContextState = {
    ...stateBase,
    markdownBytes,
    inlineMarkdown:
      markdownBytes <= config.integrations.github.contextInlineMaxBytes ? markdown : undefined
  };

  await Promise.all([
    writeFile(rawPath, `${JSON.stringify(rawContext, null, 2)}\n`),
    writeFile(markdownPath, markdown)
  ]);
  logGitHubContext("GitHub issue context fetched:", {
    target: state.target,
    rawPath,
    markdownPath,
    markdownBytes,
    codeChangeRequested: state.codeChangeRequested,
    linkedOpenPullRequests: state.linkedOpenPullRequests.map((pullRequest) => ({
      repo: pullRequest.repo,
      number: pullRequest.number,
      title: pullRequest.title
    })),
    counts: state.counts
  });
  return state;
}

function buildStateBase(
  target: GitHubResponseTarget,
  fetchedAt: string,
  rawPath: string,
  markdownPath: string,
  rawContext: RawGitHubIssueContext
): Omit<GitHubIssueContextState, "markdownBytes" | "inlineMarkdown"> {
  const currentPullRequest = rawContext.currentPullRequest
    ? summarizePullRequest(target.repo, rawContext.currentPullRequest)
    : undefined;

  return {
    target: targetForState(target),
    fetchedAt,
    rawPath,
    markdownPath,
    codeChangeRequested: rawContext.codeChangeRequested,
    codeChangeIntent: rawContext.codeChangeIntent,
    issue: summarizeIssue(rawContext.issue),
    currentPullRequest,
    linkedOpenPullRequests: rawContext.linkedOpenPullRequests.flatMap((pullRequest) => {
      const summary = summarizePullRequest(target.repo, pullRequest);
      return summary.state === "open" ? [summary] : [];
    }),
    counts: {
      issueComments: rawContext.issueComments.length,
      issueEvents: rawContext.issueEvents.length,
      pullRequestReviewComments: rawContext.pullRequestReviewComments.length,
      pullRequestReviews: rawContext.pullRequestReviews.length
    }
  };
}

function buildGitHubContextMarkdown(
  rawContext: RawGitHubIssueContext,
  state: Omit<GitHubIssueContextState, "markdownBytes" | "inlineMarkdown">
): string {
  const lines: string[] = [
    "# GitHub Issue Context",
    "",
    `Fetched at: ${state.fetchedAt}`,
    `Repository: ${state.target.repo}`,
    `Issue/PR number: ${state.target.issueNumber}`,
    `Code-change request detected: ${state.codeChangeRequested ? "yes" : "no"}`,
    `Intent source: ${state.codeChangeIntent.source}`,
    `Matched intent terms: ${state.codeChangeIntent.matchedTerms.join(", ") || "none"}`,
    "",
    "## Target",
    "",
    `Title: ${state.issue?.title ?? "unknown"}`,
    `State: ${state.issue?.state ?? "unknown"}`,
    `Author: ${state.issue?.author ?? "unknown"}`,
    `URL: ${state.issue?.url ?? "unknown"}`,
    `Labels: ${state.issue?.labels.join(", ") || "none"}`,
    `Is pull request: ${state.issue?.isPullRequest ? "yes" : "no"}`,
    ""
  ];

  if (state.currentPullRequest) {
    appendPullRequestSummary(lines, "Current Pull Request", state.currentPullRequest);
  }

  lines.push("## Referenced Open Pull Requests", "");
  if (state.linkedOpenPullRequests.length === 0) {
    lines.push("none", "");
  } else {
    for (const pullRequest of state.linkedOpenPullRequests) {
      appendPullRequestSummary(lines, `PR #${pullRequest.number}`, pullRequest);
    }
  }

  lines.push(
    "## Work Target Guidance",
    "",
    state.codeChangeRequested
      ? "The triggering text appears to ask for integration or code changes. If the target is a pull request, or one referenced open PR clearly matches the task, use that PR branch as the work target. Prefer `gh pr checkout <number> --repo <repo>` before editing, then commit and push to the checked-out branch. If no referenced PR clearly matches, create a new branch, commit the smallest appropriate change, push it, and open a pull request with `gh pr create --repo <repo>`. Do not report code changes as done while they exist only in the local workspace."
      : "The triggering text does not clearly ask for integration or code changes. Treat referenced PRs as context only. Do not checkout, push, or upload source changes solely because a PR is referenced.",
    "",
    "## Issue Comments",
    ""
  );
  appendBodies(lines, rawContext.issueComments, formatIssueComment);

  lines.push("## Issue Events", "");
  appendBodies(lines, rawContext.issueEvents, formatIssueEvent);

  if (rawContext.pullRequestReviewComments.length > 0) {
    lines.push("## Pull Request Review Comments", "");
    appendBodies(lines, rawContext.pullRequestReviewComments, formatPullRequestReviewComment);
  }

  if (rawContext.pullRequestReviews.length > 0) {
    lines.push("## Pull Request Reviews", "");
    appendBodies(lines, rawContext.pullRequestReviews, formatPullRequestReview);
  }

  return `${lines.join("\n")}\n`;
}

async function ghApiJson(config: AppConfig, apiPath: string, step: string): Promise<unknown> {
  const result = await runGh(config.integrations.github, [
    "api",
    apiPath,
    "-H",
    "Accept: application/vnd.github+json"
  ]);
  if (result.exitCode !== 0) {
    throw new GitHubContextError(step, result.stderr.trim());
  }

  return parseJson(result.stdout, step);
}

async function ghApiJsonList(config: AppConfig, apiPath: string, step: string): Promise<unknown[]> {
  const result = await runGh(config.integrations.github, [
    "api",
    apiPath,
    "--paginate",
    "--slurp",
    "-H",
    "Accept: application/vnd.github+json"
  ]);
  if (result.exitCode !== 0) {
    throw new GitHubContextError(step, result.stderr.trim());
  }

  return flattenPaginatedJson(parseJson(result.stdout, step));
}

async function fetchLinkedOpenPullRequests(
  config: AppConfig,
  targetRepo: string,
  issue: unknown,
  comments: unknown[],
  timelineItems: unknown[]
): Promise<unknown[]> {
  const references = dedupePullRequestReferences([
    ...pullRequestReferencesFromTimeline(timelineItems, targetRepo),
    ...pullRequestReferencesFromText(readString(isRecord(issue) ? issue.body : undefined) ?? ""),
    ...comments.flatMap((comment) =>
      pullRequestReferencesFromText(readString(isRecord(comment) ? comment.body : undefined) ?? "")
    )
  ]);
  const details = await Promise.all(
    references.map(async (reference) => {
      try {
        return await ghApiJson(
          config,
          `repos/${reference.repo}/pulls/${reference.number}`,
          "fetch_linked_pull_request"
        );
      } catch (error: unknown) {
        logGitHubContext("GitHub linked pull request fetch failed:", {
          reference,
          error: errorMessage(error)
        });
        return undefined;
      }
    })
  );

  return details.filter((detail) => summarizePullRequest(targetRepo, detail).state === "open");
}

function pullRequestReferencesFromTimeline(
  timelineItems: unknown[],
  targetRepo: string
): PullRequestReference[] {
  return timelineItems.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const source = isRecord(item.source) ? item.source : undefined;
    const sourceIssue = isRecord(source?.issue) ? source.issue : undefined;
    if (!sourceIssue || !isRecord(sourceIssue.pull_request)) {
      return [];
    }

    const number = readPositiveInteger(sourceIssue.number);
    if (!number) {
      return [];
    }

    const repo =
      readString(isRecord(sourceIssue.repository) ? sourceIssue.repository.full_name : undefined) ??
      repoFromGitHubUrl(readString(sourceIssue.html_url)) ??
      targetRepo;

    return [{ repo, number }];
  });
}

function pullRequestReferencesFromText(text: string): PullRequestReference[] {
  const matches = text.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([1-9][0-9]*)\b/g);
  return Array.from(matches, (match) => ({
    repo: match[1] ?? "",
    number: Number.parseInt(match[2] ?? "0", 10)
  })).filter((reference) => reference.repo && reference.number > 0);
}

function detectCodeChangeIntent(payload: unknown): GitHubIssueContextState["codeChangeIntent"] {
  const sourceTexts = triggeringTexts(payload);
  for (const sourceText of sourceTexts) {
    const matchedTerms = codeChangePatterns
      .filter((entry) => entry.pattern.test(sourceText.text))
      .map((entry) => entry.term);
    if (matchedTerms.length > 0) {
      return {
        source: sourceText.source,
        matchedTerms
      };
    }
  }

  return {
    source: sourceTexts[0]?.source ?? "none",
    matchedTerms: []
  };
}

function triggeringTexts(payload: unknown): Array<{ source: string; text: string }> {
  if (!isRecord(payload)) {
    return [];
  }

  return [
    { source: "comment.body", text: readBody(payload.comment) },
    { source: "review.body", text: readBody(payload.review) },
    { source: "pull_request.body", text: readBody(payload.pull_request) },
    { source: "issue.body", text: readBody(payload.issue) },
    { source: "payload.body", text: readString(payload.body) }
  ].filter((item): item is { source: string; text: string } => Boolean(item.text));
}

function summarizeIssue(issue: unknown): GitHubIssueSummary | undefined {
  if (!isRecord(issue)) {
    return undefined;
  }

  return {
    number: readPositiveInteger(issue.number),
    title: readString(issue.title),
    state: readString(issue.state),
    author: readString(isRecord(issue.user) ? issue.user.login : undefined),
    url: readString(issue.html_url),
    labels: readLabels(issue.labels),
    isPullRequest: isPullRequestIssue(issue)
  };
}

function summarizePullRequest(defaultRepo: string, pullRequest: unknown): GitHubPullRequestSummary {
  const record = isRecord(pullRequest) ? pullRequest : {};
  const head = isRecord(record.head) ? record.head : {};
  const base = isRecord(record.base) ? record.base : {};

  return {
    repo:
      readString(isRecord(base.repo) ? base.repo.full_name : undefined) ??
      repoFromGitHubUrl(readString(record.html_url)) ??
      defaultRepo,
    number: readPositiveInteger(record.number) ?? 0,
    title: readString(record.title),
    state: readString(record.state),
    url: readString(record.html_url),
    draft: typeof record.draft === "boolean" ? record.draft : undefined,
    author: readString(isRecord(record.user) ? record.user.login : undefined),
    head: {
      repo: readString(isRecord(head.repo) ? head.repo.full_name : undefined),
      ref: readString(head.ref),
      sha: readString(head.sha)
    },
    base: {
      repo: readString(isRecord(base.repo) ? base.repo.full_name : undefined),
      ref: readString(base.ref),
      sha: readString(base.sha)
    }
  };
}

function appendPullRequestSummary(
  lines: string[],
  heading: string,
  pullRequest: GitHubPullRequestSummary
): void {
  lines.push(
    `### ${heading}`,
    "",
    `Title: ${pullRequest.title ?? "unknown"}`,
    `State: ${pullRequest.state ?? "unknown"}`,
    `Draft: ${pullRequest.draft === undefined ? "unknown" : pullRequest.draft ? "yes" : "no"}`,
    `Author: ${pullRequest.author ?? "unknown"}`,
    `URL: ${pullRequest.url ?? "unknown"}`,
    `Head: ${pullRequest.head.repo ?? "unknown"}:${pullRequest.head.ref ?? "unknown"} (${pullRequest.head.sha ?? "unknown"})`,
    `Base: ${pullRequest.base.repo ?? "unknown"}:${pullRequest.base.ref ?? "unknown"} (${pullRequest.base.sha ?? "unknown"})`,
    `Checkout: gh pr checkout ${pullRequest.number} --repo ${pullRequest.repo}`,
    ""
  );
}

function appendBodies(
  lines: string[],
  items: unknown[],
  formatter: (item: unknown, index: number) => string[]
): void {
  if (items.length === 0) {
    lines.push("none", "");
    return;
  }

  items.forEach((item, index) => {
    lines.push(...formatter(item, index), "");
  });
}

function formatIssueComment(comment: unknown, index: number): string[] {
  const record = isRecord(comment) ? comment : {};
  return [
    `### Issue Comment ${readPositiveInteger(record.id) ?? index + 1}`,
    "",
    `Author: ${readString(isRecord(record.user) ? record.user.login : undefined) ?? "unknown"}`,
    `Created: ${readString(record.created_at) ?? "unknown"}`,
    `URL: ${readString(record.html_url) ?? "unknown"}`,
    "",
    readString(record.body) ?? "(empty)"
  ];
}

function formatIssueEvent(item: unknown, index: number): string[] {
  const record = isRecord(item) ? item : {};
  return [
    `- ${readString(record.created_at) ?? "unknown"} ${readString(record.event) ?? "unknown"} by ${readString(isRecord(record.actor) ? record.actor.login : undefined) ?? "unknown"} (id: ${readPositiveInteger(record.id) ?? index + 1})`
  ];
}

function formatPullRequestReviewComment(comment: unknown, index: number): string[] {
  const record = isRecord(comment) ? comment : {};
  return [
    `### PR Review Comment ${readPositiveInteger(record.id) ?? index + 1}`,
    "",
    `Author: ${readString(isRecord(record.user) ? record.user.login : undefined) ?? "unknown"}`,
    `Path: ${readString(record.path) ?? "unknown"}`,
    `Line: ${readPositiveInteger(record.line) ?? readPositiveInteger(record.original_line) ?? "unknown"}`,
    `Created: ${readString(record.created_at) ?? "unknown"}`,
    `URL: ${readString(record.html_url) ?? "unknown"}`,
    "",
    readString(record.body) ?? "(empty)"
  ];
}

function formatPullRequestReview(review: unknown, index: number): string[] {
  const record = isRecord(review) ? review : {};
  return [
    `### PR Review ${readPositiveInteger(record.id) ?? index + 1}`,
    "",
    `Author: ${readString(isRecord(record.user) ? record.user.login : undefined) ?? "unknown"}`,
    `State: ${readString(record.state) ?? "unknown"}`,
    `Submitted: ${readString(record.submitted_at) ?? "unknown"}`,
    `URL: ${readString(record.html_url) ?? "unknown"}`,
    "",
    readString(record.body) ?? "(empty)"
  ];
}

function targetForState(target: GitHubResponseTarget): GitHubIssueContextState["target"] {
  return {
    repo: target.repo,
    issueNumber: target.issueNumber
  };
}

function isPullRequestIssue(issue: unknown): boolean {
  return isRecord(issue) && isRecord(issue.pull_request);
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }

    if (isRecord(item) && typeof item.name === "string") {
      return [item.name];
    }

    return [];
  });
}

function dedupePullRequestReferences(references: PullRequestReference[]): PullRequestReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.repo}#${reference.number}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function repoFromGitHubUrl(value: string | undefined): string | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/[1-9][0-9]*\b/.exec(value ?? "");
  return match?.[1];
}

function flattenPaginatedJson(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  if (value.every(Array.isArray)) {
    return value.flatMap((page) => page);
  }

  return value;
}

function parseJson(value: string, step: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new GitHubContextError(step, `Failed to parse gh JSON output: ${errorMessage(error)}`);
  }
}

function readBody(value: unknown): string | undefined {
  return isRecord(value) && typeof value.body === "string" ? value.body : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function logGitHubContext(message: string, details: Record<string, unknown>): void {
  console.log(message, JSON.stringify({ at: new Date().toISOString(), ...details }, null, 2));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
