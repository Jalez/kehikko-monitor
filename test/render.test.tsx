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
  limits: null,
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
    /* A Kehikot before protocol 2.24.0 says only its budgets: shown as before. */
    expect(screen.getByText('GitHub API without an account: 4 used, 26 left of 30 an hour. Only when gh is not signed in.')).toBeTruthy()
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

describe('the limits Kehikot spends for you', () => {
  const RESET = NOW + 30 * 60_000
  const anonymous = { name: 'GitHub without an account', used: 0, limit: 30, left: 30, resets: null, note: '' }
  const core = { limit: 5000, used: 188, remaining: 4812, resets: RESET, share: { limit: 1000, used: 312 }, floor: 500 }
  const graphql = { limit: 5000, used: 40, remaining: 4960, resets: RESET, share: { limit: 1000, used: 25 }, floor: 500 }
  const account = { login: 'Jalez', core, graphql, paused: false, why: '', until: null, at: NOW }
  const limitsList = () => screen.getByRole('list', { name: 'Limits Kehikot spends for you' })

  test('the account’s real limits and Kehikot’s share, in words and as meters', () => {
    draw({ traffic: { limits: { github: { account, anonymous } } } })
    const text = limitsList().textContent ?? ''
    expect(text).toMatch(/GitHub as Jalez: 4,812 of 5,000 left this hour · resets \d{1,2}[:.]\d{2}/)
    expect(text).toContain("Kehikot's share: 312 of 1,000 used")
    expect(text).toMatch(/GitHub as Jalez, GraphQL: 4,960 of 5,000 points left this hour/)
    expect(text).toContain("Kehikot's share: 25 of 1,000 points used")
    const meters = screen.getAllByRole('meter')
    expect(meters.map((one) => one.getAttribute('aria-valuenow'))).toEqual(['312', '25'])
    expect(meters[0]!.getAttribute('aria-label')).toBe("Kehikot's share of GitHub as Jalez: 312 of 1,000 used")
  })

  test('the budget without an account is shown only when it was used', () => {
    draw({ traffic: { limits: { github: { account, anonymous } } } })
    expect(limitsList().textContent).not.toContain('Without an account')
    cleanup()
    draw({ traffic: { limits: { github: { account, anonymous: { ...anonymous, used: 3, left: 27 } } } } })
    expect(screen.getByText("Without an account: 3 of 30 used (when gh isn't signed in)")).toBeTruthy()
  })

  test('a pause is said in words', () => {
    draw({ traffic: { limits: { github: { account: { ...account, paused: true, why: "Kehikot's share of your GitHub limit is used until 11:00", until: RESET }, anonymous } } } })
    expect(screen.getByText("Paused: Kehikot's share of your GitHub limit is used until 11:00.")).toBeTruthy()
  })

  test('no account and nothing read without one: says so, with no meter', () => {
    draw({ traffic: { limits: { github: { account: null, anonymous } } } })
    expect(limitsList().textContent).toBe('GitHub: nothing counted against a limit yet.')
    expect(screen.queryAllByRole('meter')).toHaveLength(0)
  })
})
