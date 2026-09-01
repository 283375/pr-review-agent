import { describe, expect, it } from 'vitest'
import { createMembershipApi } from '../src/github'
import { evaluateReviewRequest } from '../src/trigger'
import type { ActorToken, MembershipApi } from '../src/types'

const POLICY: ActorToken[] = [{ kind: 'placeholder', name: '__OWNER__' }, { kind: 'user-id', id: 42 }]

const OWNER_COMMENT = {
  action: 'created',
  issue: { number: 7, pull_request: {} },
  comment: {
    body: '/review',
    author_association: 'OWNER',
    user: { login: 'boss', id: 1, type: 'User' },
  },
  repository: { owner: { login: 'acme', type: 'Organization' }, name: 'repo' },
}

const NOOP_API: MembershipApi = { isOrgMember: async () => ({ outcome: 'not-member' }) }

function evaluate(payload: unknown, eventName = 'issue_comment', api: MembershipApi = NOOP_API) {
  return evaluateReviewRequest({ eventName, payload, command: '/review', policy: POLICY, api })
}

describe('evaluateReviewRequest', () => {
  it('authorizes the owner trigger end-to-end', async () => {
    const { decision, prNumber } = await evaluate(OWNER_COMMENT)
    expect(decision).toEqual({ kind: 'authorized', rule: '__OWNER__', actor: { id: 1, login: 'boss' } })
    expect(prNumber).toBe(7)
  })

  it('authorizes by user ID end-to-end', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.comment!.author_association = 'NONE'
    payload.comment!.user = { login: 'helper', id: 42, type: 'User' }
    const { decision } = await evaluate(payload)
    expect(decision).toEqual({ kind: 'authorized', rule: 'user-id:42', actor: { id: 42, login: 'helper' } })
  })

  it('skips non-created actions (edited/deleted comment events)', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.action = 'edited'
    const { decision } = await evaluate(payload)
    expect(decision).toEqual({ kind: 'skipped', code: 'COMMENT_NOT_CREATED', detail: expect.any(String) })
  })

  it('skips comments on plain issues (not PRs)', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    delete (payload.issue as Record<string, unknown>).pull_request
    const { decision } = await evaluate(payload)
    expect(decision).toMatchObject({ kind: 'skipped', code: 'NOT_A_PULL_REQUEST' })
  })

  it('skips bot comments — no review loops, no bot identity abuse', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.comment!.user!.type = 'Bot'
    const { decision } = await evaluate(payload)
    expect(decision).toMatchObject({ kind: 'skipped', code: 'ACTOR_IS_BOT' })
  })

  it('skips comments that do not start with the command', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.comment!.body = 'looks good to me, ship it /review'
    const { decision } = await evaluate(payload)
    expect(decision).toEqual({ kind: 'skipped', code: 'COMMAND_MISMATCH' })
  })

  it('skips other event types entirely', async () => {
    const { decision } = await evaluate(OWNER_COMMENT, 'push')
    expect(decision).toEqual({ kind: 'skipped', code: 'UNSUPPORTED_EVENT', detail: expect.any(String) })
  })

  it('denies an unauthorized human actor', async () => {
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.comment!.author_association = 'NONE'
    payload.comment!.user = { login: 'mallory', id: 666, type: 'User' }
    const { decision } = await evaluate(payload)
    expect(decision).toEqual({ kind: 'denied', code: 'NOT_AUTHORIZED', actor: { id: 666, login: 'mallory' } })
  })

  it('takes the actor from the comment subject, not ambient identity', async () => {
    // The payload is the only source of truth; this test pins that behavior
    // by checking that authorization keys on comment.user, whatever the
    // surrounding workflow would report as github.actor.
    const payload = structuredClone(OWNER_COMMENT) as typeof OWNER_COMMENT
    payload.comment!.author_association = 'NONE'
    payload.comment!.user = { login: 'random-passenger', id: 999, type: 'User' }
    const { decision } = await evaluate(payload)
    expect(decision).toMatchObject({ kind: 'denied', actor: { id: 999 } })
  })
})

describe('createMembershipApi', () => {
  function fetchResponder(status: number) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(null, { status })
    }) as typeof fetch
    return { impl, calls }
  }

  it('maps 204 to member', async () => {
    const { impl, calls } = fetchResponder(204)
    const api = createMembershipApi({ token: 't', fetchImpl: impl, canSeePrivateMembers: false })
    expect(await api.isOrgMember('acme', 'alice')).toEqual({ outcome: 'member' })
    expect(calls[0]?.url).toBe('https://api.github.com/orgs/acme/members/alice')
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer t' })
  })

  it('treats 404 as ambiguous without read:org (fail closed)', async () => {
    const { impl } = fetchResponder(404)
    const api = createMembershipApi({ token: 't', fetchImpl: impl, canSeePrivateMembers: false })
    const r = await api.isOrgMember('acme', 'alice')
    expect(r.outcome).toBe('unverified')
    expect(r.detail).toMatch(/read:org/)
  })

  it('treats 404 as authoritative not-member with read:org', async () => {
    const { impl } = fetchResponder(404)
    const api = createMembershipApi({ token: 't', fetchImpl: impl, canSeePrivateMembers: true })
    expect(await api.isOrgMember('acme', 'alice')).toEqual({ outcome: 'not-member' })
  })

  it('maps 403 to unverified (under-scoped token)', async () => {
    const { impl } = fetchResponder(403)
    const api = createMembershipApi({ token: 't', fetchImpl: impl })
    const r = await api.isOrgMember('acme', 'alice')
    expect(r.outcome).toBe('unverified')
    expect(r.detail).toMatch(/403/)
  })

  it('maps network errors to unverified', async () => {
    const api = createMembershipApi({
      fetchImpl: (async () => {
        throw new Error('boom')
      }) as typeof fetch,
    })
    const r = await api.isOrgMember('acme', 'alice')
    expect(r.outcome).toBe('unverified')
    expect(r.detail).toMatch(/boom/)
  })

  it('respects baseUrl override (GHES / mock servers)', async () => {
    const { impl, calls } = fetchResponder(204)
    const api = createMembershipApi({ baseUrl: 'https://ghe.example.com/api/v3/', fetchImpl: impl })
    await api.isOrgMember('acme', 'alice')
    expect(calls[0]?.url).toBe('https://ghe.example.com/api/v3/orgs/acme/members/alice')
  })
})
