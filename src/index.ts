import { readFileSync } from 'node:fs'
import * as core from '@actions/core'
import { createMembershipApi } from './github'
import { InputError, parseAllowedActors } from './inputs'
import { evaluateReviewRequest } from './trigger'
import type { Decision, MembershipApi } from './types'

/** Inputs of this action, resolved from the Actions environment. */
export interface ActionInputs {
  allowedActors: string
  command: string
  token?: string
  /** True when the token is known to carry read:org (set explicitly for PAT/App tokens). */
  canSeePrivateMembers?: boolean
}

const REASON_CODES: Record<Decision['kind'], string> = {
  authorized: 'authorized',
  denied: 'denied',
  skipped: 'skipped',
}

export interface RunOverrides {
  eventName?: string
  payload?: unknown
  inputs?: Partial<ActionInputs>
  api?: MembershipApi
}

/** Resolve inputs. `canSeePrivateMembers` is an operator declaration (see action.yml), never inferred. */
function resolveInputs(overrides?: Partial<ActionInputs>): ActionInputs {
  const token = overrides?.token ?? (core.getInput('github-token') || undefined)
  const canSeePrivateMembers =
    overrides?.canSeePrivateMembers ?? (core.getInput('can-see-private-members') || 'false') === 'true'
  return {
    allowedActors: overrides?.allowedActors ?? core.getInput('allowed-actors'),
    command: overrides?.command ?? (core.getInput('command') || '/review'),
    token,
    canSeePrivateMembers,
  }
}

function loadPayload(): { eventName: string; payload: unknown } {
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set — not running inside Actions?')
  const payload: unknown = JSON.parse(readFileSync(eventPath, 'utf8'))
  return { eventName, payload }
}

/** Write the decision to outputs and (when available) the step summary. */
function writeResult(decision: Decision, prNumber?: number): void {
  core.setOutput('authorized', String(decision.kind === 'authorized'))
  core.setOutput('decision', REASON_CODES[decision.kind])

  if (decision.kind === 'skipped') {
    core.setOutput('reason', decision.code)
    core.info(`Skipped: ${decision.code}${decision.detail ? ` (${decision.detail})` : ''}`)
  } else {
    core.setOutput('reason', decision.kind === 'authorized' ? 'AUTHORIZED' : decision.code)
    core.setOutput('actor-login', decision.actor.login)
    core.setOutput('actor-id', String(decision.actor.id))
    if (prNumber !== undefined) core.setOutput('pr-number', String(prNumber))

    if (decision.kind === 'authorized') {
      core.setOutput('rule', decision.rule)
      core.info(`Authorized: ${decision.actor.login} (${decision.actor.id}) via ${decision.rule}`)
    } else {
      core.info(
        `Denied: ${decision.actor.login} (${decision.actor.id}) — ${decision.code}` +
          `${decision.detail ? ` (${decision.detail})` : ''}`,
      )
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows: string[] = ['| field | value |', '| --- | --- |']
    if (decision.kind === 'skipped') {
      rows.push(`| decision | skipped |`, `| reason | ${decision.code} |`)
      if (decision.detail) rows.push(`| detail | ${escapeCell(decision.detail)} |`)
    } else {
      rows.push(
        `| decision | ${decision.kind} |`,
        `| actor | ${escapeCell(decision.actor.login)} (${decision.actor.id}) |`,
        `| reason | ${decision.kind === 'authorized' ? 'AUTHORIZED' : decision.code} |`,
      )
      if (decision.kind === 'authorized') rows.push(`| rule | ${decision.rule} |`)
      if (decision.kind === 'denied' && decision.detail)
        rows.push(`| detail | ${escapeCell(decision.detail)} |`)
      if (prNumber !== undefined) rows.push(`| pr | #${prNumber} |`)
    }
    core.summary.addRaw(`## PR Review Agent\n\n${rows.join('\n')}\n`).write()
  }
}

/**
 * Action entrypoint. Authorization runs before anything else — no checkout,
 * no network beyond the membership probe, nothing expensive happens before
 * the gate.
 */
export async function run(overrides: RunOverrides = {}): Promise<Decision> {
  let inputs: ActionInputs
  try {
    inputs = resolveInputs(overrides.inputs)
    const policy = parseAllowedActors(inputs.allowedActors)

    const { eventName, payload } =
      overrides.eventName !== undefined || overrides.payload !== undefined
        ? { eventName: overrides.eventName ?? '', payload: overrides.payload }
        : loadPayload()

    const api =
      overrides.api ??
      createMembershipApi({
        token: inputs.token,
        canSeePrivateMembers: inputs.canSeePrivateMembers,
      })

    const { decision, prNumber } = await evaluateReviewRequest({
      eventName,
      payload,
      command: inputs.command,
      policy,
      api,
    })

    writeResult(decision, prNumber)
    return decision
  } catch (err) {
    if (err instanceof InputError) {
      // Misconfiguration is loud: the gate cannot be trusted, so fail the step.
      core.setFailed(`Configuration error: ${err.message}`)
    } else {
      core.setFailed(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    }
    throw err
  }
}
