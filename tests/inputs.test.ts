import { describe, expect, it } from 'vitest'
import { commandMatches, InputError, parseAllowedActors } from '../src/inputs'

describe('parseAllowedActors', () => {
  it('parses placeholders case-insensitively and normalizes to upper case', () => {
    expect(parseAllowedActors('__owner__')).toEqual([{ kind: 'placeholder', name: '__OWNER__' }])
    expect(parseAllowedActors('__Member__, __CONTRIBUTOR__')).toEqual([
      { kind: 'placeholder', name: '__MEMBER__' },
      { kind: 'placeholder', name: '__CONTRIBUTOR__' },
    ])
  })

  it('parses numeric user IDs canonically', () => {
    expect(parseAllowedActors('12345678')).toEqual([{ kind: 'user-id', id: 12345678 }])
  })

  it('splits on whitespace, commas and semicolons', () => {
    expect(parseAllowedActors('__OWNER__; 99999999\n__COLLABORATOR__,11111111')).toEqual([
      { kind: 'placeholder', name: '__OWNER__' },
      { kind: 'user-id', id: 99999999 },
      { kind: 'placeholder', name: '__COLLABORATOR__' },
      { kind: 'user-id', id: 11111111 },
    ])
  })

  it('rejects an empty policy loudly', () => {
    expect(() => parseAllowedActors('  ,  ')).toThrow(InputError)
  })

  it('rejects logins — IDs are canonical, logins are renamable', () => {
    expect(() => parseAllowedActors('__OWNER__,someone')).toThrow(/numeric GitHub user ID/)
  })

  it('rejects mixed garbage tokens', () => {
    expect(() => parseAllowedActors('__OWNER__, 0x123')).toThrow(/Invalid allowed-actors token/)
  })
})

describe('commandMatches', () => {
  it('matches the command case-insensitively at the start', () => {
    expect(commandMatches('/review', '/review')).toBe(true)
    expect(commandMatches('  /REVIEW please  ', '/review')).toBe(true)
    expect(commandMatches('/review focus: security', '/review')).toBe(true)
  })

  it('does not match partial command prefixes', () => {
    expect(commandMatches('/reviews-only', '/review')).toBe(false)
    expect(commandMatches('please /review', '/review')).toBe(false)
  })

  it('supports trailing newlines between command and args', () => {
    expect(commandMatches('/review\nfocus: security', '/review')).toBe(true)
  })
})
