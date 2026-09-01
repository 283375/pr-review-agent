/** Shared read-only GitHub REST access for host-side tools and the runner. */

export interface GhGet {
  (pathname: string): Promise<{ status: number; json: unknown }>
}

export function createGhGet(options: {
  token?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): GhGet {
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000

  return async (pathname: string) => {
    const res = await fetchImpl(`${baseUrl}${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-review-agent',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    const json: unknown = text ? JSON.parse(text) : null
    return { status: res.status, json }
  }
}
