import fs from 'node:fs'
import path from 'node:path'
import type { GhGet } from './gh'
import { collectPrMetadata, type PrMetadata } from './metadata'
import { buildInitialPrompt, type TaskContext } from './prompt'
import { validateReviewOutput } from './validate'
import type { ReviewOutput } from './schema'
import type { ReviewPublisher } from './publisher'

export interface LlmConfig {
  /** `gateway` (models.json, any OpenAI-compatible endpoint) or a native pi provider id (e.g. `deepseek`). */
  provider: string
  apiKey: string
  /** Gateway endpoint; unused for native providers (their baseUrl is built in). */
  baseUrl?: string
  model: string
}

const NATIVE_PROVIDER_KEY_ENV: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/**
 * LLM configuration chain (least to most specific):
 * environment `SV_PR_REVIEW_AGENT_{PROVIDER,URL,MODEL,API_KEY}` (which GitHub
 * resolves as organization secret falling back to repository secret) →
 * explicit action inputs.
 *
 * Two modes:
 * - `provider: gateway` (default) — any OpenAI-compatible endpoint; requires
 *   API key + base URL + model. The runner registers it via models.json.
 * - `provider: <native id>` (e.g. `deepseek`) — pi's built-in provider with
 *   its built-in model registry and compat settings; requires API key +
 *   model, base URL is unused.
 */
export function resolveLlmConfig(
  inputs: { llmProvider?: string; llmApiKey?: string; llmBaseUrl?: string; llmModel?: string },
  env: Record<string, string | undefined>,
): LlmConfig {
  const missing: string[] = []
  const pick = (input: string | undefined, envName: string): string => {
    const value = input ?? env[envName] ?? ''
    if (value === '') missing.push(envName)
    return value
  }
  const provider = inputs.llmProvider ?? env.SV_PR_REVIEW_AGENT_PROVIDER ?? 'gateway'
  const apiKey = pick(inputs.llmApiKey, 'SV_PR_REVIEW_AGENT_API_KEY')
  const model = pick(inputs.llmModel, 'SV_PR_REVIEW_AGENT_MODEL')

  if (provider === 'gateway') {
    const baseUrl = pick(inputs.llmBaseUrl, 'SV_PR_REVIEW_AGENT_URL')
    if (missing.length > 0) {
      throw new Error(
        `Missing LLM configuration: ${missing.join(', ')}. ` +
          'Provide action inputs or repository/organization secrets; the action input wins.',
      )
    }
    return { provider, apiKey, baseUrl, model }
  }

  // Native provider: baseUrl comes from pi's registry, not from config.
  const baseUrl = inputs.llmBaseUrl ?? env.SV_PR_REVIEW_AGENT_URL
  if (missing.length > 0) {
    throw new Error(
      `Missing LLM configuration: ${missing.join(', ')}. ` +
        'Provide action inputs or repository/organization secrets; the action input wins.',
    )
  }
  return {
    provider,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
  }
}

