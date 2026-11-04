import { describe, expect, test } from 'bun:test'

import { footerItems } from '../src/footer.ts'
import { headerItems } from '../src/header.ts'
import type { CallerSummary } from '../src/traffic/model.ts'

const row = (over: Partial<CallerSummary>): CallerSummary => ({ by: 'kehikot.diff', name: 'Diff', calls: 10, perMinute: 2, bytes: 0, free: 10, freeRate: 1, unlabelled: 0, seen: 0, ...over })
const base = { paused: false, rows: [] as CallerSummary[], repeating: 0, budgets: [], gap: false, problem: null }

describe('the footer', () => {
  test('live, the rate and the callers, and Clear beside them', () => {
    const items = footerItems({ ...base, rows: [row({}), row({ by: 'kehikot.review', perMinute: 1.5 })] })
    expect(items.find((i) => i.id === 'live')).toMatchObject({ text: 'Live' })
    expect(items.find((i) => i.id === 'rate')).toMatchObject({ text: '3.5/min · 2 callers' })
    expect(items.at(-1)).toMatchObject({ kind: 'run', id: 'clear', align: 'end' })
  })

  test('paused and repeats warn; a limit is a meter; a limit that paused calls is critical', () => {
    const items = footerItems({
      ...base,
      paused: true,
      repeating: 3,
      budgets: [
        { key: 'a', text: 'Paused: GitHub said to wait.', paused: true },
        { key: 'b', text: 'share', meter: { used: 4500, limit: 5000, label: 'Kehikot’s share of GitHub: 4500 of 5000 used' } },
      ],
    })
    expect(items.find((i) => i.id === 'live')).toMatchObject({ text: 'Paused', level: 'warn' })
    expect(items.find((i) => i.id === 'repeats')).toMatchObject({ text: '3 repeating', level: 'warn' })
    expect(items.find((i) => i.id === 'stopped')).toMatchObject({ level: 'critical' })
    expect(items.find((i) => i.id === 'limit')).toMatchObject({ kind: 'meter', value: 0.9, text: '4500 / 5000', level: 'warn' })
  })

  test('a problem wins over calls missed', () => {
    expect(footerItems({ ...base, gap: true }).find((i) => i.id === 'gap')).toBeDefined()
    const items = footerItems({ ...base, gap: true, problem: 'Kehikot did not answer.' })
    expect(items.find((i) => i.id === 'problem')).toMatchObject({ level: 'warn' })
    expect(items.some((i) => i.id === 'gap')).toBe(false)
  })
})

describe('the header with the footer drawn', () => {
  test('Clear is the footer’s alone', () => {
    const state = { range: 5 as const, style: 'lines' as const, paused: false, caller: null, callers: [] }
    expect(headerItems({ ...state, footed: true }).some((i) => i.id === 'clear')).toBe(false)
    expect(headerItems(state).some((i) => i.id === 'clear')).toBe(true)
  })
})
