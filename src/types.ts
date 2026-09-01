/** Canonical actor identity: numeric user ID. Login is display-only. */
export interface Actor {
  id: number
  login: string
}

export type Placeholder = '__OWNER__' | '__MEMBER__' | '__COLLABORATOR__' | '__CONTRIBUTOR__'

/** One entry of the allowed-actors policy. */
export type ActorToken =
  | { kind: 'placeholder'; name: Placeholder }
  | { kind: 'user-id'; id: number }

/** Result of the __MEMBER__ org-membership API check. Wire semantics of each outcome live on `createMembershipApi`. */
export interface MembershipCheckResult {
  /**
   * - `member`: membership confirmed.
   * - `not-member`: authoritative negative answer.
   * - `unverified`: the check could not be performed; callers fail closed.
   */
  outcome: 'member' | 'not-member' | 'unverified'
  detail?: string
}

export interface MembershipApi {
  isOrgMember(org: string, username: string): Promise<MembershipCheckResult>
}

export type SkipCode =
  | 'UNSUPPORTED_EVENT'
  | 'COMMENT_NOT_CREATED'
  | 'MALFORMED_PAYLOAD'
  | 'NOT_A_PULL_REQUEST'
  | 'ACTOR_IS_BOT'
  | 'COMMAND_MISMATCH'

export type DenyCode = 'NOT_AUTHORIZED' | 'MEMBER_UNVERIFIED'

/**
 * Outcome of evaluating a review request.
 *
 * - `authorized`: the actor matched a policy token; the review pipeline may run.
 * - `denied`: the actor is human and issued the command on a PR but matched
 *   nothing (or a required API check was ambiguous — fail closed).
 * - `skipped`: not a review request at all (wrong event, not a PR, bot
 *   comment, command mismatch) — nothing to authorize, no alert-worthy event.
 */
export type Decision =
  | { kind: 'authorized'; rule: string; actor: Actor }
  | { kind: 'denied'; code: DenyCode; actor: Actor; detail?: string }
  | { kind: 'skipped'; code: SkipCode; detail?: string }

export interface RepositoryOwner {
  login: string
  type: 'Organization' | 'User' | (string & {})
}
