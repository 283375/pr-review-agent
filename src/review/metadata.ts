import type { GhGet } from './gh'

export interface PrMetadata {
  repository: { owner: string; name: string }
  prNumber: number
  title: string
  body: string
  author: { login: string; id: number }
  baseRef: string
  baseSha: string
  headRef: string
  headSha: string
  /** Repo-relative POSIX paths of changed files on the head side. */
  changedFiles: string[]
  /** issue comments + review comments, from the PR object counters. */
  commentCount: number
}

export class MetadataError extends Error {}

const MAX_FILES = 500

interface Pull {
  title?: string
  body?: string | null
  number?: number
  user?: { login?: string; id?: number }
  base?: { ref?: string; sha?: string }
  head?: { ref?: string; sha?: string }
  changed_files?: number
  comments?: number
  review_comments?: number
}

/**
 * Collect everything the task block needs, via read-only GETs only.
 * File lists are capped: a PR changing more than MAX_FILES paths is reviewed
 * against the first MAX_FILES (the cap is surfaced in the metadata block).
 */
export async function collectPrMetadata(
  get: GhGet,
  repository: { owner: string; name: string },
  prNumber: number,
): Promise<PrMetadata> {
  const base = `/repos/${repository.owner}/${repository.name}`
  const pullRes = await get(`${base}/pulls/${prNumber}`)
  if (pullRes.status !== 200) {
    throw new MetadataError(`GET pulls/${prNumber} returned ${pullRes.status}`)
  }
  const pull = pullRes.json as Pull

  const author = { login: pull.user?.login ?? 'unknown', id: pull.user?.id ?? 0 }
  const changedFiles: string[] = []
  let truncatedFiles = false
  for (let page = 1; changedFiles.length < MAX_FILES; page++) {
    const res = await get(`${base}/pulls/${prNumber}/files?per_page=100&page=${page}`)
    if (res.status !== 200) {
      throw new MetadataError(`GET pulls/${prNumber}/files page ${page} returned ${res.status}`)
    }
    const files = res.json as Array<{ filename?: string }>
    if (!Array.isArray(files) || files.length === 0) break
    for (const f of files) {
      if (changedFiles.length >= MAX_FILES) {
        truncatedFiles = true
        break
      }
      if (f.filename) changedFiles.push(f.filename)
    }
    if (!Array.isArray(files) || files.length < 100) break
  }

  if (truncatedFiles) {
    throw new MetadataError(
      `PR changes more than ${MAX_FILES} files; file list truncated. ` +
        'This agent does not review partially-listed diffs — reduce the PR size.',
    )
  }

  return {
    repository,
    prNumber,
    title: pull.title ?? '',
    body: pull.body ?? '',
    author,
    baseRef: pull.base?.ref ?? '',
    baseSha: pull.base?.sha ?? '',
    headRef: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    changedFiles,
    commentCount: (pull.comments ?? 0) + (pull.review_comments ?? 0),
  }
}
