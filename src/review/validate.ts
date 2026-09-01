import Ajv2020 from 'ajv/dist/2020'
import {
  REVIEW_OUTPUT_SCHEMA,
  type BlockedCapability,
  type ReviewFinding,
  type ReviewOutput,
} from './schema'

const ajv = new Ajv2020({ allErrors: true })
const validateSchema = ajv.compile(REVIEW_OUTPUT_SCHEMA)

export interface SemanticContext {
  /** Repo-relative POSIX paths of the PR's changed files (head side). */
  changedFiles: readonly string[]
  /** Policy caps; defaults are deliberately conservative. */
  maxFindings?: number
  maxBlockedCapabilities?: number
  maxBodyLength?: number
}

export type ValidationResult =
  | { ok: true; review: ReviewOutput }
  | { ok: false; errors: string[] }

const DEFAULTS = {
  maxFindings: 25,
  maxBlockedCapabilities: 20,
  maxBodyLength: 4000,
}

/**
 * Normalize a path to repo-relative POSIX form, rejecting anything that
 * escapes the repository. Agent-supplied paths are untrusted input.
 */
export function normalizeRepoPath(p: string): string | undefined {
  const posix = p.replace(/\\/g, '/')
  let normalized = posix.startsWith('./') ? posix.slice(2) : posix
  if (normalized.startsWith('/') || normalized === '') return undefined
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return undefined
    segments.push(segment)
  }
  normalized = segments.join('/')
  return normalized === '' ? undefined : normalized
}

const SUGGESTION_FENCE = /```suggestion\b/

/**
 * Validate the agent's raw output: JSON Schema first (shape and enums), then
 * semantic policy (paths must resolve into the changed-file set, line ranges
 * must be sane, caps on volume). Anything passing both may be published;
 * anything failing either is dropped with reason codes — a failed validation
 * never blocks the gate, it only means fewer or no comments.
 */
export function validateReviewOutput(raw: unknown, ctx: SemanticContext): ValidationResult {
  if (!validateSchema(raw)) {
    const errors = (validateSchema.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`,
    )
    return { ok: false, errors }
  }

  const review = raw as ReviewOutput
  const maxFindings = ctx.maxFindings ?? DEFAULTS.maxFindings
  const maxBlocked = ctx.maxBlockedCapabilities ?? DEFAULTS.maxBlockedCapabilities
  const maxBody = ctx.maxBodyLength ?? DEFAULTS.maxBodyLength

  const errors: string[] = []
  const changed = new Set(ctx.changedFiles)

  const findings: ReviewFinding[] = []
  review.findings.forEach((f, i) => {
    const label = `findings[${i}]`

    const file = normalizeRepoPath(f.file)
    if (file === undefined) {
      errors.push(`${label}.file: path escapes the repository or is empty (${f.file})`)
      return
    }
    if (!changed.has(file)) {
      errors.push(`${label}.file: not in the PR's changed files (${file})`)
      return
    }
    const endLine = f.endLine ?? f.startLine
    if (endLine < f.startLine) {
      errors.push(`${label}: endLine (${endLine}) is before startLine (${f.startLine})`)
      return
    }
    if (f.body.length > maxBody) {
      errors.push(`${label}.body: ${f.body.length} chars exceeds the ${maxBody} cap`)
      return
    }
    if (SUGGESTION_FENCE.test(f.body)) {
      errors.push(`${label}.body: suggestion blocks are not allowed in v0 output`)
      return
    }
    findings.push({ ...f, file })
  })

  if (review.findings.length > maxFindings) {
    errors.push(
      `findings: ${review.findings.length} entries exceeds the ${maxFindings} cap ` +
        '(possible injection-driven flooding)',
    )
  }

  const blockedCapabilities: BlockedCapability[] | undefined =
    review.blockedCapabilities === undefined
      ? undefined
      : review.blockedCapabilities.slice(0, maxBlocked)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, review: { summary: review.summary, findings, blockedCapabilities } }
}
