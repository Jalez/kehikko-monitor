import { describe, expect, test } from 'bun:test'

import { problemOf, readOnce } from '../src/wire/use-traffic.ts'
import { call } from './fixtures.ts'

const answer = (calls: ReturnType<typeof call>[], started = 1, newest = calls.at(-1)?.seq ?? 0) => ({ calls, newest, oldest: calls[0]?.seq ?? 1, kept: 5000, started, budgets: [], processes: null })

describe('reading the record', () => {
  test('asks after the last row held, with sampling, and appends only what is new', async () => {
    const asked: unknown[] = []
    const first = call({ at: 1000 })
    const second = call({ at: 2000 })
    const ask = async (_method: string, params?: Record<string, unknown>) => (asked.push(params), answer([first, second]))
    const one = await readOnce(ask, { since: 0, started: null }, [], 3000)
    expect(one.traffic.calls).toEqual([first, second])
    expect(one.cursor).toEqual({ since: second.seq, started: 1 })
    expect(asked[0]).toEqual({ since: 0, limit: 5000, sample: true })
    const two = await readOnce(async () => answer([second]), one.cursor, one.traffic.calls, 3000)
    expect(two.traffic.calls).toEqual([first, second])
  })

  test('a host that restarted numbers again: its rows are read from the start, and what was held is kept', async () => {
    const before = [call({ at: 1000 })]
    const fresh = { ...call({ at: 2000 }), seq: 1 }
    const read = await readOnce(async () => answer([fresh], 99), { since: 500, started: 1 }, before, 3000)
    expect(read.traffic.calls).toEqual([...before, fresh])
  })

  test('an answer of another shape is a sentence; a refusal is said in the person’s words', async () => {
    await expect(readOnce(async () => ({ nope: true }), { since: 0, started: null }, [], 0)).rejects.toThrow('cannot read')
    expect(problemOf(new Error('This host speaks 25 methods and that is not one of them.'))).toContain('Update Kehikot')
    expect(problemOf(new Error('does not ask for traffic:read'))).toContain('Update Monitor')
  })
})
