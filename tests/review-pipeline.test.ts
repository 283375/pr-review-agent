import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nativeProviderKeyEnv,
  redactInFile,
  renderPiEvent,
  resolveLlmConfig,
  runReviewPipeline,
  writePiConfigDir,
  type PipelineDeps,
  type SpawnFn,
} from '../src/review/pipeline'
import { buildInitialPrompt, extractUserMessage } from '../src/review/prompt'
import { collectPrMetadata } from '../src/review/metadata'
import type { GhGet } from '../src/review/gh'
import type { ReviewOutput } from '../src/review/schema'

describe('resolveLlmConfig', () => {
  const full = {
    SV_PR_REVIEW_AGENT_PROVIDER: 'gateway',
    SV_PR_REVIEW_AGENT_API_KEY: 'sk-env',
    SV_PR_REVIEW_AGENT_URL: 'https://gw.example.com/v1',
    SV_PR_REVIEW_AGENT_MODEL: 'review-model',
  }

  it('resolves gateway mode from environment (org→repo fallback already applied by GitHub)', () => {
    expect(resolveLlmConfig({}, full)).toEqual({
      provider: 'gateway',
      apiKey: 'sk-env',
      baseUrl: 'https://gw.example.com/v1',
      model: 'review-model',
    })
  })

  it('action inputs win over the environment', () => {
    expect(
      resolveLlmConfig(
        { llmApiKey: 'sk-input', llmBaseUrl: 'https://input.example.com', llmModel: 'm2' },
        full,
      ),
    ).toEqual({
      provider: 'gateway',
      apiKey: 'sk-input',
      baseUrl: 'https://input.example.com',
      model: 'm2',
    })
  })

  it('gateway mode fails naming every missing variable', () => {
    const err = (() => {
      try {
        resolveLlmConfig({}, {})
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })()
    expect(err).toMatch(/Missing LLM configuration/)
    for (const name of ['SV_PR_REVIEW_AGENT_API_KEY', 'SV_PR_REVIEW_AGENT_URL', 'SV_PR_REVIEW_AGENT_MODEL']) {
      expect(err).toContain(name)
    }
  })

  it('native provider mode needs no base URL', () => {
    expect(
      resolveLlmConfig({ llmProvider: 'deepseek', llmApiKey: 'sk', llmModel: 'deepseek-v4-flash' }, {}),
    ).toEqual({ provider: 'deepseek', apiKey: 'sk', model: 'deepseek-v4-flash' })
  })

  it('native provider mode can come entirely from the environment', () => {
    expect(
      resolveLlmConfig({}, {
        SV_PR_REVIEW_AGENT_PROVIDER: 'deepseek',
        SV_PR_REVIEW_AGENT_API_KEY: 'sk',
        SV_PR_REVIEW_AGENT_MODEL: 'deepseek-v4-flash',
      }),
    ).toEqual({ provider: 'deepseek', apiKey: 'sk', model: 'deepseek-v4-flash' })
  })

  it('native provider mode still requires key and model', () => {
    expect(() => resolveLlmConfig({ llmProvider: 'deepseek' }, {})).toThrow(
      /SV_PR_REVIEW_AGENT_API_KEY, SV_PR_REVIEW_AGENT_MODEL/,
    )
  })

  it('maps native providers to their key environment variable', () => {
    expect(nativeProviderKeyEnv('deepseek')).toBe('DEEPSEEK_API_KEY')
    expect(nativeProviderKeyEnv('custom-provider')).toBe('CUSTOM_PROVIDER_API_KEY')
  })
})

describe('writePiConfigDir', () => {
  it('writes an isolated gateway provider with fail-closed project trust', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pra-cfg-'))
    try {
      writePiConfigDir(dir, { provider: 'gateway', apiKey: 'sk', baseUrl: 'https://gw/v1', model: 'm' })
      const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
      expect(models.providers.gateway).toMatchObject({
        baseUrl: 'https://gw/v1',
        api: 'openai-completions',
        apiKey: '$PR_REVIEW_LLM_KEY',
        models: [{ id: 'm' }],
      })
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
        defaultProjectTrust: 'never',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('native providers get only the trust settings, no models.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pra-cfg-'))
    try {
      writePiConfigDir(dir, { provider: 'deepseek', apiKey: 'sk', model: 'm' })
      expect(existsSync(join(dir, 'models.json'))).toBe(false)
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
        defaultProjectTrust: 'never',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildInitialPrompt', () => {
  const meta = {
    repository: { owner: 'acme', name: 'repo' },
    prNumber: 7,
    title: 'Fix the widget',
    body: 'Fixes #123',
    author: { login: 'alice', id: 11 },
    baseRef: 'main',
    baseSha: 'abc',
    headRef: 'fix',
    headSha: 'def',
    changedFiles: ['src/a.ts'],
    commentCount: 2,
  }

  it('separates untrusted metadata from the USER_REQUEST instruction channel', () => {
    const prompt = buildInitialPrompt(meta, {
      trigger: { login: 'boss', id: 1 },
      userMessage: 'focus on the locking',
    })
    expect(prompt).toContain('----- PR_METADATA -----')
    expect(prompt).toContain('----- USER_REQUEST -----')
    expect(prompt).toContain('issued_by: boss (id 1)')
    expect(prompt).toContain('focus on the locking')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('Fixes #123') // PR body is metadata, untrusted
  })

  it('extracts the message after the command prefix', () => {
    expect(extractUserMessage('/review focus: security', '/review')).toBe('focus: security')
    expect(extractUserMessage('/review', '/review')).toBe('')
    expect(extractUserMessage('/reviews-only', '/review')).toBe('')
  })
})

describe('collectPrMetadata', () => {
  const responses: Record<string, unknown> = {
    '/repos/acme/repo/pulls/7': {
      title: 'T', body: 'B', user: { login: 'alice', id: 11 },
      base: { ref: 'main', sha: 'abc' }, head: { ref: 'fix', sha: 'def' },
      comments: 3, review_comments: 1,
    },
    '/repos/acme/repo/pulls/7/files?per_page=100&page=1': [
      { filename: 'src/a.ts' }, { filename: '../evil' }, { filename: 'src/b.ts' },
    ],
  }
  const get: GhGet = async (pathname) => ({ status: 200, json: responses[pathname] ?? null })

  it('collects file list and comment counts from read-only GETs', async () => {
    const meta = await collectPrMetadata(get, { owner: 'acme', name: 'repo' }, 7)
    expect(meta.changedFiles).toEqual(['src/a.ts', '../evil', 'src/b.ts'])
    expect(meta.commentCount).toBe(4)
    expect(meta.headSha).toBe('def')
  })
})

function tmpPaths() {
  const workDir = mkdtempSync(join(tmpdir(), 'pra-run-'))
  return {
    workDir,
    sessionDir: join(workDir, 'sessions'),
    stagePath: join(workDir, 'stage.json'),
  }
}

const GOOD_REVIEW: ReviewOutput = {
  summary: 'Sound change; one concern.',
  findings: [
    {
      file: 'src/a.ts',
      startLine: 3,
      severity: 'concern',
      category: 'reliability',
      title: 'unchecked null',
      body: 'The value can be null here; see the caller in lib/util.py.',
    },
  ],
}

describe('runReviewPipeline', () => {
  const get: GhGet = async (pathname) => {
    if (pathname.endsWith('/pulls/7')) {
      return {
        status: 200,
        json: {
          title: 'T', body: '', user: { login: 'alice', id: 11 },
          base: { ref: 'main', sha: 'abc' }, head: { ref: 'fix', sha: 'def' },
          comments: 0, review_comments: 0,
        },
      }
    }
    if (pathname.endsWith('/files?per_page=100&page=1')) return { status: 200, json: [{ filename: 'src/a.ts' }] }
    return { status: 200, json: [] }
  }
  const published: Array<Record<string, unknown>> = []
  const publisher = {
    publishReview: async (params: { owner: string; repo: string; prNumber: number; review: ReviewOutput }) => {
      published.push(params)
      return { id: 1, htmlUrl: 'https://example.com/r/1' }
    },
  }
  const params = {
    repository: { owner: 'acme', name: 'repo' },
    prNumber: 7,
    trigger: { login: 'boss', id: 1 },
    userMessage: '',
    llm: { provider: 'gateway', apiKey: 'sk-secret', baseUrl: 'https://gw/v1', model: 'm' },
    githubToken: 'gh-token-secret',
    timeoutMinutes: 1,
  }

  beforeEach(() => {
    published.length = 0
  })

  function fakeSpawn(stageOnExit: boolean, exitCode = 0): SpawnFn & { calls: unknown[] } {
    const calls: unknown[] = []
    const fn: SpawnFn & { calls: unknown[] } = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      if (args[0] === '--mode') {
        const stage = opts.env.PR_REVIEW_STAGE_PATH
        if (stageOnExit && stage) writeFileSync(stage, JSON.stringify(GOOD_REVIEW))
        return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'boom', timedOut: false }
      }
      // html export
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    fn.calls = calls
    return fn
  }

  function makeDeps(paths: ReturnType<typeof tmpPaths>, spawn: SpawnFn): PipelineDeps {
    const systemPromptPath = join(paths.workDir, 'system.md')
    writeFileSync(systemPromptPath, 'You are the PR Review Agent.')
    return {
      get,
      publisher,
      spawn,
      paths,
      piCliPath: '/usr/bin/true',
      extensionPath: '/ext.ts',
      systemPromptPath,
      env: { GITHUB_API_URL: 'https://api.github.com' },
    }
  }

  it('publishes the staged review and redacts artifacts', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(true)
    const result = await runReviewPipeline(makeDeps(paths, spawn), params)

    expect(result).toMatchObject({ published: true, reason: 'PUBLISHED', findingsCount: 1 })
    expect(published[0]).toMatchObject({ owner: 'acme', repo: 'repo', prNumber: 7 })

    const sessionFile = join(paths.sessionDir, 'session.jsonl')
    expect(existsSync(sessionFile)).toBe(false) // fake spawn creates no session file

    // pi invocation pins the safety flags
    const piCall = spawn.calls[0] as { args: string[]; opts: { env: Record<string, string> } }
    const args = piCall.args.join(' ')
    expect(args).toContain('--no-context-files')
    expect(args).toContain('--no-approve')
    expect(args).toContain('--exclude-tools edit,write,grep,find,ls,powershell')
    // --no-extensions only disables discovery; the review extension must be
    // loaded explicitly or submit_review and the sandbox never exist.
    expect(args).toContain('-e /ext.ts')
    expect(args).toContain('--provider gateway')
    expect(piCall.opts.env.PR_REVIEW_LLM_KEY).toBe('sk-secret')
    expect(piCall.opts.env.PI_CODING_AGENT_DIR).toMatch(/pi-config$/)
    const cfgDir = piCall.opts.env.PI_CODING_AGENT_DIR as string
    expect(readFileSync(join(cfgDir, 'settings.json'), 'utf8')).toContain('never')
  })

  it('native provider mode: built-in registry, key via well-known env, no models.json', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(true)
    const deps = makeDeps(paths, spawn)
    const result = await runReviewPipeline(deps, {
      ...params,
      llm: { provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-v4-flash-vision-exp' },
    })

    expect(result).toMatchObject({ published: true, reason: 'PUBLISHED' })
    const piCall = spawn.calls[0] as { args: string[]; opts: { env: Record<string, string> } }
    expect(piCall.args.join(' ')).toContain('--provider deepseek')
    expect(piCall.opts.env.DEEPSEEK_API_KEY).toBe('sk-ds')
    expect(piCall.opts.env.PR_REVIEW_LLM_KEY).toBeUndefined()
    const cfgDir = piCall.opts.env.PI_CODING_AGENT_DIR as string
    expect(existsSync(join(cfgDir, 'models.json'))).toBe(false)
  })

  it('reports NO_OUTPUT without publishing when nothing was staged', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(false)
    const result = await runReviewPipeline(makeDeps(paths, spawn), params)
    expect(result).toMatchObject({ published: false, reason: 'NO_OUTPUT' })
    expect(published).toHaveLength(0)
  })

  it('reports PI_FAILED with stderr tail on nonzero exit', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(false, 3)
    const result = await runReviewPipeline(makeDeps(paths, spawn), params)
    expect(result).toMatchObject({ published: false, reason: 'PI_FAILED' })
    expect(result.details?.[0]).toContain('exit code: 3')
    expect(result.details?.some((d) => d.includes('boom'))).toBe(true)
  })

  it('skips the fallback publish when the agent already published (published.json)', async () => {
    const paths = tmpPaths()
    // A session that published also left a staged review behind.
    const spawn = fakeSpawn(true)
    writeFileSync(
      join(paths.workDir, 'published.json'),
      JSON.stringify({ id: 42, htmlUrl: 'https://example.com/r/42' }),
    )
    const result = await runReviewPipeline(makeDeps(paths, spawn), params)

    expect(result).toMatchObject({
      published: true,
      reason: 'PUBLISHED_BY_AGENT',
      reviewUrl: 'https://example.com/r/42',
      findingsCount: 1,
    })
    expect(published).toHaveLength(0)
  })

  it('captures a publish failure as PUBLISH_FAILED instead of throwing', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(true)
    const deps = makeDeps(paths, spawn)
    // Replace (not mutate) the shared publisher: other tests reuse it.
    deps.publisher = {
      publishReview: async () => {
        throw new Error('GitHub API 422 while submitting review: Line could not be resolved')
      },
    }
    const result = await runReviewPipeline(deps, params)

    expect(result).toMatchObject({ published: false, reason: 'PUBLISH_FAILED' })
    expect(result.details?.[0]).toContain('Line could not be resolved')
  })

  it('re-validates the staged review against the changed-file set', async () => {
    const paths = tmpPaths()
    const spawn = fakeSpawn(true)
    const deps = makeDeps(paths, spawn)
    const result = await runReviewPipeline(deps, params)
    expect(result.published).toBe(true) // src/a.ts is a changed file; passes
  })
})

