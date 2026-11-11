import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import type { ActivityItem } from 'kehikot-module-protocol'

import type { Outside } from '../src/health/heavy.ts'
import { healthItems } from '../src/footer.ts'
import { judged } from '../src/health/model.ts'
import { heavyItems, useHeavyInbox } from '../src/inbox.ts'
import { snapshotOf } from './health-fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000
const RUN: Outside = { pid: 42, word: 'tsc', kind: 'typecheck', pcpu: 217, sessionPid: 100, agent: 'claude', session: '1dc1bf90-aaaa' }

describe('heavy work in the Inbox', () => {
  test('one item per run, doing and normal, never "needs you", in the provider’s name or "a work queue"', () => {
    expect(heavyItems([RUN], 'Turns')).toEqual([
      { id: 'heavy-42', state: 'working', priority: 'normal', label: 'tsc running outside Turns', detail: 'Heavy work running outside Turns: tsc from claude session 1dc1bf90 (217% CPU).', group: 'Heavy work' },
    ])
    expect(heavyItems([RUN], null)[0]!.label).toBe('tsc running outside a work queue')
    expect(heavyItems([], 'Turns')).toEqual([])
  })

  test('appears while the run lasts, once per run, and clears when its process ends', () => {
    const sent: ActivityItem[][] = []
    const activity = (items: ActivityItem[]) => sent.push(items)
    const { rerender } = renderHook(({ outside }: { outside: Outside[] }) => useHeavyInbox(activity, outside, 'Turns'), { initialProps: { outside: [RUN] } })
    expect(sent.at(-1)!.map((one) => one.id)).toEqual(['heavy-42'])
    /* The same run read again, its CPU moved: not reported again. */
    rerender({ outside: [{ ...RUN, pcpu: 180 }] })
    expect(sent).toHaveLength(1)
    rerender({ outside: [] })
    expect(sent.at(-1)).toEqual([])
    expect(sent).toHaveLength(2)
  })

  test('the footer says how many, in the existing row', () => {
    const snapshot = { ...snapshotOf(NOW), outside: [RUN, { ...RUN, pid: 43 }], provider: null }
    expect(healthItems({ snapshot, judged: judged(snapshot, NOW) })).toContainEqual(expect.objectContaining({ id: 'outside', text: '2 heavy runs outside a work queue', level: 'warn' }))
  })
})
