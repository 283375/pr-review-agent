import type { ActorToken, Placeholder } from './types'

export const PLACEHOLDERS = ['__OWNER__', '__MEMBER__', '__COLLABORATOR__', '__CONTRIBUTOR__'] as const
const PLACEHOLDER_SET: ReadonlySet<string> = new Set(PLACEHOLDERS)

export class InputError extends Error {}

/**
 * Parse the `allowed-actors` input into policy tokens.
 *
 * Tokens are separated by whitespace, commas or semicolons. Each token is
 * either a reserved placeholder (case-insensitive, normalized to upper case)
 * or a numeric GitHub user ID. Any other token is a configuration error and
 * must fail fast — a silent typo in the policy would otherwise widen the gate
 * or, worse, lock everyone out.
 */
export function parseAllowedActors(raw: string): ActorToken[] {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    throw new InputError(
      'allowed-actors is empty — the review agent would never run. ' +
        'Provide placeholders (e.g. __OWNER__) and/or numeric GitHub user IDs.',
    )
  }

  return tokens.map(parseToken)
}

function parseToken(token: string): ActorToken {
  const upper = token.toUpperCase()
  if (PLACEHOLDER_SET.has(upper)) {
    return { kind: 'placeholder', name: upper as Placeholder }
  }
  if (/^\d+$/.test(token)) {
    return { kind: 'user-id', id: Number(token) }
  }
  throw new InputError(
    `Invalid allowed-actors token "${token}". ` +
      `Use a reserved placeholder (${PLACEHOLDERS.join(', ')}) or a numeric GitHub user ID. ` +
      'Logins are deliberately not accepted: users can rename themselves, IDs are canonical.',
  )
}

/**
 * Match the command at the start of a comment body (case-insensitive).
 * Requires the command to be followed by end-of-input or whitespace, so
 * `/review` does not match `/reviews-only`.
 */
export function commandMatches(body: string, command: string): boolean {
  const normalized = body.trim()
  const cmd = command.trim()
  if (cmd.length === 0) return false
  if (!normalized.toLowerCase().startsWith(cmd.toLowerCase())) return false
  const rest = normalized.slice(cmd.length)
  return rest.length === 0 || /^\s/.test(rest)
}
