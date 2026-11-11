import { describe, expect, test } from 'bun:test'

import { Held } from '../src/health/held.ts'

describe('CPU held over time, per run', () => {
  test('the streak runs back from the newest sample while it stays at or above the rule', () => {
    const held = new Held()
    held.see([{ pid: 1, word: 'tsc', pcpu: 200 }], 0)
    held.see([{ pid: 1, word: 'tsc', pcpu: 30 }], 5_000)
    held.see([{ pid: 1, word: 'tsc', pcpu: 120 }], 10_000)
    held.see([{ pid: 1, word: 'tsc', pcpu: 90 }], 25_000)
    expect(held.streak(1, 80)).toEqual({ cpu: 90, seconds: 15 })
    expect(held.streak(1, 20)).toEqual({ cpu: 30, seconds: 25 })
    expect(held.streak(1, 100)).toEqual({ cpu: 90, seconds: 0 })
  })

  test('a run that ended, or a pid that is now another program, starts over', () => {
    const held = new Held()
    held.see([{ pid: 1, word: 'tsc', pcpu: 200 }], 0)
    held.see([{ pid: 1, word: 'vitest', pcpu: 200 }], 5_000)
    expect(held.streak(1, 80).seconds).toBe(0)
    held.see([], 10_000)
    expect(held.streak(1, 80)).toEqual({ cpu: 0, seconds: 0 })
  })
})