describe('redactInFile', () => {
  it('replaces secret values everywhere in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pra-redact-'))
    try {
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, 'Authorization: Bearer sk-secret1\ntoken gh-token-secret\n')
      redactInFile(file, ['sk-secret1', 'gh-token-secret'])
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('[REDACTED]')
      expect(content).not.toContain('sk-secret1')
      expect(content).not.toContain('gh-token-secret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderPiEvent', () => {
  it('renders tool executions; failures get a marker', () => {
    const start = renderPiEvent(
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'git diff' } }),
    )
    expect(start).toContain('▶ bash')
    expect(start).toContain('git diff')

    const failed = renderPiEvent(
      JSON.stringify({ type: 'tool_execution_end', toolName: 'bash', result: 'boom', isError: true }),
    )
    expect(failed).toContain('✗ bash')
    expect(failed).toContain('boom')

    const ok = renderPiEvent(
      JSON.stringify({ type: 'tool_execution_end', toolName: 'bash', result: 'fine', isError: false }),
    )
    expect(ok).toBeUndefined()
  })

  it('previews plain assistant text but skips toolCall messages', () => {
    const text = renderPiEvent(
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } }),
    )
    expect(text).toContain('💬 hello world')

    const toolCall = renderPiEvent(
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1' }, { type: 'text', text: 'running…' }] } }),
    )
    expect(toolCall).toBeUndefined()
  })

  it('drops token-delta and lifecycle events; previews long text; passes non-JSON through', () => {
    expect(renderPiEvent(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }))).toBeUndefined()
    expect(renderPiEvent(JSON.stringify({ type: 'agent_end', messages: [] }))).toBeUndefined()
    expect(renderPiEvent(JSON.stringify({ type: 'turn_start' }))).toBeUndefined()

    const long = renderPiEvent(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(500) }] } }))
    expect(long).toMatch(/…$/)
    expect(long!.length).toBeLessThan(260)

    expect(renderPiEvent('Warning: something odd')).toContain('Warning')
    expect(renderPiEvent('   ')).toBeUndefined()
  })
})
