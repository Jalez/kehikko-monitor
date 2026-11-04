import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import { headerItems, type HeaderState } from '../src/header.ts'
import { emptySnapshot, judged } from '../src/health/model.ts'
import { HealthView } from '../src/view/health.tsx'
import type { Host } from '../src/wire/use-kehikot.ts'
import { readHealth } from '../src/wire/use-health.ts'
import { call } from './fixtures.ts'
import { module, snapshotOf } from './health-fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000

const host = (over: Partial<Host> = {}): Host => ({ where: 'hosted', projectPath: null, theme: 'light', header: () => {}, request: async () => ({}), ...over })
const state: HeaderState = { view: 'health', range: 5, style: 'lines', paused: false, caller: null, callers: [] }
const traffic = { calls: [call({ at: NOW - 1000, by: 'kehikot.kanban', ms: 30 })], budgets: [], limits: null, processes: null, problem: null, gap: false, at: NOW }

describe('the Health view', () => {
  test('five tiles, each with its number in words and its chart as an image of a sentence', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[]} problem={null} now={NOW} />)
    for (const name of ['CPU', 'Memory', 'Calls', 'Restarts', 'Disk']) expect(screen.getByRole('region', { name })).toBeTruthy()
    expect(screen.getByTestId('tile-cpu-value').textContent).toBe('134%')
    expect(screen.getByTestId('tile-memory-value').textContent).toBe('960 MB')
    expect(screen.getByTestId('tile-disk-value').textContent).toBe('60 GB free')
    const pictures = screen.getAllByRole('img').map((one) => one.getAttribute('aria-label'))
    expect(pictures.some((said) => said?.includes('use 134% CPU'))).toBe(true)
    expect(pictures.some((said) => said?.includes('after a crash'))).toBe(true)
  })

  test('unmeasured, everything: the modules worth a look with their level in words, the table, the disk and Monitor’s own cost', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[]} problem={null} now={NOW} />)
    expect(screen.getByTestId('health').getAttribute('data-detail')).toBe('full')
    expect(screen.getByTestId('flagged').textContent).toContain('crashed in the last hour (critical)')
    expect(screen.getByTestId('flagged').textContent).toContain('120% CPU (warning)')
    const table = screen.getByTestId('modules').textContent ?? ''
    expect(table).toContain('Kanban')
    expect(table).not.toContain('Notes')
    expect(screen.getByText('1 more registered modules are not running.')).toBeTruthy()
    expect(screen.getByTestId('disk').textContent).toContain('40 worktrees, 30 with node_modules')
    expect(screen.getByTestId('self').textContent).toContain('only while this page or an agent is looking')
  })

  test('a day of updates and restarts: one quiet line, and the Restarts tile splits them without a warning colour', () => {
    const snapshot = snapshotOf(NOW)
    /* Claude started nine times today, all of them updates or Kehikot starting it; nothing crashed, nothing is busy. */
    snapshot.modules = [
      module(NOW, { id: 'kehikko', port: 4170 }),
      module(NOW, { id: 'kehikot.claude', port: 9030, starts: 9, updates: 5 }),
      module(NOW, { id: 'kehikot.paper', port: 9040, starts: 4, updates: 1 }),
    ]
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[]} problem={null} now={NOW} />)
    expect(screen.getByTestId('flagged').textContent).toBe('Nothing needs a look.')
    expect(screen.queryByText('Worth a look')).toBeNull()
    expect(screen.getByTestId('tile-restarts-value').textContent).toBe('14 today')
    const tile = screen.getByRole('region', { name: 'Restarts' })
    expect(tile.textContent).toContain('6 updates, 8 restarts, no crash')
    expect(tile.innerHTML).not.toContain('destructive')
    expect(tile.innerHTML).not.toContain('amber')
  })

  test('a crash still shows in the Restarts tile as a count, in words, not in red', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[]} problem={null} now={NOW} />)
    const tile = screen.getByRole('region', { name: 'Restarts' })
    expect(tile.textContent).toContain('1 update, 4 restarts, 1 crash')
    expect(tile.innerHTML).not.toContain('destructive')
  })

  test('before the first sample, a sentence', () => {
    render(<HealthView snapshot={emptySnapshot()} judged={[]} latencies={[]} problem={null} now={NOW} />)
    expect(screen.getByRole('status').textContent).toContain('first figures')
  })

  test('the screen draws Health when it is the view, and the footer carries the health either way', () => {
    const sent: unknown[][] = []
    render(
      <Screen
        host={host({ drawsFooter: true, footer: (items) => sent.push(items) })}
        traffic={traffic}
        health={{ snapshot: snapshotOf(NOW), problem: null }}
        items={headerItems(state)}
        state={state}
        order={[]}
        filter={{ by: null, text: '' }}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('health')).toBeTruthy()
    const ids = (sent.at(-1) as { id: string }[]).map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['live', 'worst', 'cpu', 'memory', 'clear']))
  })

  test('the page reads its server’s snapshot, and says so when it cannot', async () => {
    const good = await readHealth(async () => ({ ok: true, status: 200, json: async () => snapshotOf(NOW) }), '/api/health')
    expect(good.modules).toHaveLength(5)
    await expect(readHealth(async () => ({ ok: false, status: 503, json: async () => null }), '/api/health')).rejects.toThrow('503')
    await expect(readHealth(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }), '/api/health')).rejects.toThrow('cannot read')
  })
})
