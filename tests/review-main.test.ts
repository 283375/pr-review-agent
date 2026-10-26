import { beforeEach, describe, expect, it, vi } from 'vitest'

const coreMocks = vi.hoisted(() => ({
  getInput: vi.fn(() => ''),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  summary: {
    addRaw: vi.fn((_raw: string) => ({ write: vi.fn() })),
  },
}))

vi.mock('@actions/core', () => ({ default: {}, ...coreMocks }))

import { run } from '../src/review/main'
import type { MembershipApi } from '../src/types'

const BASE_ENV = { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_API_URL: 'https://api.github.com' }

function payload(overrides: { comment?: Record<string, unknown> } = {}) {
  return {
    action: 'created',
    issue: { number: 7, pull_request: {} },
    comment: {
      body: '/review',
      author_association: 'OWNER',
      user: { login: 'boss', id: 1, type: 'User' },
      ...overrides.comment,
    },
    repository: { owner: { login: 'acme', type: 'Organization' }, name: 'repo' },
  }
}

const NOT_MEMBER_API: MembershipApi = { isOrgMember: async () => ({ outcome: 'not-member' }) }

function outputs(): Map<string, string> {
  return new Map(
    coreMocks.setOutput.mock.calls.map(([name, value]) => [String(name), String(value)]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  coreMocks.getInput.mockReturnValue('')
})

describe('review run() self-verification', () => {
  it('skips gracefully when the actor matches no policy token', async () => {
    await run({
      env: BASE_ENV,
      payload: payload({ comment: { body: '/review', author_association: 'NONE', user: { login: 'stranger', id: 999, type: 'User' } } }),
      inputs: { 'allowed-actors': '__OWNER__', 'github-token': 't' },
      api: NOT_MEMBER_API,
    })

    const o = outputs()
    expect(o.get('review-published')).toBe('false')
    expect(o.get('reason')).toBe('NOT_AUTHORIZED')
    expect(coreMocks.setFailed).not.toHaveBeenCalled()
  })

  it('authorizes via payload association and reaches the command check', async () => {
    // Authorized (OWNER) but the comment body is not the trigger command:
    // proving the authz gate passed without running the pipeline.
    await run({
      env: BASE_ENV,
      payload: payload({ comment: { body: 'not the command', author_association: 'OWNER', user: { login: 'boss', id: 1, type: 'User' } } }),
      inputs: { 'allowed-actors': '__OWNER__', 'github-token': 't' },
      api: NOT_MEMBER_API,
    })

    expect(outputs().get('reason')).toBe('COMMAND_MISMATCH')
  })

  it('matches numeric user IDs canonically', async () => {
    await run({
      env: BASE_ENV,
      payload: payload({ comment: { body: 'not the command', author_association: 'NONE', user: { login: 'boss', id: 1, type: 'User' } } }),
      inputs: { 'allowed-actors': '1', 'github-token': 't' },
      api: NOT_MEMBER_API,
    })

    expect(outputs().get('reason')).toBe('COMMAND_MISMATCH')
  })

  it('fails closed on an unverifiable __MEMBER__ check', async () => {
    const unverified: MembershipApi = {
      isOrgMember: async () => ({ outcome: 'unverified', detail: '404 without read:org' }),
    }
    await run({
      env: BASE_ENV,
      payload: payload(),
      inputs: { 'allowed-actors': '__MEMBER__', 'github-token': 't' },
      api: unverified,
    })

    const o = outputs()
    expect(o.get('review-published')).toBe('false')
    expect(o.get('reason')).toBe('MEMBER_UNVERIFIED')
  })

  it('verifies __MEMBER__ through the API when the token can see members', async () => {
    const member: MembershipApi = { isOrgMember: async () => ({ outcome: 'member' }) }
    await run({
      env: BASE_ENV,
      payload: payload({ comment: { body: 'not the command', author_association: 'NONE', user: { login: 'orgmember', id: 5, type: 'User' } } }),
      inputs: { 'allowed-actors': '__MEMBER__', 'github-token': 't', 'can-see-private-members': 'true' },
      api: member,
    })

    expect(outputs().get('reason')).toBe('COMMAND_MISMATCH')
  })

  it('skips bot authors before the policy check', async () => {
    await run({
      env: BASE_ENV,
      payload: payload({ comment: { body: '/review', author_association: 'OWNER', user: { login: 'bot', id: 2, type: 'Bot' } } }),
      inputs: { 'allowed-actors': '__OWNER__', 'github-token': 't' },
      api: NOT_MEMBER_API,
    })

    expect(outputs().get('reason')).toBe('ACTOR_IS_BOT')
  })

  it('throws a configuration error on an empty policy', async () => {
    await expect(
      run({
        env: BASE_ENV,
        payload: payload(),
        inputs: { 'allowed-actors': '', 'github-token': 't' },
        api: NOT_MEMBER_API,
      }),
    ).rejects.toThrow(/allowed-actors is empty/)
  })
})
