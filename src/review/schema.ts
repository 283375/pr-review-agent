/**
 * Review output contract (v0).
 *
 * The agent emits this JSON; the publisher may only post reviews that pass
 * both schema validation (`REVIEW_OUTPUT_SCHEMA`) and semantic validation
 * (`validateReviewOutput`). The agent never decides approve/request-changes —
 * the output carries findings only, and the review is always submitted with
 * event COMMENT.
 */
export type Severity = 'blocker' | 'concern' | 'note'

export type Category =
  | 'correctness'
  | 'security'
  | 'reliability'
  | 'maintainability'
  | 'compatibility'

export interface ReviewFinding {
  /** Repo-relative POSIX path of the file the finding applies to. */
  file: string
  /** 1-based line number on the head side of the diff. */
  startLine: number
  /** Inclusive end of the commented range; defaults to startLine. */
  endLine?: number
  severity: Severity
  category: Category
  /** One-line headline of the finding. */
  title: string
  /** Markdown detail. Suggestion blocks are rejected by policy (v0). */
  body: string
}

export interface BlockedCapability {
  /** Capability that was denied, e.g. `network`, `ci_log`, `tool:bash`. */
  capability: string
  /** What the agent tried to reach, e.g. a hostname, a job id, a tool name. */
  target: string
  /** Why the agent needed it. */
  reason: string
}

export interface ReviewOutput {
  /** Overall assessment as markdown. */
  summary: string
  findings: ReviewFinding[]
  /** Capabilities the agent needed but was denied by policy. */
  blockedCapabilities?: BlockedCapability[]
}

export interface FindingComment {
  path: string
  /** GitHub review-comment range: `line` is the range end, `start_line` the start. */
  line: number
  startLine?: number
  body: string
}

/** Mapping of ReviewOutput onto GitHub review comments (head side only). */
export function toReviewComments(review: ReviewOutput): FindingComment[] {
  return review.findings.map((f) => ({
    path: f.file,
    line: f.endLine ?? f.startLine,
    ...(f.endLine !== undefined && f.endLine !== f.startLine
      ? { startLine: f.startLine }
      : {}),
    body: renderFindingBody(f),
  }))
}

/** Marked body so future re-reviews can find and update past reviews. */
export const REVIEW_MARKER = '<!-- pr-review-agent:v0 -->'

export function renderFindingBody(f: ReviewFinding): string {
  return `**[${f.severity}/${f.category}]** ${f.title}\n\n${f.body}`
}

/** JSON Schema (draft 2020-12) for the agent's raw JSON output. */
export const REVIEW_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'startLine', 'severity', 'category', 'title', 'body'],
        properties: {
          file: { type: 'string', minLength: 1, maxLength: 4096 },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          severity: { enum: ['blocker', 'concern', 'note'] },
          category: {
            enum: ['correctness', 'security', 'reliability', 'maintainability', 'compatibility'],
          },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
        },
      },
    },
    blockedCapabilities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['capability', 'target', 'reason'],
        properties: {
          capability: { type: 'string', minLength: 1, maxLength: 128 },
          target: { type: 'string', minLength: 1, maxLength: 512 },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
} as const