/** Environment variable the native provider reads its key from. */
export function nativeProviderKeyEnv(provider: string): string {
  return (
    NATIVE_PROVIDER_KEY_ENV[provider] ??
    `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
  )
}

export interface PipelinePaths {
  /** Artifacts root (session + staged review + exported HTML). */
  workDir: string
  sessionDir: string
  stagePath: string
}

export interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number },
) => Promise<SpawnResult>

export interface PipelineDeps {
  get: GhGet
  publisher: ReviewPublisher
  spawn: SpawnFn
  paths: PipelinePaths
  /** Absolute paths into the action directory. */
  piCliPath: string
  extensionPath: string
  systemPromptPath: string
  env: Record<string, string | undefined>
  now?: () => string
}

export interface PipelineParams {
  repository: { owner: string; name: string }
  prNumber: number
  trigger: TaskContext['trigger']
  userMessage: string
  llm: LlmConfig
  githubToken: string
  timeoutMinutes: number
}

export interface ReviewRunResult {
  published: boolean
  reason: 'PUBLISHED' | 'NO_OUTPUT' | 'INVALID_STAGE' | 'PI_FAILED'
  reviewUrl?: string
  findingsCount: number
  artifactPath: string
  details?: string[]
}

/** Isolated pi config dir: fail-closed trust always; gateway provider registration for the gateway mode. */
export function writePiConfigDir(
  configDir: string,
  llm: LlmConfig,
  write: (file: string, content: string) => void = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  },
): void {
  if (llm.provider === 'gateway') {
    write(
      path.join(configDir, 'models.json'),
      JSON.stringify(
        {
          providers: {
            gateway: {
              baseUrl: llm.baseUrl,
              api: 'openai-completions',
              apiKey: '$PR_REVIEW_LLM_KEY',
              models: [{ id: llm.model }],
            },
          },
        },
        null,
        2,
      ),
    )
  }
  write(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ defaultProjectTrust: 'never' }, null, 2),
  )
}

export function redactInFile(file: string, secrets: string[]): void {
  let content = fs.readFileSync(file, 'utf8')
  for (const secret of secrets) {
    if (secret === '') continue
    content = content.split(secret).join('[REDACTED]')
  }
  fs.writeFileSync(file, content)
}

function latestSessionFile(sessionDir: string): string | undefined {
  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(sessionDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0]
}

export async function runReviewPipeline(
  deps: PipelineDeps,
  params: PipelineParams,
): Promise<ReviewRunResult> {
  const { workDir, sessionDir, stagePath } = deps.paths
  const secrets = [params.llm.apiKey, params.githubToken]
  const result: ReviewRunResult = {
    published: false,
    reason: 'NO_OUTPUT',
    findingsCount: 0,
    artifactPath: workDir,
  }

  fs.mkdirSync(sessionDir, { recursive: true })
  if (fs.existsSync(stagePath)) fs.rmSync(stagePath)

  const meta: PrMetadata = await collectPrMetadata(deps.get, params.repository, params.prNumber)
  const initialPrompt = buildInitialPrompt(meta, {
    trigger: params.trigger,
    userMessage: params.userMessage,
  })
  const systemPrompt = fs.readFileSync(deps.systemPromptPath, 'utf8')

  const configDir = path.join(workDir, 'pi-config')
  writePiConfigDir(configDir, params.llm)

  const piEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(deps.env)) {
    if (typeof v === 'string') piEnv[k] = v
  }
  Object.assign(piEnv, {
    PI_CODING_AGENT_DIR: configDir,
    PR_REVIEW_GITHUB_TOKEN: params.githubToken,
    PR_REVIEW_REPOSITORY: `${params.repository.owner}/${params.repository.name}`,
    PR_REVIEW_PR_NUMBER: String(params.prNumber),
    PR_REVIEW_HEAD_SHA: meta.headSha,
    PR_REVIEW_CHANGED_FILES: meta.changedFiles.join('\n'),
    PR_REVIEW_STAGE_PATH: stagePath,
    PR_REVIEW_ALLOWED_HOSTS: '',
  })

  // Key delivery: gateway reads $PR_REVIEW_LLM_KEY via models.json; native
  // providers read their own well-known variable (e.g. DEEPSEEK_API_KEY).
  if (params.llm.provider === 'gateway') {
    piEnv.PR_REVIEW_LLM_KEY = params.llm.apiKey
  } else {
    piEnv[nativeProviderKeyEnv(params.llm.provider)] = params.llm.apiKey
  }

  const modelArgs =
    params.llm.provider === 'gateway'
      ? ['--provider', 'gateway', '--model', params.llm.model]
      : ['--provider', params.llm.provider, '--model', params.llm.model]

  const piResult = await deps.spawn(
    deps.piCliPath,
    [
      '--mode', 'json',
      '--session-dir', sessionDir,
      '--no-context-files',
      '--no-approve',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-extensions',
      '--exclude-tools', 'edit,write,grep,find,ls,powershell',
      ...modelArgs,
      '--system-prompt', systemPrompt,
      initialPrompt,
    ],
    { env: piEnv, timeoutMs: params.timeoutMinutes * 60_000 },
  )

  // Redact and export regardless of review outcome — artifacts are for
  // debugging, including failed runs.
  const sessionFile = fs.existsSync(sessionDir) ? latestSessionFile(sessionDir) : undefined
  if (sessionFile) {
    redactInFile(sessionFile, secrets)
    const htmlPath = path.join(workDir, 'review-session.html')
    const exportResult = await deps.spawn(
      deps.piCliPath,
      ['--export', sessionFile, htmlPath],
      { env: { ...piEnv, PI_CODING_AGENT_DIR: configDir }, timeoutMs: 60_000 },
    )
    if (exportResult.exitCode === 0 && fs.existsSync(htmlPath)) redactInFile(htmlPath, secrets)
  }

  if (!fs.existsSync(stagePath)) {
    result.reason = piResult.exitCode === 0 ? 'NO_OUTPUT' : 'PI_FAILED'
    result.details = [
      `pi exit code: ${piResult.exitCode}${piResult.timedOut ? ' (timed out)' : ''}`,
      ...(piResult.stderr ? [`stderr tail: ${piResult.stderr.slice(-2000)}`] : []),
    ]
    return result
  }

  // Belt and suspenders: the extension already validated; the runner re-checks
  // because it, not the agent, is the authority on what gets published.
  const raw: unknown = JSON.parse(fs.readFileSync(stagePath, 'utf8'))
  const validation = validateReviewOutput(raw, { changedFiles: meta.changedFiles })
  if (!validation.ok) {
    result.reason = 'INVALID_STAGE'
    result.details = validation.errors
    return result
  }
  const review: ReviewOutput = validation.review

  const published = await deps.publisher.publishReview({
    owner: params.repository.owner,
    repo: params.repository.name,
    prNumber: params.prNumber,
    review,
  })

  return {
    published: true,
    reason: 'PUBLISHED',
    reviewUrl: published.htmlUrl,
    findingsCount: review.findings.length,
    artifactPath: workDir,
  }
}
