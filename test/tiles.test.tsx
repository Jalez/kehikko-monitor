import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { judged, type CallerLatency } from '../src/health/model.ts'
import { HealthView } from '../src/view/health.tsx'
import {
  AXES_HEIGHT,
  RING_WIDE,
  SPARK_HEIGHT,
  callsTip,
  centreLabel,
  clock,
  cpuTip,
  diskSegments,
  indexAt,
  memoryTip,
  niceTop,
  restartsTip,
  segmentAt,
  segmentTip,
  segmentsSaid,
  stepped,
  tileLayout,
  tipAlign,
} from '../src/view/tiles.ts'
import { snapshotOf } from './health-fixtures.ts'

/*
 * The glance tiles in a narrow container (Monitor 0.6.0): title and number in a row of their own
 * above the plot, sparklines under 260 px and axes from there, a tooltip that says the value against
 * its limit and when — by pointer, finger or keyboard — and the disk as a doughnut with its words.
 */

afterEach(cleanup)

const NOW = 2_000_000_000
const latency: CallerLatency = { by: 'kehikot.kanban', timed: 10, calls: 10, errors: 1, p50: 400, p95: 2500, answered: null }

describe('the layout at each width', () => {
  test('200 and 240 px: one column of sparklines; 280 and 320: axes and a taller plot; three columns are sparklines again', () => {
    expect(tileLayout(200)).toEqual({ columns: 1, tile: 200, axes: false, plot: SPARK_HEIGHT, ring: SPARK_HEIGHT, legend: true })
    expect(tileLayout(240)).toMatchObject({ columns: 1, axes: false, plot: SPARK_HEIGHT })
    expect(tileLayout(280)).toEqual({ columns: 1, tile: 280, axes: true, plot: AXES_HEIGHT, ring: RING_WIDE, legend: true })
    expect(tileLayout(320)).toMatchObject({ columns: 1, axes: true, plot: AXES_HEIGHT })
    expect(tileLayout(400)).toMatchObject({ columns: 3, tile: 128, axes: false, legend: false })
    expect(tileLayout(700)).toMatchObject({ columns: 5, axes: false })
    expect(tileLayout(null)).toMatchObject({ tile: null, axes: false, plot: SPARK_HEIGHT })
  })

  test('a pointer picks the nearest point of a line and the bar it is over, and stays inside the plot', () => {
    expect(indexAt(0, 200, 6, 'line')).toBe(0)
    expect(indexAt(95, 200, 6, 'line')).toBe(2)
    expect(indexAt(500, 200, 6, 'line')).toBe(5)
    expect(indexAt(-5, 200, 4, 'bar')).toBe(0)
    expect(indexAt(120, 200, 4, 'bar')).toBe(2)
    expect(indexAt(10, 0, 4, 'bar')).toBeNull()
  })

  test('a doughnut segment from a pointer: clockwise from twelve, none in the hole or outside', () => {
    const halves = [0.5, 0.5]
    expect(segmentAt(60, 10, 80, halves)).toBe(0)
    expect(segmentAt(20, 70, 80, halves)).toBe(1)
    expect(segmentAt(40, 40, 80, halves)).toBeNull()
    expect(segmentAt(0, 0, 80, halves)).toBeNull()
  })

  test('the tooltip leans away from the edge; the keys move along, Escape closes', () => {
    expect([tipAlign(0, 6), tipAlign(3, 6), tipAlign(5, 6), tipAlign(0, 1)]).toEqual(['start', 'center', 'end', 'center'])
    expect(stepped('ArrowLeft', null, 6)).toBe(5)
    expect(stepped('ArrowLeft', 3, 6)).toBe(2)
    expect(stepped('ArrowRight', 5, 6)).toBe(5)
    expect(stepped('Home', 3, 6)).toBe(0)
    expect(stepped('End', 0, 6)).toBe(5)
    expect(stepped('Escape', 2, 6)).toBeNull()
    expect(stepped('a', 2, 6)).toBeUndefined()
  })

  test('an axis top is a round number at or above the highest value', () => {
    expect([niceTop(1.34), niceTop(0.96), niceTop(2500), niceTop(3), niceTop(0)]).toEqual([2, 1, 2500, 5, 1])
  })
})

