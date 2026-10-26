import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import * as core from '@actions/core'
import { createGhGet } from './gh'
import { createReviewPublisher } from './publisher'
import {
  resolveLlmConfig,
  runReviewPipeline,
  type PipelinePaths,
} from './pipeline'
import { parseAllowedActors, commandMatches } from '../inputs'
import { authorize } from '../authorize'
import { createMembershipApi } from '../github'
import type { Decision, MembershipApi } from '../types'
import { extractUserMessage } from './prompt'

const actionLog = (message: string): void => core.info(message)

/**
 * Ensure a guest image with git/rg/fd exists: build the bundled image config
 * on first use. GONDOLIN_GUEST_DIR picks the output location (set by the
 * workflow to a cache-restored dir, or defaulting to the artifact work dir);
 * a set-but-empty dir (cache miss) is built into.
 */
function ensureGuestImage(actionRoot: string, workDir: string, env: Record<string, string | undefined>): string {
  const guestDir = env.GONDOLIN_GUEST_DIR || path.join(workDir, 'guest-assets')
  if (existsSync(path.join(guestDir, 'manifest.json'))) return guestDir

  if (process.platform === 'linux') {
    actionLog('Installing guest image build tools (lz4, cpio, e2fsprogs)...')
    spawnSync('sudo', ['apt-get', 'update'], { stdio: 'inherit' })
    spawnSync('sudo', ['apt-get', 'install', '-y', 'lz4', 'cpio', 'e2fsprogs'], { stdio: 'inherit' })
  }
  actionLog(`Building guest image into ${guestDir}...`)
  const res = spawnSync(
    'pnpm',
    ['exec', 'gondolin', 'build', '--config', path.join(actionRoot, 'gondolin', 'image.json'), '--output', guestDir],
    // Inherit so build progress is visible in the action log; a silent
    // capture made a slow build indistinguishable from a hang.
    { cwd: actionRoot, stdio: 'inherit', timeout: 10 * 60 * 1000 },
  )
  if (res.status !== 0 || !existsSync(path.join(guestDir, 'manifest.json'))) {
    throw new Error(
      `Guest image build failed (status=${res.status}, error=${res.error?.message ?? 'none'}) — see log above`,
    )
  }
  return guestDir
}

interface CommentPayload {
  action?: string
  issue?: { number?: number; pull_request?: unknown }
  comment?: {
    body?: string
    author_association?: string
    user?: { login?: string; id?: number; type?: string }
  }
  repository?: { owner?: { login?: string; type?: string }; name?: string }
}

