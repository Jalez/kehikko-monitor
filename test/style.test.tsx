import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { TrafficCall } from 'kehikot-module-protocol'

import { Timeline, LINES_NARROW, bucketSaid, drawnCallers } from '../src/view/timeline.tsx'
import { HeaderMenus } from '../src/components/header-menus.tsx'
import { headerItems, type HeaderState } from '../src/header.ts'
import { BUCKETS_MS, callerOf, type Style } from '../src/traffic/model.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { call, polling } from './fixtures.ts'

/*
 * The timeline's chart style (Monitor 0.2.0): Lines by default, Bars and Area, switched from the
 * header (`style`, an agent may press it), kept with the host (`state.set`), with the bucket a style
 * reads at, and a legend that names every caller — "Claude: 2 sessions" — in every style.
 */

afterEach(cleanup)

const NOW = 2_000_000_000
const order = ['kehikot.kanban', 'kehikko', 'kehikot.claude', '~program:curl, from your terminal (zsh)']
const session = (pid: number, place: string, at: number): TrafficCall =>
  call({ at, by: 'kehikot.claude', via: 'process', path: '/mcp', caller: { kind: 'session', name: `Claude session on ${place}`, how: 'token', place, pid } })
const calls: TrafficCall[] = [
  ...polling(NOW, 2000, 20),
  call({ at: NOW - 900, by: 'kehikko', side: 'out', via: 'server', kind: 'GET', host: 'api.github.com', path: '/repos/a/b/releases', status: 304, cache: 'not-modified' }),
  session(11, 'Wide · methods', NOW - 3000),
  session(12, 'Wide · results', NOW - 2000),
  call({ at: NOW - 1000, by: '', via: 'process', caller: { kind: 'program', name: 'curl, from your terminal (zsh)', how: 'process', process: 'curl', parent: 'zsh' } }),
]

const legend = () => screen.getByRole('list', { name: 'Callers' })
const figure = () => screen.getByRole('figure')

describe('the chart styles', () => {
  for (const style of ['lines', 'bars', 'area'] as const) {
    test(`${style}: drawn as said, at its bucket, with every caller named in the legend`, () => {
      render(<Timeline calls={calls} range={5} order={order} only={null} now={NOW} style={style} />)
      expect(figure().getAttribute('data-style')).toBe(style)
      expect(figure().getAttribute('data-bucket-ms')).toBe(String(BUCKETS_MS[style][5]))
      const text = legend().textContent!
      for (const name of ['Kanban', 'Kehikot', 'Claude: 2 sessions', 'curl, from your terminal (zsh)']) expect(text).toContain(name)
      expect(text).toContain(style === 'lines' ? 'Dashed: free' : 'Hatched: free')
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain('by caller')
    })
  }

  test('the bucket per range and style, said under the title', () => {
    const said = (style: Style, range: 5 | 15 | 60) => {
      render(<Timeline calls={calls} range={range} order={order} only={null} now={NOW} style={style} />)
      const out = [figure().getAttribute('data-bucket-ms'), figure().textContent]
      cleanup()
      return out
    }
    expect(said('lines', 5)).toEqual(['5000', expect.stringContaining('each point is 5 seconds')])
    expect(said('lines', 15)).toEqual(['15000', expect.stringContaining('each point is 15 seconds')])
    expect(said('lines', 60)).toEqual(['60000', expect.stringContaining('each point is a minute')])
    expect(said('bars', 5)).toEqual(['1000', expect.stringContaining('each bar is a second')])
    expect(said('area', 60)).toEqual(['60000', expect.stringContaining('each point is a minute')])
    expect(bucketSaid('bars', 15_000)).toBe('each bar is 15 seconds')
  })

  test('lines and area end at the last whole bucket; bars draw the one still filling', () => {
    const points = (style: Style) => {
      render(<Timeline calls={calls} range={5} order={order} only={null} now={NOW} style={style} />)
      const n = Number(figure().getAttribute('data-points'))
      cleanup()
      return n
    }
    expect(points('lines')).toBe(59)
    expect(points('area')).toBe(59)
    expect(points('bars')).toBe(300)
  })

  test('the caller filter holds in every style: only that caller is in the legend', () => {
    for (const style of ['lines', 'bars', 'area'] as const) {
      render(<Timeline calls={calls} range={5} order={order} only="kehikot.claude" now={NOW} style={style} />)
      expect([...legend().querySelectorAll('[data-caller]')].map((one) => one.getAttribute('data-caller'))).toEqual(['kehikot.claude'])
      cleanup()
    }
  })

  test(`narrow, lines draw the ${LINES_NARROW} busiest callers and Other; bars and area keep every one`, () => {
    const many = Array.from({ length: 7 }, (_, i) => `kehikot.m${i}`)
    const busy = many.flatMap((id, i) => Array.from({ length: i + 1 }, (_, n) => call({ at: NOW - 1000 - n, by: id })))
    expect(drawnCallers('lines', true, many, busy, NOW - 5 * 60_000)).toEqual(many.slice(2))
    expect(drawnCallers('lines', false, many, busy, NOW - 5 * 60_000)).toEqual(many)
    expect(drawnCallers('bars', true, many, busy, NOW - 5 * 60_000)).toEqual(many)
    render(<Timeline calls={busy} range={5} order={many} only={null} now={NOW} style="lines" narrow />)
    const drawn = [...legend().querySelectorAll('[data-caller]')].map((one) => one.getAttribute('data-caller'))
    expect(drawn).toEqual([...many.slice(2), '~other'])
    expect(legend().textContent).toContain('Other callers')
  })

  test('the Chart switch in the header presses style, for agents too', async () => {
    const state: HeaderState = { range: 5, style: 'lines', paused: false, caller: null, callers: order }
    const pressed: unknown[] = []
    render(<HeaderMenus items={headerItems(state)} onPress={(press) => pressed.push(press)} />)
    const view = document.querySelector('[data-menu="view"]')!
    await act(async () => {
      fireEvent.keyDown(view, { key: 'ArrowDown' })
    })
    const bars = screen.getAllByRole('menuitemradio', { hidden: true }).find((one) => one.textContent?.includes('Bars')) ?? screen.getAllByText('Bars')[0]!
    await act(async () => {
      fireEvent.click(bars)
    })
    expect(pressed).toContainEqual({ item: 'style', value: 'bars' })
  })
})

describe('the choice is kept with the host', () => {
  test('read back from what the host kept, and a press is remembered (state.set)', async () => {
    const remembered: unknown[] = []
    let onPress: ((press: { item: string; value?: unknown }) => unknown) | undefined
    const read = { calls, newest: calls.length, oldest: 1, kept: 5000, started: 1 }
    const host: Host = {
      where: 'hosted',
      projectPath: null,
      theme: 'light',
      header: () => {},
      request: async () => read,
      kept: { style: 'bars' },
      remember: (next) => remembered.push(next),
    }
    mock.module('../src/wire/use-kehikot.ts', () => ({
      useKehikot: (events: { onPress?: typeof onPress }) => {
        onPress = events.onPress
        return host
      },
    }))
    const { App } = await import('../src/app.tsx')
    render(<App />)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20))
    })
    expect(figure().getAttribute('data-style')).toBe('bars')
    expect(remembered).toEqual([])
    await act(async () => {
      onPress!({ item: 'style', value: 'area' })
    })
    expect(figure().getAttribute('data-style')).toBe('area')
    expect(remembered).toEqual([{ style: 'area' }])
    expect(onPress!({ item: 'style', value: 'pie' })).toBeTypeOf('string')
    expect(calls.map(callerOf)).toContain('kehikot.claude')
  })
})
