import type { PrMetadata } from './metadata'
import { commandMatches } from '../inputs'

export interface TaskContext {
  /** The authorized user who issued the /review command (from the event payload). */
  trigger: { login: string; id: number }
  /** Free text after the /review command; may be empty. */
  userMessage: string
}

/**
 * Build the task block that is sent as pi's initial user message.
 *
 * Shape mirrors prompts/review-task.template.md (that file is documentation);
 * everything except USER_REQUEST is untrusted data by the system prompt's
 * terms. Content is inserted verbatim: the block is data-delimited, and the
 * system prompt tells the model that only USER_REQUEST carries instructions.
 */
export function buildTaskBlock(meta: PrMetadata, ctx: TaskContext): string {
  const lines = [
    '----- PR_METADATA -----',
    `repository: ${meta.repository.owner}/${meta.repository.name}`,
    `pr_number: ${meta.prNumber}`,
    `title: ${meta.title}`,
    `author: ${meta.author.login} (id ${meta.author.id})`,
    `base: ${meta.baseRef} @ ${meta.baseSha}`,
    `head: ${meta.headRef} @ ${meta.headSha}`,
    `changed_files: ${meta.changedFiles.length}`,
    ...meta.changedFiles,
    `prComments: ${meta.commentCount}`,
    `body: ${truncate(meta.body, 8000)}`,
    '',
    '----- USER_REQUEST -----',
    `issued_by: ${ctx.trigger.login} (id ${ctx.trigger.id})  // authorized by policy`,
    'command: /review',
    'message: <<<USER_MESSAGE',
    ctx.userMessage.trim(),
    'USER_MESSAGE',
  ]
  return lines.join('\n')
}

/** The task instruction appended after the block, as the initial user message. */
export function buildInitialPrompt(meta: PrMetadata, ctx: TaskContext): string {
  const block = buildTaskBlock(meta, ctx)
  const focus = ctx.userMessage.trim()
  const tail = focus
    ? 'Review this pull request per the output contract. The requesting reviewer added focus guidance in the USER_REQUEST message above; treat it as guidance subject to the judgment standards.'
    : 'Review this pull request per the output contract.'
  return `${block}\n\n----- TASK -----\n${tail}`
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… [truncated]` : value
}

/** Strip the command prefix from a comment body; the rest is the reviewer's focus guidance. */
export function extractUserMessage(body: string, command: string): string {
  if (!commandMatches(body, command)) return ''
  const normalized = body.trim()
  return normalized.slice(command.trim().length).trim()
}
