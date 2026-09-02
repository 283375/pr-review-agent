import { REVIEW_MARKER, toReviewComments, type ReviewOutput } from './schema'

export interface PublishedReview {
  id: number
  htmlUrl?: string
}

export interface ReviewPublisher {
  /** Submit the review with event COMMENT; the agent can never choose the event. */
  publishReview(params: {
    owner: string
    repo: string
    prNumber: number
    review: ReviewOutput
    /** Head SHA the review is anchored to; keeps line anchors stable if the head moves. */
    commitId?: string
  }): Promise<PublishedReview>
}

export interface PublisherOptions {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * GitHub adapter for publishing reviews. Kept dumb on purpose: callers
 * validate before calling; this layer only maps the contract onto the REST
 * API and reports transport-level failures.
 */
export function createReviewPublisher(options: PublisherOptions): ReviewPublisher {
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  return {
    async publishReview({ owner, repo, prNumber, review, commitId }) {
      const comments = toReviewComments(review).map((c) => ({
        path: c.path,
        line: c.line,
        ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: 'RIGHT' as const } : {}),
        side: 'RIGHT' as const,
        body: c.body,
      }))

      const res = await fetchImpl(`${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pr-review-agent',
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          ...(commitId ? { commit_id: commitId } : {}),
          event: 'COMMENT',
          body: `${REVIEW_MARKER}\n${review.summary}`,
          comments,
        }),
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`GitHub API ${res.status} while submitting review: ${detail.slice(0, 500)}`)
      }

      const data = (await res.json()) as { id: number; html_url?: string }
      return { id: data.id, htmlUrl: data.html_url }
    },
  }
}
