import type { Actor, ActorToken, Decision, MembershipApi, RepositoryOwner } from './types'

/**
 * Authorize the actor of a review request against the policy.
 *
 * Evaluation rules, in order:
 *
 * 1. Numeric user-ID tokens match canonically on `actor.id` — immune to
 *    renames, never ambiguous.
 * 2. `__OWNER__` / `__COLLABORATOR__` / `__CONTRIBUTOR__` are matched against
 *    the `author_association` field of the event payload, which GitHub
 *    computes server-side and which is reliable for these three values.
 * 3. `__MEMBER__` requires an explicit API check: `author_association` is
 *    unreliable for org members (private members show as NONE/CONTRIBUTOR,
 *    members who also contributed show as CONTRIBUTOR).
 *
 * Fail-closed semantics: if a `__MEMBER__` check cannot be performed
 * (network/auth errors, under-scoped token), the check is recorded and the
 * remaining tokens are still tried — a later, unambiguous match (e.g. a
 * numeric ID) still wins. If nothing matches and any member check was
 * unverified, the result is MEMBER_UNVERIFIED (not plain NOT_AUTHORIZED) so
 * operators can tell "not allowed" from "could not verify".
 */
export async function authorize(params: {
  actor: Actor
  association: string
  repositoryOwner: RepositoryOwner
  policy: readonly ActorToken[]
  api: MembershipApi
}): Promise<Decision> {
  const { actor, association, repositoryOwner, policy, api } = params

  let memberCheckUnverified: string | undefined

  for (const token of policy) {
    if (token.kind === 'user-id') {
      if (token.id === actor.id) {
        return { kind: 'authorized', rule: `user-id:${token.id}`, actor }
      }
      continue
    }

    switch (token.name) {
      case '__OWNER__':
        if (association === 'OWNER') {
          return { kind: 'authorized', rule: '__OWNER__', actor }
        }
        break

      case '__COLLABORATOR__':
        if (association === 'COLLABORATOR') {
          return { kind: 'authorized', rule: '__COLLABORATOR__', actor }
        }
        break

      case '__CONTRIBUTOR__':
        if (association === 'CONTRIBUTOR') {
          return { kind: 'authorized', rule: '__CONTRIBUTOR__', actor }
        }
        break

      case '__MEMBER__': {
        // A personal repo has no organization to be a member of — checking
        // would be meaningless, so treat as a non-match rather than a failure.
        if (repositoryOwner.type !== 'Organization') {
          memberCheckUnverified ??=
            'repository owner is not an Organization; __MEMBER__ cannot match'
          break
        }
        const check = await api.isOrgMember(repositoryOwner.login, actor.login)
        if (check.outcome === 'member') {
          return { kind: 'authorized', rule: '__MEMBER__', actor }
        }
        if (check.outcome === 'unverified') {
          memberCheckUnverified ??= check.detail ?? 'org membership check failed'
        }
        break
      }
    }
  }

  if (memberCheckUnverified !== undefined) {
    return {
      kind: 'denied',
      code: 'MEMBER_UNVERIFIED',
      actor,
      detail: memberCheckUnverified,
    }
  }

  return { kind: 'denied', code: 'NOT_AUTHORIZED', actor }
}
