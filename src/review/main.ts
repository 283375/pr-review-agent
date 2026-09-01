import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as core from '@actions/core'
import { createGhGet } from './gh'
import { createReviewPublisher } from './publisher'
import {
  resolveLlmConfig,
  runReviewPipeline,
  type PipelinePaths,
} from './pipeline'
import { commandMatches } from '../inputs'
import { extractUserMessage } from './prompt'

interface CommentPayload {
  action?: string
  issue?: { number?: number; pull_request?: unknown }
  comment?: { body?: string; user?: { login?: string; id?: number } }
  repository?: { owner?: { login?: string }; name?: string }
}

export async function run(overrides: {
  env?: Record<string, string | undefined>
  payload?: unknown
  inputs?: Record<string, string | undefined>
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

  const body = p.comment.body ?? ''
  const command = overrides.inputs?.command ?? '/review'
  if (!commandMatches(body, command)) {
    core.setOutput('review-published', 'false')
    core.setOutput('reason', 'COMMAND_MISMATCH')
    return
  }

  const inputs = {
    llmProvider: overrides.inputs?.['llm-provider'] ?? core.getInput('llm-provider'),
    llmApiKey: overrides.inputs?.['llm-api-key'] ?? core.getInput('llm-api-key'),
    llmBaseUrl: overrides.inputs?.['llm-base-url'] ?? core.getInput('llm-base-url'),
    llmModel: overrides.inputs?.['llm-model'] ?? core.getInput('llm-model'),
    githubToken: overrides.inputs?.['github-token'] ?? core.getInput('github-token'),
    timeoutMinutes: Number(overrides.inputs?.['review-timeout-minutes'] ?? (core.getInput('review-timeout-minutes') || '15')),
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

  const actionRoot = overrides.env === undefined ? path.resolve(__dirname, '..') : env.PR_REVIEW_ACTION_ROOT ?? '.'
  const workDir = path.join(env.RUNNER_TEMP ?? env.PR_REVIEW_WORKDIR ?? '.', 'pr-review-artifacts')

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
      piCliPath: path.join(actionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      extensionPath: path.join(actionRoot, 'pi', 'review-extension.ts'),
      systemPromptPath: path.join(actionRoot, 'prompts', 'review-system.md'),
      env,
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
  core.summary.addRaw(
    `## PR Review pipeline\n\n| field | value |\n| --- | --- |\n` +
      `| decision | ${result.reason} |\n| findings | ${result.findingsCount} |\n` +
      `| artifacts | ${result.artifactPath} |\n`,
  ).write()
}

async function envSpawn(
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: process.cwd() })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
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

