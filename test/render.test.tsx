import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import { headerItems, type HeaderState } from '../src/header.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import type { Traffic } from '../src/wire/use-traffic.ts'
import { call, polling } from './fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000

function host(over: Partial<Host> = {}): Host {
  return { where: 'hosted', projectPath: null, theme: 'light', header: () => {}, request: async () => ({}), ...over }
}

const traffic = (over: Partial<Traffic> = {}): Traffic => ({
  calls: [...polling(NOW, 2000, 20), call({ at: NOW - 900, by: 'kehikko', side: 'out', via: 'server', kind: 'GET', host: 'api.github.com', path: '/repos/a/b/releases', status: 304, cache: 'not-modified', reason: 'GitHub releases: a/b' })],
  budgets: [{ name: 'GitHub API without an account', used: 4, limit: 30, left: 26, resets: null, note: 'Only when gh is not signed in.' }],
  processes: { on: true, bytes: true, at: NOW, why: '', connections: [{ by: 'kehikot.browser', pid: 700, process: 'Google Chrome', proto: 'tcp', remote: 'github.com', port: 443, local: false, bytesIn: 4000, bytesOut: 500, since: NOW }] },
  problem: null,
  gap: false,
  at: NOW,
  ...over,
})

const state: HeaderState = { range: 5, paused: false, caller: null, callers: ['kehikot.kanban', 'kehikko'] }

function draw(over: { host?: Partial<Host>; traffic?: Partial<Traffic>; state?: Partial<HeaderState> } = {}, onShow = () => {}) {
  const s = { ...state, ...over.state }
  return render(
    <Screen host={host(over.host)} traffic={traffic(over.traffic)} items={headerItems(s)} state={s} order={['kehikot.kanban', 'kehikko']} filter={{ by: null, text: '' }} onShow={onShow} now={NOW} />,
  )
}

describe('the screen', () => {
  test('the timeline, named and described for a screen reader, with every caller in its legend', () => {
    draw()
    expect(screen.getByRole('heading', { name: 'Calls per second' })).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by caller')
    const legend = screen.getByRole('list', { name: 'Callers' })
    expect(legend.textContent).toContain('Kanban')
    expect(legend.textContent).toContain('Kehikot')
    expect(legend.textContent).toContain('Hatched: free')
  })

  test('repeats first: the module polling the host, in a sentence, with a way to its calls', () => {
    let shown = ''
    draw({}, ((repeat: { said: string }) => (shown = repeat.said)) as never)
    expect(screen.getByText('Kanban asks Kehikot /host/call (tracker.get) every 2 s — 20 times, getting the same answer each time')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Show these calls/ }))
    expect(shown).toContain('Kanban asks')
  })

  test('the callers table and the GitHub budget say the numbers in text', () => {
    draw()
    expect(screen.getAllByRole('table')[0]!.textContent).toContain('Kanban')
    expect(screen.getByText('4 used, 26 left of 30 an hour')).toBeTruthy()
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('4')
  })

  test('connections nobody reported, by caller', () => {
    draw()
    expect(screen.getByRole('heading', { name: /Open connections/ })).toBeTruthy()
    expect(screen.getByText('Google Chrome')).toBeTruthy()
  })

  test('paused says so; a host that keeps no record says what to do', () => {
    draw({ state: { paused: true } })
    expect(screen.getByText(/Paused: the picture stands still/)).toBeTruthy()
    cleanup()
    draw({ traffic: { calls: [], problem: 'This Kehikot keeps no record of traffic yet. Update Kehikot to see it.' } })
    expect(screen.getByRole('status').textContent).toContain('Update Kehikot')
  })

  test('alone, it draws its own header and the cover says there is no host', () => {
    draw({ host: { where: 'unhosted' } })
    expect(screen.getByText('Monitor')).toBeTruthy()
  })
})