export async function run(overrides: {
  env?: Record<string, string | undefined>
  payload?: unknown
  inputs?: Record<string, string | undefined>
  /** Test injection: membership API for the policy re-check. */
  api?: MembershipApi
} = {}): Promise<void> {
  const env = overrides.env ?? process.env
  const payload = overrides.payload ?? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))

  const p = payload as CommentPayload
  const repository = {
    owner: p.repository?.owner?.login ?? '',
    name: p.repository?.name ?? '',
  }
  const prNumber = p.issue?.number ?? 0

  if (env.GITHUB_EVENT_NAME !== 'issue_comment' || p.action !== 'created' || !p.issue?.pull_request || !p.comment?.user) {
    core.setOutput('review-published', 'false')
    core.setOutput('reason', 'NOT_A_REVIEW_REQUEST')
    core.info('Not a PR comment event; nothing to do.')
    return
  }

  const timeoutRaw = overrides.inputs?.['review-timeout-minutes'] ?? (core.getInput('review-timeout-minutes') || '15')
  const inputs = {
    allowedActors: overrides.inputs?.['allowed-actors'] ?? core.getInput('allowed-actors'),
    canSeePrivateMembers: (overrides.inputs?.['can-see-private-members'] ?? (core.getInput('can-see-private-members') || 'false')) === 'true',
    llmProvider: overrides.inputs?.['llm-provider'] ?? core.getInput('llm-provider'),
    llmApiKey: overrides.inputs?.['llm-api-key'] ?? core.getInput('llm-api-key'),
    llmBaseUrl: overrides.inputs?.['llm-base-url'] ?? core.getInput('llm-base-url'),
    llmModel: overrides.inputs?.['llm-model'] ?? core.getInput('llm-model'),
    githubToken: overrides.inputs?.['github-token'] ?? core.getInput('github-token'),
    timeoutMinutes: Number(timeoutRaw),
  }

  // Self-verification: the pipeline re-checks the comment author against the
  // same policy instead of trusting consumer wiring. Runs before anything
  // expensive; denial is a graceful skip (exit 0), not a red job.
  const user = p.comment.user
  if ((user.type ?? 'User') === 'Bot') {
    core.setOutput('review-published', 'false')
    core.setOutput('reason', 'ACTOR_IS_BOT')
    core.info('Comment author is a bot; nothing to do.')
    return
  }
  const decision: Decision = await authorize({
    actor: { login: user.login ?? '', id: user.id ?? 0 },
    association: p.comment.author_association ?? 'NONE',
    repositoryOwner: {
      login: repository.owner,
      type: p.repository?.owner?.type === 'Organization' ? 'Organization' : 'User',
    },
    policy: parseAllowedActors(inputs.allowedActors),
    api: overrides.api ?? createMembershipApi({
      token: inputs.githubToken,
      baseUrl: env.GITHUB_API_URL,
      canSeePrivateMembers: inputs.canSeePrivateMembers,
    }),
  })
  if (decision.kind !== 'authorized') {
    core.setOutput('review-published', 'false')
    core.setOutput('reason', decision.code)
    core.info(
      `Review request not authorized (${decision.code}${'detail' in decision && decision.detail ? `: ${decision.detail}` : ''}).`,
    )
    return
  }

  const body = p.comment.body ?? ''
  const command = overrides.inputs?.command ?? '/review'
  if (!commandMatches(body, command)) {
    core.setOutput('review-published', 'false')
    core.setOutput('reason', 'COMMAND_MISMATCH')
    return
  }

  // Operator misconfiguration fails loudly here, not at session spawn:
  // setTimeout coerces NaN to 0, so an unvalidated garbage value would
  // SIGKILL the session the instant it starts. Checked after the
  // authorization and command gates so denials keep their graceful skip.
  if (!Number.isFinite(inputs.timeoutMinutes) || inputs.timeoutMinutes <= 0) {
    core.setFailed(
      `Configuration error: review-timeout-minutes must be a positive number of minutes, got ${JSON.stringify(timeoutRaw)}`,
    )
    return
  }

  const llm = resolveLlmConfig(
    {
      llmProvider: inputs.llmProvider,
      llmApiKey: inputs.llmApiKey,
      llmBaseUrl: inputs.llmBaseUrl,
      llmModel: inputs.llmModel,
    },
    env,
  )

  // The review bundle lives at review/dist/review.cjs — two levels below the
  // repository root, where prompts/, pi/, gondolin/ and node_modules resolve.
  const actionRoot = overrides.env === undefined ? path.resolve(__dirname, '../..') : env.PR_REVIEW_ACTION_ROOT ?? '.'
  const workDir = path.join(env.RUNNER_TEMP ?? env.PR_REVIEW_WORKDIR ?? '.', 'pr-review-artifacts')

  // Dependency install happens declaratively in review/action.yml (composite
  // steps); the guest image is the only runtime-side bootstrap left. Test
  // injections (overrides.env) skip it entirely.
  const pipelineEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') pipelineEnv[k] = v
  }
  if (overrides.env === undefined) {
    pipelineEnv.GONDOLIN_GUEST_DIR = ensureGuestImage(actionRoot, workDir, env)
  }

  const result = await runReviewPipeline(
    {
      get: createGhGet({ token: inputs.githubToken }),
      publisher: createReviewPublisher({ token: inputs.githubToken }),
      spawn: envSpawn,
      paths: {
        workDir,
        sessionDir: path.join(workDir, 'sessions'),
        stagePath: path.join(workDir, 'stage.json'),
      } satisfies PipelinePaths,
      piCliPath: path.join(actionRoot, 'node_modules', '.bin', 'pi'),
      extensionPath: path.join(actionRoot, 'pi', 'review-extension.ts'),
      systemPromptPath: path.join(actionRoot, 'prompts', 'review-system.md'),
      env: pipelineEnv,
      log: actionLog,
    },
    {
      repository,
      prNumber,
      trigger: { login: p.comment.user.login ?? '', id: p.comment.user.id ?? 0 },
      userMessage: extractUserMessage(body, command),
      llm,
      githubToken: inputs.githubToken,
      timeoutMinutes: inputs.timeoutMinutes,
    },
  )

  core.setOutput('review-published', String(result.published))
  core.setOutput('reason', result.reason)
  core.setOutput('findings-count', String(result.findingsCount))
  core.setOutput('artifact-path', result.artifactPath)
  if (result.reviewUrl) core.setOutput('review-url', result.reviewUrl)
  for (const d of result.details ?? []) core.info(d)
  if (!result.published) {
    // Artifacts are already uploaded via the always() step; a silent green run
    // would hide pipeline failures from the PR author and repo watchers.
    core.setFailed(`Review pipeline did not publish (${result.reason})`)
  }
  core.summary.addRaw(
    `## PR Review pipeline\n\n| field | value |\n| --- | --- |\n` +
      `| decision | ${result.reason} |\n| findings | ${result.findingsCount} |\n` +
      `| artifacts | ${result.artifactPath} |\n`,
  ).write()
}

async function envSpawn(
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number; log?: (line: string) => void },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    // stdin must not be an open pipe: pi's print/json modes read piped stdin
    // and wait for EOF, so a never-closed pipe blocks startup before the
    // first event is emitted (observed as a silent infinite hang in CI).
    const child = spawn(cmd, args, { env: opts.env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const pump = (stream: NodeJS.ReadableStream, into: (line: string) => void): void => {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line.trim() !== '') into(line)
        }
      })
    }
    pump(child.stdout, (line) => {
      stdout += line + '\n'
      opts.log?.(line)
    })
    pump(child.stderr, (line) => {
      stderr += line + '\n'
      opts.log?.(`[stderr] ${line}`)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

