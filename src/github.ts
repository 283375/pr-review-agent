import type { MembershipApi, MembershipCheckResult } from './types'

/**
 * GitHub REST adapter for the org-membership check used by `__MEMBER__`.
 *
 * Uses `GET /orgs/{org}/members/{username}`:
 *   - 204 → member
 *   - 404 → NOT authoritative on its own: it may mean "not a member", but it
 *     is also what GitHub returns for private members when the token cannot
 *     see them (no read:org). The adapter therefore reports 404 as
 *     `not-member` only when the caller declares the token can see private
 *     members (`canSeePrivateMembers`), otherwise as `unverified` — fail
 *     closed on the ambiguity.
 *   - 401/403 → token problem, `unverified`
 *   - anything else / network error → `unverified`
 */
export function createMembershipApi(options: {
  token?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** True when the token carries read:org (PAT/App), so a 404 really means "not a member". */
  canSeePrivateMembers?: boolean
}): MembershipApi {
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    async isOrgMember(org: string, username: string): Promise<MembershipCheckResult> {
      const url = `${baseUrl}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-review-agent',
      }
      if (options.token) headers.Authorization = `Bearer ${options.token}`

      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (res.status === 204) return { outcome: 'member' }

        if (res.status === 404) {
          if (options.canSeePrivateMembers) {
            return { outcome: 'not-member' }
          }
          return {
            outcome: 'unverified',
            detail:
              'GET /orgs/.../members returned 404 — the user may be a private org member ' +
              'invisible to this token (GITHUB_TOKEN lacks read:org). Pass a PAT/App token ' +
              'with read:org to disambiguate, or rely on another allowed-actors token.',
          }
        }

        if (res.status === 401 || res.status === 403) {
          return {
            outcome: 'unverified',
            detail: `GitHub API returned ${res.status} for the membership check — token invalid or missing scope.`,
          }
        }

        return { outcome: 'unverified', detail: `GitHub API returned unexpected HTTP ${res.status}.` }
      } catch (err) {
        return { outcome: 'unverified', detail: `Membership check request failed: ${String(err)}` }
      }
    },
  }
}
