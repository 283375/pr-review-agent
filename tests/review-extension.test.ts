import { describe, expect, it } from 'vitest'
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { toGuestPath } from '../pi/review-extension'

const CWD = '/home/runner/work/repo/repo'

describe('toGuestPath', () => {
  it('maps host paths into the read-only /workspace mount', () => {
    expect(toGuestPath(CWD, `${CWD}/src/app.ts`)).toBe('/workspace/src/app.ts')
    expect(toGuestPath(CWD, CWD)).toBe('/workspace')
    expect(toGuestPath(CWD, 'src/app.ts')).toBe('/workspace/src/app.ts')
  })

  it('tolerates guest-side absolute paths', () => {
    expect(toGuestPath(CWD, '/workspace/src/app.ts')).toBe('/workspace/src/app.ts')
  })

  it('rejects paths outside the workspace', () => {
    expect(() => toGuestPath(CWD, '/etc/passwd')).toThrow(/outside the workspace/)
    expect(() => toGuestPath(CWD, `${CWD}/../secrets`)).toThrow(/outside the workspace/)
  })
})

// ---------------------------------------------------------------------------
// createPublishHandler

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublishHandler, type PublishDeps } from '../pi/review-extension'

const GOOD_REVIEW = {
  summary: 'Sound change; one concern.',
  findings: [
    {
      file: 'src/a.ts',
      startLine: 3,
      severity: 'concern',
      category: 'reliability',
      title: 'unchecked null',
      body: 'The value can be null here.',
    },
  ],
}

function publishSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'pra-publish-'))
  const stagePath = join(dir, 'stage.json')
  const publishedPath = join(dir, 'published.json')
  const deps: PublishDeps & { calls: number } = {
    stagePath,
    publishedPath,
    changedFiles: ['src/a.ts'],
    owner: 'acme',
    repo: 'repo',
    prNumber: 7,
    commitId: 'abc123',
    publisher: {
      publishReview: async (p) => {
        deps.calls += 1
        return { id: 99, htmlUrl: 'https://example.com/r/99' }
      },
    },
    calls: 0,
  }
  return { deps, stagePath, publishedPath }
}

describe('createPublishHandler', () => {
  it('validates, publishes once, and records the marker', async () => {
    const { deps, stagePath, publishedPath } = publishSetup()
    writeFileSync(stagePath, JSON.stringify(GOOD_REVIEW))
    const handler = createPublishHandler(deps)

    const first = await handler()
    expect(first.isError).toBe(false)
    expect(first.text).toContain('https://example.com/r/99')
    expect(deps.calls).toBe(1)
    expect(existsSync(publishedPath)).toBe(true)

    // Idempotent: a second call reports the URL and never re-publishes.
    const second = await handler()
    expect(second.isError).toBe(false)
    expect(second.text).toContain('already published')
    expect(deps.calls).toBe(1)
  })

  it('passes the commit id and validated review to the publisher', async () => {
    const { deps, stagePath } = publishSetup()
    let received: Record<string, unknown> | undefined
    deps.publisher.publishReview = async (p) => {
      received = p as unknown as Record<string, unknown>
      return { id: 1 }
    }
    writeFileSync(stagePath, JSON.stringify(GOOD_REVIEW))
    await createPublishHandler(deps)()
    expect(received).toMatchObject({ owner: 'acme', prNumber: 7, commitId: 'abc123' })
  })

  it('refuses to publish nothing or invalid content', async () => {
    const { deps, stagePath } = publishSetup()
    const missing = await createPublishHandler(deps)()
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('Nothing staged')

    writeFileSync(stagePath, JSON.stringify({ ...GOOD_REVIEW, findings: [{ ...GOOD_REVIEW.findings[0], file: 'unrelated.ts' }] }))
    const invalid = await createPublishHandler(deps)()
    expect(invalid.isError).toBe(true)
    expect(invalid.text).toContain('failed validation')
    expect(deps.calls).toBe(0)
  })

  it('returns GitHub API errors as data with fix guidance', async () => {
    const { deps, stagePath } = publishSetup()
    deps.publisher.publishReview = async () => {
      throw new Error('GitHub API 422: Line could not be resolved')
    }
    writeFileSync(stagePath, JSON.stringify(GOOD_REVIEW))
    const result = await createPublishHandler(deps)()
    expect(result.isError).toBe(true)
    expect(result.text).toContain('422')
    expect(result.text).toContain('restage with submit_review')
    expect(existsSync(join(dirname(stagePath), 'published.json'))).toBe(false)
  })

  it('reports missing configuration instead of publishing to a malformed URL', async () => {
    const { deps } = publishSetup()
    deps.owner = undefined
    const result = await createPublishHandler(deps)()
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not configured')
    expect(deps.calls).toBe(0)
  })
})
