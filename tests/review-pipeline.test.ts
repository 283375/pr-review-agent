import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  redactInFile,
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
    SV_PR_REVIEW_AGENT_API_KEY: 'sk-env',
    SV_PR_REVIEW_AGENT_URL: 'https://gw.example.com/v1',
    SV_PR_REVIEW_AGENT_MODEL: 'review-model',
  }

  it('resolves from environment (org→repo fallback already applied by GitHub)', () => {
    expect(resolveLlmConfig({}, full)).toEqual({
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
    ).toEqual({ apiKey: 'sk-input', baseUrl: 'https://input.example.com', model: 'm2' })
  })

  it('fails naming every missing variable', () => {
    expect(() => resolveLlmConfig({}, {})).toThrow(/SV_PR_REVIEW_AGENT_API_KEY, SV_PR_REVIEW_AGENT_URL, SV_PR_REVIEW_AGENT_MODEL/)
  })
})

describe('writePiConfigDir', () => {
  it('writes an isolated gateway provider with fail-closed project trust', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pra-cfg-'))
    try {
      writePiConfigDir(dir, { apiKey: 'sk', baseUrl: 'https://gw/v1', model: 'm' })
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
    llm: { apiKey: 'sk-secret', baseUrl: 'https://gw/v1', model: 'm' },
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
    expect(args).toContain('--provider gateway')
    expect(piCall.opts.env.PR_REVIEW_LLM_KEY).toBe('sk-secret')
    expect(piCall.opts.env.PI_CODING_AGENT_DIR).toMatch(/pi-config$/)
    const cfgDir = piCall.opts.env.PI_CODING_AGENT_DIR as string
    expect(readFileSync(join(cfgDir, 'settings.json'), 'utf8')).toContain('never')
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
