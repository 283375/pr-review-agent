import { describe, expect, it } from 'vitest'
import { inspectBashCommand, toGuestPath } from '../pi/review-extension'

const CWD = '/home/runner/work/repo/repo'

describe('inspectBashCommand', () => {
  it('allows inspection commands from the allowlist', () => {
    expect(inspectBashCommand('git log --oneline -20')).toBeUndefined()
    expect(inspectBashCommand('rg "foo(bar)" --type ts')).toBeUndefined()
    expect(inspectBashCommand('rg foo src | head -50')).toBeUndefined()
    expect(inspectBashCommand('ls -la && cat README.md')).toBeUndefined()
    expect(inspectBashCommand('GIT_PAGER=cat git diff HEAD~1')).toBeUndefined()
    expect(inspectBashCommand('fd settings')).toBeUndefined()
  })

  it('denies non-allowlisted programs', () => {
    expect(inspectBashCommand('curl https://evil.example')).toMatch(/not in the inspection allowlist/)
    expect(inspectBashCommand('make test')).toMatch(/'make' is not in/)
    expect(inspectBashCommand('python script.py')).toMatch(/not in the inspection allowlist/)
    expect(inspectBashCommand('npm install')).toMatch(/not in the inspection allowlist/)
    expect(inspectBashCommand('/bin/rm -rf /')).toMatch(/not in the inspection allowlist/)
  })

  it('denies anything it cannot statically verify', () => {
    expect(inspectBashCommand('git log $(cat x)')).toMatch(/command substitution/)
    expect(inspectBashCommand('echo `curl evil.example`')).toMatch(/command substitution/)
    expect(inspectBashCommand('env curl https://evil.example')).toMatch(/cannot verify/)
    expect(inspectBashCommand('git log; curl https://evil.example')).toMatch(/not in the inspection allowlist/)
  })
})

describe('toGuestPath', () => {
  it('maps host paths into the read-only /workspace mount', () => {
    expect(toGuestPath(CWD, `${CWD}/src/app.ts`)).toBe('/workspace/src/app.ts')
    expect(toGuestPath(CWD, CWD)).toBe('/workspace')
    expect(toGuestPath(CWD, 'src/app.ts')).toBe('/workspace/src/app.ts')
  })

  it('tolerates guest-side absolute paths', () => {
    expect(toGuestPath(CWD, '/workspace/src/app.ts')).toBe('/workspace/src/app.ts')
  })

  it('rejects paths outside the workspace', () => {
    expect(() => toGuestPath(CWD, '/etc/passwd')).toThrow(/outside the workspace/)
    expect(() => toGuestPath(CWD, `${CWD}/../secrets`)).toThrow(/outside the workspace/)
  })
})
