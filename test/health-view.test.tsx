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
  test('two tiles, each with its number in words and its chart as an image of a sentence; no Calls or Restarts', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} />)
    for (const name of ['CPU', 'Memory']) expect(screen.getByRole('region', { name })).toBeTruthy()
    for (const name of ['Calls', 'Restarts', 'Disk']) expect(screen.queryByRole('region', { name })).toBeNull()
    expect(screen.getByTestId('tiles').children).toHaveLength(2)
    expect(screen.getByTestId('tile-cpu-value').textContent).toBe('134%')
    expect(screen.getByTestId('tile-memory-value').textContent).toBe('960 MB')
    const pictures = screen.getAllByRole('img').map((one) => one.getAttribute('aria-label'))
    expect(pictures.some((said) => said?.includes('use 134% CPU'))).toBe(true)
    expect(screen.getByTestId('health').textContent).not.toMatch(/restart|p95|Starts/i)
  })

  test('everything: one crash line, the modules table and Monitor’s own cost; no disk', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} />)
    expect(screen.getByTestId('health').getAttribute('data-detail')).toBe('full')
    expect(screen.getByTestId('flagged').textContent).toBe('Diff crashed in the last hour.')
    expect(screen.queryByText('Worth a look')).toBeNull()
    const table = screen.getByTestId('modules').textContent ?? ''
    expect(table).toContain('Kanban')
    expect(table).toContain('critical: crashed in the last hour')
    expect(table).toContain('warning: 120% CPU')
    expect(table).not.toContain('Notes')
    expect(screen.getByText('1 more registered modules are not running.')).toBeTruthy()
    expect(screen.queryByTestId('disk')).toBeNull()
    expect(screen.getByTestId('health').textContent).not.toMatch(/disk|worktree/i)
    expect(screen.getByTestId('health').textContent).not.toContain('Clean up')
    expect(screen.getByTestId('self').textContent).toContain('only while this page or an agent is looking')
  })

  test('nothing crashed in the last hour: no line at all, however many starts there were', () => {
    const snapshot = snapshotOf(NOW)
    snapshot.modules = [module(NOW, { id: 'kehikko', port: 4170 }), module(NOW, { id: 'kehikot.diff', port: 9030, crashedAt: [NOW - 2 * 3_600_000] })]
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} />)
    expect(screen.queryByTestId('flagged')).toBeNull()
    expect(screen.queryByText('Nothing needs a look.')).toBeNull()
  })

  test('before the first sample, a sentence', () => {
    render(<HealthView snapshot={emptySnapshot()} judged={[]} problem={null} now={NOW} />)
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