describe('what each tooltip says', () => {
  test('CPU and memory against the computer’s, with the time of the point', () => {
    expect(cpuTip({ at: NOW, cpu: 1.34 }, 10)).toEqual({ value: '134% CPU', detail: '1.3 of 10 cores', at: clock(NOW) })
    expect(memoryTip({ at: NOW, rss: 960e6 }, 16e9)).toEqual({ value: '960 MB', detail: 'of 16 GB (6%)', at: clock(NOW) })
    expect(memoryTip({ at: NOW, rss: 960e6 }, 0).detail).toBe('resident')
  })

  test('a caller’s calls and a module’s starts, against where Monitor flags them', () => {
    expect(callsTip({ ...latency, p95: 2500 })).toEqual({ value: '2.5 s p95', detail: 'Kanban · 1 of 10 failed · flagged from 2 s', at: 'last 5 min' })
    expect(restartsTip({ id: 'kehikot.diff', starts: 3, crashes: 1 })).toEqual({ value: '3 starts', detail: 'Diff · 1 after a crash · flagged from 5', at: 'last 24 h' })
  })

  test('the disk: one segment per consumer, the biggest first, each named with its size', () => {
    const disk = { ...snapshotOf(NOW).disk }
    disk.uses = [...disk.uses, { label: 'Kehikot’s database (frame.sqlite)', kind: 'kehikot', bytes: 40e6 }, { label: 'Kept versions', kind: 'kehikot', bytes: 1e9 }, { label: '~/x/worktrees', kind: 'worktrees', bytes: 5e9, count: 2, withModules: 1 }]
    const segments = diskSegments(disk)
    expect(segments.map((one) => [one.key, one.bytes])).toEqual([
      ['worktrees', 125e9],
      ['modules', 3e9],
      ['other', 1e9],
      ['frame', 40e6],
      ['logs', 2e6],
    ])
    expect(segments[2]?.label).toBe('Other (kept versions)')
    expect(segmentTip(segments[0]!)).toEqual({ value: 'Worktrees', detail: '125 GB (97%)', at: '' })
    expect(segmentsSaid(segments)).toContain('Agent worktrees 125 GB, Installed modules 3 GB')
    expect(diskSegments({ ...disk, uses: [] })).toEqual([])
  })

  test('the biggest segment’s name sits in the hole only when it fits', () => {
    const segments = diskSegments(snapshotOf(NOW).disk)
    expect(centreLabel(segments, RING_WIDE)).toBe('Worktrees')
    expect(centreLabel(segments, SPARK_HEIGHT)).toBeNull()
    expect(centreLabel([{ ...segments[0]!, short: 'Logs' }], SPARK_HEIGHT)).toBe('Logs')
  })
})

