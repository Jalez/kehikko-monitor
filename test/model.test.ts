import { describe, expect, test } from 'bun:test'

import { TRAFFIC_REDACTED } from 'kehikot-module-protocol'

import { BUCKET_MS, COLOURED, HELD, OTHER, buckets, callLine, callerName, colourOrder, filtered, freeKey, held, repeats, spoken, summary } from '../src/traffic/model.ts'
import { call, polling } from './fixtures.ts'

const NOW = 1_000_000_000

describe('names and words', () => {
  test('a caller by the name a person knows it', () => {
    expect(callerName('kehikko')).toBe('Kehikot')
    expect(callerName('kehikot.kanban')).toBe('Kanban')
    expect(callerName('kehikot.reading-list')).toBe('Reading list')
    expect(callerName('')).toBe('An unknown program')
  })
  test('times and sizes', () => {
    expect(spoken(400)).toBe('under a second')
    expect(spoken(2000)).toBe('2 s')
    expect(spoken(90_000)).toBe('1.5 min')
  })
  test('a call as a line, saying when it was free and when it had no reason', () => {
    const line = callLine(call({ at: Date.UTC(2026, 9, 24, 12, 0, 1), by: 'kehikko', side: 'out', kind: 'GET', host: 'api.github.com', path: `/repos/a/b/releases?page=${TRAFFIC_REDACTED}`, status: 304, cache: 'not-modified', reason: 'GitHub releases: a/b' }))
    expect(line).toBe(`12:00:01 Kehikot called GET api.github.com/repos/a/b/releases?page=${TRAFFIC_REDACTED} → 304 (304, free) in 3 ms — GitHub releases: a/b`)
    expect(callLine(call({ at: 0 }))).toContain('— no reason given')
  })
})

describe('what the page holds', () => {
  test('new rows appended, an hour kept, at most HELD', () => {
    const old = call({ at: NOW - 61 * 60_000 })
    const kept = call({ at: NOW - 1000 })
    expect(held([old], [kept], NOW)).toEqual([kept])
    const many = Array.from({ length: HELD + 5 }, (_, i) => call({ at: NOW - i }))
    expect(held([], many, NOW)).toHaveLength(HELD)
  })
})

describe('the timeline', () => {
  test('one bucket per second for five minutes, calls per second by caller, free calls apart', () => {
    const calls = [call({ at: NOW - 500 }), call({ at: NOW - 400, cache: 'not-modified' }), call({ at: NOW - 300, by: 'kehikko' }), call({ at: NOW - 10 * 60_000 })]
    /* The last bucket is the second `now` is in. */
    const data = buckets(calls, NOW - 100, 5, ['kehikot.kanban', 'kehikko'])
    expect(data).toHaveLength((5 * 60_000) / BUCKET_MS[5])
    const last = data[data.length - 1]!
    expect(last['kehikot.kanban']).toBe(1)
    expect(last[freeKey('kehikot.kanban')]).toBe(1)
    expect(last.kehikko).toBe(1)
    expect(data.reduce((sum, bucket) => sum + (bucket['kehikot.kanban'] ?? 0), 0)).toBe(1)
  })
  test('a wider range averages per second; callers outside the colours fold into Other', () => {
    const data = buckets([call({ at: NOW - 100 }), call({ at: NOW - 200, by: 'kehikot.paper' })], NOW, 60, ['kehikot.kanban'])
    const last = data[data.length - 1]!
    expect(last['kehikot.kanban']).toBeCloseTo(1 / 15)
    expect(last[OTHER]).toBeCloseTo(1 / 15)
  })
  test('a colour follows its caller: kept in the order first seen, never re-ranked, at most COLOURED', () => {
    const first = colourOrder([], [call({ by: 'b' }), call({ by: 'a' })])
    expect(first).toEqual(['b', 'a'])
    expect(colourOrder(first, [call({ by: 'a' }), call({ by: 'c' })])).toEqual(['b', 'a', 'c'])
    const many = Array.from({ length: 12 }, (_, i) => call({ by: `m${i}` }))
    expect(colourOrder([], many)).toHaveLength(COLOURED)
  })
})

