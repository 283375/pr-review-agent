import { describe, expect, it } from 'vitest'
import {
  REVIEW_MARKER,
  toReviewComments,
  type ReviewFinding,
  type ReviewOutput,
} from '../src/review/schema'
import { createReviewPublisher } from '../src/review/publisher'
import { normalizeRepoPath, validateReviewOutput } from '../src/review/validate'

const CHANGED = ['src/app.ts', 'lib/util.py']

const GOOD_FINDING: ReviewFinding = {
  file: 'src/app.ts',
  startLine: 12,
  severity: 'blocker',
  category: 'correctness',
  title: 'off-by-one in the loop bound',
  body: 'The loop drops the final element; see the comparison below the assignment.',
}

function baseReview(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    summary: 'One blocker found; otherwise the change is sound.',
    findings: [{ ...GOOD_FINDING }],
    ...overrides,
  }
}

describe('validateReviewOutput', () => {
  it('accepts a well-formed review within policy caps', () => {
    const result = validateReviewOutput(baseReview(), { changedFiles: CHANGED })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.review.findings).toHaveLength(1)
      expect(result.review.summary).toContain('blocker')
    }
  })

  it('rejects schema-invalid output (unknown severity)', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, severity: 'catastrophic' as never }],
    })
    const result = validateReviewOutput(bad, { changedFiles: CHANGED })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/severity/)
  })

  it('rejects style-only categories via the enum', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, category: 'naming-style' as never }],
    })
    expect(validateReviewOutput(bad, { changedFiles: CHANGED }).ok).toBe(false)
  })

  it('rejects findings on files outside the PR', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, file: 'src/elsewhere.ts' }],
    })
    const result = validateReviewOutput(bad, { changedFiles: CHANGED })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/not in the PR's changed files/)
  })

  it('rejects path traversal instead of normalizing it away', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, file: '../../.github/workflows/x.yml' }],
    })
    const result = validateReviewOutput(bad, { changedFiles: CHANGED })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/escapes the repository/)
  })

  it('normalizes ./ prefixes before the changed-file check', () => {
    const review = baseReview({
      findings: [{ ...GOOD_FINDING, file: './src/app.ts' }],
    })
    expect(validateReviewOutput(review, { changedFiles: CHANGED }).ok).toBe(true)
  })

  it('rejects inverted line ranges', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, startLine: 20, endLine: 10 }],
    })
    expect(validateReviewOutput(bad, { changedFiles: CHANGED }).ok).toBe(false)
  })

  it('rejects suggestion blocks by policy (v0)', () => {
    const bad = baseReview({
      findings: [
        {
          ...GOOD_FINDING,
          body: 'try this:\n```suggestion\nfoo()\n```',
        },
      ],
    })
    const result = validateReviewOutput(bad, { changedFiles: CHANGED })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/suggestion blocks/)
  })

  it('fails closed on finding floods (injection-driven volume)', () => {
    const flood = Array.from({ length: 30 }, (_, i) => ({
      ...GOOD_FINDING,
      startLine: i + 1,
    }))
    const result = validateReviewOutput(baseReview({ findings: flood }), {
      changedFiles: CHANGED,
      maxFindings: 25,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/cap/)
  })

  it('caps body length', () => {
    const bad = baseReview({
      findings: [{ ...GOOD_FINDING, body: 'x'.repeat(5000) }],
    })
    expect(validateReviewOutput(bad, { changedFiles: CHANGED }).ok).toBe(false)
  })

  it('truncates blockedCapabilities to the cap instead of rejecting', () => {
    const flood = Array.from({ length: 30 }, (_, i) => ({
      capability: 'network',
      target: `host-${i}.example.com`,
      reason: 'docs lookup',
    }))
    const result = validateReviewOutput(baseReview({ blockedCapabilities: flood }), {
      changedFiles: CHANGED,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.review.blockedCapabilities).toHaveLength(20)
  })

  it('accepts a minimal review without blockedCapabilities', () => {
    const result = validateReviewOutput(
      { summary: 'Nothing to report.', findings: [] },
      { changedFiles: CHANGED },
    )
    expect(result.ok).toBe(true)
  })
})

describe('normalizeRepoPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['src//a.ts', 'src/a.ts'],
    ['src\\a.ts', 'src/a.ts'],
    ['..%2Fetc', '..%2Fetc'], // percent-encoding is not decoded here; wire layer must not pre-decode
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected)
  })
  it.each(['../a.ts', '/abs/a.ts', '', './..'])('rejects %s', (input) => {
    expect(normalizeRepoPath(input)).toBeUndefined()
  })
})

describe('toReviewComments', () => {
  it('maps single-line findings without startLine', () => {
    const comments = toReviewComments(baseReview())
    expect(comments).toEqual([
      {
        path: 'src/app.ts',
        line: 12,
        body: expect.stringContaining('off-by-one'),
      },
    ])
  })

  it('maps ranges to line + startLine', () => {
    const comments = toReviewComments(
      baseReview({ findings: [{ ...GOOD_FINDING, startLine: 10, endLine: 14 }] }),
    )
    expect(comments[0]).toMatchObject({ line: 14, startLine: 10 })
  })
})

describe('createReviewPublisher', () => {
  function fetchCapture(status = 201, body: unknown = { id: 99, html_url: 'https://x/r/99' }) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch
    return { impl, calls }
  }

  it('submits a COMMENT review with the marker and mapped comments', async () => {
    const { impl, calls } = fetchCapture()
    const publisher = createReviewPublisher({ token: 't', fetchImpl: impl })
    const published = await publisher.publishReview({
      owner: 'acme',
      repo: 'repo',
      prNumber: 7,
      review: baseReview(),
    })

    expect(published).toEqual({ id: 99, htmlUrl: 'https://x/r/99' })
    const sent = JSON.parse(String(calls[0]?.init?.body))
    expect(calls[0]?.url).toContain('/repos/acme/repo/pulls/7/reviews')
    expect(sent.event).toBe('COMMENT')
    expect(sent.body.startsWith(REVIEW_MARKER)).toBe(true)
    expect(sent.comments).toHaveLength(1)
    expect(sent.comments[0]).toMatchObject({ path: 'src/app.ts', line: 12, side: 'RIGHT' })
  })

  it('anchors the review to commit_id when one is provided', async () => {
    const { impl, calls } = fetchCapture()
    const publisher = createReviewPublisher({ token: 't', fetchImpl: impl })
    await publisher.publishReview({ owner: 'acme', repo: 'repo', prNumber: 7, review: baseReview(), commitId: 'abc123' })
    const sent = JSON.parse(String(calls[0]?.init?.body))
    expect(sent.commit_id).toBe('abc123')
  })

  it('throws on API failure with the response detail', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('Validation Failed', { status: 422 })
    }) as typeof fetch
    const publisher = createReviewPublisher({ token: 't', fetchImpl: impl })
    await expect(
      publisher.publishReview({
        owner: 'acme',
        repo: 'repo',
        prNumber: 7,
        review: baseReview(),
      }),
    ).rejects.toThrow(/422/)
  })
})