describe('the tiles drawn at each width', () => {
  const draw = (width: number) => {
    const snapshot = snapshotOf(NOW)
    return render(<HealthView snapshot={snapshot} judged={judged(snapshot, [latency], NOW)} latencies={[latency]} problem={null} now={NOW} box={{ width, height: 600 }} />)
  }

  for (const [width, axes, height] of [
    [200, false, SPARK_HEIGHT],
    [240, false, SPARK_HEIGHT],
    [280, true, AXES_HEIGHT],
    [320, true, AXES_HEIGHT],
  ] as const) {
    test(`${width} px: title and number in their own row above a plot ${height} px tall${axes ? ', with axes' : ', a sparkline'}`, () => {
      draw(width)
      expect(screen.getByTestId('tiles').getAttribute('data-axes')).toBe(String(axes))
      for (const id of ['tile-cpu', 'tile-memory', 'tile-calls', 'tile-restarts']) {
        const tile = screen.getByTestId(id)
        const [head, sub, plot] = [...tile.children] as HTMLElement[]
        expect(head?.getAttribute('data-testid')).toBe(`${id}-head`)
        expect(within(head!).getByRole('heading')).toBeTruthy()
        expect(sub?.className).toContain('truncate')
        expect(plot?.getAttribute('data-testid')).toBe(`${id}-plot`)
        expect(plot?.style.height).toBe(`${height}px`)
      }
      /* The doughnut keeps its words beside it in one column. */
      expect(screen.getByTestId('tile-disk-segments').className).not.toContain('sr-only')
      expect(screen.queryByTestId('tile-disk-centre')?.textContent ?? null).toBe(axes ? 'Worktrees' : null)
    })
  }

  test('three columns: the doughnut’s words are for screen readers only', () => {
    draw(400)
    expect(screen.getByTestId('tile-disk-segments').className).toContain('sr-only')
    expect(screen.getByTestId('tile-disk-segments').textContent).toContain('Agent worktrees120 GB')
  })

  test('long words truncate, with the whole of them as a tooltip', () => {
    draw(200)
    const sub = within(screen.getByTestId('tile-disk')).getByText('40 worktrees, 30 with node_modules')
    expect(sub.className).toContain('truncate')
    expect(sub.getAttribute('title')).toBe('40 worktrees, 30 with node_modules')
    expect(within(screen.getByTestId('tile-disk-segments')).getByTitle('Agent worktrees')).toBeTruthy()
  })
})

describe('the tooltip by keyboard', () => {
  const plotOf = (id: string) => within(screen.getByTestId(`${id}-plot`)).getAllByRole('img')[0] as HTMLElement
  const tip = (id: string) => screen.getByTestId(`${id}-tip`)

  test('Tab to CPU shows the latest point; ← moves back; Escape and leaving close it', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[latency]} problem={null} now={NOW} box={{ width: 240, height: 600 }} />)
    const cpu = plotOf('tile-cpu')
    expect(cpu.tabIndex).toBe(0)
    expect(tip('tile-cpu').textContent).toBe('')
    fireEvent.focus(cpu)
    expect(tip('tile-cpu').textContent).toBe(`134% CPU${clock(NOW)}1.3 of 10 cores`)
    expect(cpu.getAttribute('aria-describedby')).toBe(tip('tile-cpu').id)
    expect(tip('tile-cpu').getAttribute('aria-live')).toBe('polite')
    fireEvent.keyDown(cpu, { key: 'ArrowLeft' })
    expect(tip('tile-cpu').textContent).toContain(clock(NOW - 5000))
    fireEvent.keyDown(cpu, { key: 'Escape' })
    expect(tip('tile-cpu').textContent).toBe('')
    fireEvent.keyDown(cpu, { key: 'End' })
    expect(tip('tile-cpu').textContent).toContain(clock(NOW))
    fireEvent.blur(cpu)
    expect(tip('tile-cpu').textContent).toBe('')
  })

  test('memory, calls, restarts and each disk segment say their numbers', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, [], NOW)} latencies={[latency]} problem={null} now={NOW} box={{ width: 320, height: 600 }} />)
    fireEvent.focus(plotOf('tile-memory'))
    expect(tip('tile-memory').textContent).toBe(`960 MB${clock(NOW)}of 16 GB (6%)`)
    fireEvent.focus(plotOf('tile-calls'))
    expect(tip('tile-calls').textContent).toBe('2.5 s p95last 5 minKanban · 1 of 10 failed · flagged from 2 s')
    fireEvent.focus(plotOf('tile-restarts'))
    fireEvent.keyDown(plotOf('tile-restarts'), { key: 'Home' })
    expect(tip('tile-restarts').textContent).toBe('3 startslast 24 hDiff · 1 after a crash · flagged from 5')
    const disk = plotOf('tile-disk')
    fireEvent.focus(disk)
    expect(tip('tile-disk').textContent).toBe('Worktrees120 GB (98%)')
    fireEvent.keyDown(disk, { key: 'ArrowRight' })
    expect(tip('tile-disk').textContent).toBe('Modules3 GB (2%)')
    expect(disk.getAttribute('aria-label')).toContain('Kehikot takes 123 GB: Agent worktrees 120 GB, Installed modules 3 GB, Logs 2 MB.')
  })
})