describe('repeats, the redundant-call finder', () => {
  test('a module polling the host every 2 s is found, with its interval and the same answer each time', () => {
    const found = repeats(polling(NOW, 2000, 30), NOW)
    expect(found).toHaveLength(1)
    const [one] = found
    expect(one!.count).toBe(30)
    expect(one!.every).toBe(2000)
    expect(one!.same).toBe(29)
    expect(one!.said).toBe('Kanban asks Kehikot /host/call (tracker.get) every 2 s — 30 times, getting the same answer each time')
  })
  test('fewer than REPEAT_MIN, or outside the window, is not a repeat; a changing answer is said', () => {
    expect(repeats(polling(NOW, 2000, 4), NOW)).toEqual([])
    expect(repeats(polling(NOW - 10 * 60_000, 2000, 30), NOW)).toEqual([])
    const changing = polling(NOW, 1000, 6).map((one, i) => ({ ...one, bytesOut: i % 2 ? 1 : 2 }))
    expect(repeats(changing, NOW)[0]!.said).toBe('Kanban asks Kehikot /host/call (tracker.get) every 1 s — 6 times')
  })
  test('a git run, a 304 and a call with no reason are said in their own words; a sampled connection is not a call', () => {
    const runs = polling(NOW, 60_000 / 6, 6, { by: 'kehikko', side: 'out', kind: 'git ls-remote', host: 'github.com', path: '/a/b.git', reason: 'release tags', via: 'server', bytesOut: undefined })
    expect(repeats(runs, NOW)[0]!.said).toContain('Kehikot runs git ls-remote on github.com/a/b.git (release tags) every 10 s')
    const unlabelled = polling(NOW, 3000, 5, { by: 'kehikot.paper', reason: null, side: 'out', host: 'api.example.com', path: '/x', via: 'server' })
    expect(repeats(unlabelled, NOW)[0]!.said).toContain('Paper calls api.example.com/x (no reason given)')
    const seen = polling(NOW, 1000, 10, { side: 'seen', reported: 'sampled', kind: 'tcp' })
    expect(repeats(seen, NOW)).toEqual([])
  })
})

describe('the summary', () => {
  test('per caller: a minute’s rate, bytes, free share, no reason, connections seen', () => {
    const rows = summary([...polling(NOW, 2000, 30), call({ at: NOW - 1, by: 'kehikko', side: 'out', cache: 'refused', bytesIn: 100 }), call({ at: NOW - 1, by: 'kehikko', side: 'seen', reported: 'sampled' })], NOW)
    expect(rows[0]).toMatchObject({ by: 'kehikot.kanban', calls: 30, perMinute: 6, unlabelled: 0, free: 0, bytes: 30 * 512 })
    expect(rows[1]).toMatchObject({ by: 'kehikko', calls: 1, free: 1, freeRate: 1, unlabelled: 1, seen: 1, bytes: 100 })
  })
})

describe('the filter', () => {
  test('by caller, and by words in the destination, kind or reason', () => {
    const calls = [call({ reason: 'tracker.get' }), call({ by: 'kehikko', side: 'out', host: 'api.github.com', path: '/repos/a/b', reason: 'GitHub releases: a/b' })]
    expect(filtered(calls, { by: 'kehikko', text: '' })).toHaveLength(1)
    expect(filtered(calls, { by: null, text: 'github releases' })).toHaveLength(1)
    expect(filtered(calls, { by: null, text: 'tracker' })).toHaveLength(1)
    expect(filtered(calls, { by: null, text: 'nothing' })).toHaveLength(0)
  })
})

describe('repeats in bursts', () => {
  test('a call made in bursts says so rather than "every 0.1 s"', () => {
    const burst = (at: number) => [0, 100, 200].map((d) => call({ at: at + d, reason: 'tracker.get' }))
    const found = repeats([...burst(NOW - 90_000), ...burst(NOW - 40_000)], NOW)
    expect(found[0]!.said).toBe('Kanban asks Kehikot /host/call (tracker.get) in bursts over 50 s — 6 times, getting the same answer each time')
    const quick = polling(NOW, 300, 10)
    expect(repeats(quick, NOW)[0]!.said).toContain('several times a second')
  })
})
