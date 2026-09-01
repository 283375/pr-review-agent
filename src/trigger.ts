import { authorize } from './authorize'
import { commandMatches } from './inputs'
import type { Actor, ActorToken, Decision, MembershipApi, RepositoryOwner } from './types'

/** Minimal slice of the `issue_comment` webhook payload we rely on. */
export interface CommentPayload {
  action?: string
  issue?: {
    number?: number
    pull_request?: unknown
  }
  comment?: {
    body?: string
    author_association?: string
    user?: { login?: string; id?: number; type?: string }
  }
  repository?: {
    owner?: { login?: string; type?: string }
    name?: string
  }
}

export interface ReviewRequestEvaluation {
  decision: Decision
  prNumber?: number
}

/**
 * Evaluate whether an event is an authorized review request.
 *
 * The actor is always taken from the event subject — `payload.comment.user` —
 * never from `github.actor` or any ambient context: the permission applies to
 * whoever issued the command.
 *
 * Bot comments are skipped by default: bot-triggered reviews are both a
 * loop hazard and an actor-spoofing hazard (a compromised workflow could
 * post comments as the bot identity). Opt back in later if a real need
 * appears.
 */
export async function evaluateReviewRequest(params: {
  eventName: string
  payload: unknown
  command: string
  policy: readonly ActorToken[]
  api: MembershipApi
}): Promise<ReviewRequestEvaluation> {
  const { eventName, payload, command, policy, api } = params

  if (eventName !== 'issue_comment') {
    return {
      decision: {
        kind: 'skipped',
        code: 'UNSUPPORTED_EVENT',
        detail: `expected issue_comment, got ${eventName}`,
      },
    }
  }

  const p = payload as CommentPayload | null | undefined

  if (!p || p.action !== 'created') {
    return {
      decision: {
        kind: 'skipped',
        code: 'COMMENT_NOT_CREATED',
        detail: `issue_comment action is ${p?.action ?? 'missing'}, only "created" is handled`,
      },
    }
  }

  if (!p.comment?.user || typeof p.comment.user.id !== 'number' || !p.issue) {
    return {
      decision: { kind: 'skipped', code: 'MALFORMED_PAYLOAD', detail: 'missing comment.user or issue' },
    }
  }

  if (!p.issue.pull_request) {
    return {
      decision: {
        kind: 'skipped',
        code: 'NOT_A_PULL_REQUEST',
        detail: `issue #${p.issue.number ?? '?'} is not a pull request`,
      },
    }
  }

  const actor: Actor = {
    id: p.comment.user.id,
    login: p.comment.user.login ?? `id:${p.comment.user.id}`,
  }

  if ((p.comment.user.type ?? 'User') === 'Bot') {
    return { decision: { kind: 'skipped', code: 'ACTOR_IS_BOT', detail: `bot user ${actor.login} commented` } }
  }

  const body = p.comment.body ?? ''
  if (!commandMatches(body, command)) {
    return { decision: { kind: 'skipped', code: 'COMMAND_MISMATCH' } }
  }

  const owner: RepositoryOwner = {
    login: p.repository?.owner?.login ?? '',
    type: (p.repository?.owner?.type ?? 'User') as RepositoryOwner['type'],
  }
  const association = p.comment.author_association ?? 'NONE'

  const decision = await authorize({ actor, association, repositoryOwner: owner, policy, api })

  const prNumber = typeof p.issue.number === 'number' ? p.issue.number : undefined
  return prNumber === undefined ? { decision } : { decision, prNumber }
}
