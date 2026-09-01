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

import { run } from '../src/index'
import type { MembershipApi } from '../src/types'

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

function outputs(): Map<string, string> {
  return new Map(
    coreMocks.setOutput.mock.calls.map(([name, value]) => [String(name), String(value)]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  coreMocks.getInput.mockReturnValue('')
})

describe('run', () => {
  it('writes outputs for an authorized trigger', async () => {
    const decision = await run({
      eventName: 'issue_comment',
      payload: OWNER_COMMENT,
      inputs: { allowedActors: '__OWNER__' },
      api: NOOP_API,
    })

    expect(decision).toEqual({ kind: 'authorized', rule: '__OWNER__', actor: { id: 1, login: 'boss' } })
    const o = outputs()
    expect(o.get('authorized')).toBe('true')
    expect(o.get('decision')).toBe('authorized')
    expect(o.get('reason')).toBe('AUTHORIZED')
    expect(o.get('rule')).toBe('__OWNER__')
    expect(o.get('actor-login')).toBe('boss')
    expect(o.get('actor-id')).toBe('1')
    expect(o.get('pr-number')).toBe('7')
    expect(coreMocks.setFailed).not.toHaveBeenCalled()
  })

  it('writes outputs for a denial', async () => {
    const decision = await run({
      eventName: 'issue_comment',
      payload: OWNER_COMMENT,
      inputs: { allowedActors: '__COLLABORATOR__' },
      api: NOOP_API,
    })

    expect(decision.kind).toBe('denied')
    const o = outputs()
    expect(o.get('authorized')).toBe('false')
    expect(o.get('reason')).toBe('NOT_AUTHORIZED')
    expect(o.has('rule')).toBe(false)
  })

  it('fails loud on a misconfigured policy (InputError)', async () => {
    await expect(
      run({
        eventName: 'issue_comment',
        payload: OWNER_COMMENT,
        inputs: { allowedActors: 'someone' },
        api: NOOP_API,
      }),
    ).rejects.toThrow(/Invalid allowed-actors token/)
    expect(coreMocks.setFailed).toHaveBeenCalledWith(expect.stringMatching(/Configuration error/))
  })

  it('fails loud on an unexpected error and rethrows', async () => {
    // valid policy so the config-error branch is passed; no payload source →
    // loadPayload throws → unexpected-error branch
    // CI sets GITHUB_EVENT_PATH to the real event file — clear it explicitly
    const prevPath = process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_EVENT_PATH
    try {
      await expect(run({ inputs: { allowedActors: '__OWNER__' } })).rejects.toThrow(
        /GITHUB_EVENT_PATH is not set/,
      )
      expect(coreMocks.setFailed).toHaveBeenCalledWith(expect.stringMatching(/Unexpected error/))
    } finally {
      if (prevPath !== undefined) process.env.GITHUB_EVENT_PATH = prevPath
    }
  })

  it('loads the payload from GITHUB_EVENT_PATH when no overrides are given', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'pra-test-'))
    const eventPath = join(dir, 'event.json')
    writeFileSync(eventPath, JSON.stringify(OWNER_COMMENT))

    const prevPath = process.env.GITHUB_EVENT_PATH
    const prevName = process.env.GITHUB_EVENT_NAME
    process.env.GITHUB_EVENT_PATH = eventPath
    process.env.GITHUB_EVENT_NAME = 'issue_comment'

    try {
      const decision = await run({ inputs: { allowedActors: '__OWNER__' }, api: NOOP_API })
      expect(decision).toEqual({ kind: 'authorized', rule: '__OWNER__', actor: { id: 1, login: 'boss' } })
    } finally {
      if (prevPath === undefined) delete process.env.GITHUB_EVENT_PATH
      else process.env.GITHUB_EVENT_PATH = prevPath
      if (prevName === undefined) delete process.env.GITHUB_EVENT_NAME
      else process.env.GITHUB_EVENT_NAME = prevName
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the step summary only when GITHUB_STEP_SUMMARY is set', async () => {
    const prev = process.env.GITHUB_STEP_SUMMARY
    delete process.env.GITHUB_STEP_SUMMARY

    try {
      await run({
        eventName: 'issue_comment',
        payload: OWNER_COMMENT,
        inputs: { allowedActors: '__OWNER__' },
        api: NOOP_API,
      })
      expect(coreMocks.summary.addRaw).not.toHaveBeenCalled()

      process.env.GITHUB_STEP_SUMMARY = '/tmp/unused-summary.md'
      await run({
        eventName: 'issue_comment',
        payload: OWNER_COMMENT,
        inputs: { allowedActors: '__OWNER__' },
        api: NOOP_API,
      })
      expect(coreMocks.summary.addRaw).toHaveBeenCalledTimes(1)
      expect(String(coreMocks.summary.addRaw.mock.calls[0]?.[0])).toContain('__OWNER__')
    } finally {
      if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY
      else process.env.GITHUB_STEP_SUMMARY = prev
    }
  })
})
