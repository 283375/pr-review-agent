import { describe, expect, it } from 'vitest'
import { authorize } from '../src/authorize'
import type { Actor, MembershipApi, RepositoryOwner } from '../src/types'

const ACTOR: Actor = { id: 42, login: 'alice' }
const ORG: RepositoryOwner = { login: 'acme', type: 'Organization' }

function apiWith(
  impl: (org: string, username: string) => 'member' | 'not-member' | 'unverified',
): MembershipApi & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return {
    calls,
    async isOrgMember(org, username) {
      calls.push([org, username])
      const outcome = impl(org, username)
      return outcome === 'member' ? { outcome } : { outcome, detail: `stub: ${outcome}` }
    },
  }
}

describe('authorize', () => {
  it('authorizes by canonical numeric user ID even when an earlier __MEMBER__ check is unverified', async () => {
    const api = apiWith(() => 'unverified')
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }, { kind: 'user-id', id: 42 }],
      api,
    })
    expect(result).toEqual({ kind: 'authorized', rule: 'user-id:42', actor: ACTOR })
  })

  it('short-circuits: a deterministic ID match runs before any API call', async () => {
    const api = apiWith(() => 'member')
    await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [{ kind: 'user-id', id: 42 }, { kind: 'placeholder', name: '__MEMBER__' }],
      api,
    })
    expect(api.calls).toEqual([])
  })

  it.each([
    ['OWNER', '__OWNER__'],
    ['COLLABORATOR', '__COLLABORATOR__'],
    ['CONTRIBUTOR', '__CONTRIBUTOR__'],
  ] as const)('association %s matches placeholder %s (reliable server-side values)', async (association, placeholder) => {
    const result = await authorize({
      actor: ACTOR,
      association,
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: placeholder }],
      api: apiWith(() => {
        throw new Error('must not be called')
      }),
    })
    expect(result).toEqual({ kind: 'authorized', rule: placeholder, actor: ACTOR })
  })

  it('__MEMBER__ authorizes via the org membership API', async () => {
    const api = apiWith(() => 'member')
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }],
      api,
    })
    expect(result).toEqual({ kind: 'authorized', rule: '__MEMBER__', actor: ACTOR })
    expect(api.calls).toEqual([['acme', 'alice']])
  })

  it('denies a private org member when the token cannot see private members (the 404 ambiguity)', async () => {
    const api = apiWith(() => 'unverified')
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE', // private members show as NONE/CONTRIBUTOR in author_association
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }],
      api,
    })
    expect(result).toEqual({
      kind: 'denied',
      code: 'MEMBER_UNVERIFIED',
      actor: ACTOR,
      detail: 'stub: unverified',
    })
  })

  it('fail-closed still honors a later unambiguous token after an unverified member check', async () => {
    const api = apiWith(() => 'unverified')
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [
        { kind: 'placeholder', name: '__MEMBER__' },
        { kind: 'user-id', id: 42 },
      ],
      api,
    })
    expect(result).toEqual({ kind: 'authorized', rule: 'user-id:42', actor: ACTOR })
  })

  it('reports MEMBER_UNVERIFIED (not NOT_AUTHORIZED) when member check failed and nothing else matched', async () => {
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }],
      api: apiWith(() => 'unverified'),
    })
    expect(result).toMatchObject({ kind: 'denied', code: 'MEMBER_UNVERIFIED' })
  })

  it('plainly denies when the actor matches nothing', async () => {
    const result = await authorize({
      actor: { id: 7, login: 'mallory' },
      association: 'NONE',
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__OWNER__' }, { kind: 'user-id', id: 42 }],
      api: apiWith(() => 'not-member'),
    })
    expect(result).toEqual({ kind: 'denied', code: 'NOT_AUTHORIZED', actor: { id: 7, login: 'mallory' } })
  })

  it('treats __MEMBER__ as structurally inapplicable on personal repos (recorded, then plain deny)', async () => {
    const result = await authorize({
      actor: ACTOR,
      association: 'NONE',
      repositoryOwner: { login: 'solo', type: 'User' },
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }],
      api: apiWith(() => {
        throw new Error('must not be called')
      }),
    })
    expect(result).toEqual({
      kind: 'denied',
      code: 'MEMBER_UNVERIFIED',
      actor: ACTOR,
      detail: 'repository owner is not an Organization; __MEMBER__ cannot match',
    })
  })

  it('authorizes a member whose association degrades to CONTRIBUTOR (contributor+member overlap)', async () => {
    // documents github-script#643: association says CONTRIBUTOR for members who also contributed
    const result = await authorize({
      actor: ACTOR,
      association: 'CONTRIBUTOR',
      repositoryOwner: ORG,
      policy: [{ kind: 'placeholder', name: '__MEMBER__' }],
      api: apiWith(() => 'member'),
    })
    expect(result).toEqual({ kind: 'authorized', rule: '__MEMBER__', actor: ACTOR })
  })
})
