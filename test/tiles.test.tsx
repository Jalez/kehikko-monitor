import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { judged } from '../src/health/model.ts'
import { HealthView } from '../src/view/health.tsx'
import {
  AXES_HEIGHT,
  PAD_X,
  PAD_Y,
  RING_MID,
  RING_WIDE,
  SPARK_HEIGHT,
  TIP_LINE_MAX,
  centreLabel,
  clip,
  clock,
  columnHeight,
  cpuTip,
  diskSegments,
  indexAt,
  memoryTip,
  niceTop,
  segmentAt,
  segmentTip,
  segmentsSaid,
  diskWords,
  segmentSaid,
  stepped,
  tileLayout,
  tipAlign,
  tipLines,
  tipSide,
  type Tip,
} from '../src/view/tiles.ts'
import { snapshotOf } from './health-fixtures.ts'

/*
 * The glance tiles in a narrow container (Monitor 0.7.0, tidied in 0.8.1): no cards, a hairline
 * between tiles, title, words and number on one row in one column with the plot edge to edge under
 * it, sparklines under 260 px and axes from there, a solid tooltip of three short lines outside the
 * plot — by pointer, finger or keyboard — and the disk as a doughnut with its words.
 */

afterEach(cleanup)

const NOW = 2_000_000_000

describe('the layout at each width', () => {
  test('200 and 240 px: one compact column of sparklines; 280 and 320: axes and a taller plot; two and three columns are sparklines again', () => {
    expect(tileLayout(200)).toEqual({ columns: 1, tile: 200, axes: false, plot: SPARK_HEIGHT, ring: RING_MID, legend: true, compact: true })
    expect(tileLayout(240)).toMatchObject({ columns: 1, axes: false, plot: SPARK_HEIGHT, compact: true })
    expect(tileLayout(280)).toEqual({ columns: 1, tile: 280, axes: true, plot: AXES_HEIGHT, ring: RING_WIDE, legend: true, compact: true })
    expect(tileLayout(320)).toMatchObject({ columns: 1, axes: true, plot: AXES_HEIGHT })
    /* Two columns: CPU and Memory side by side, the disk across the whole row below with its list beside it. */
    expect(tileLayout(400)).toMatchObject({ columns: 2, tile: 199, axes: false, legend: true, ring: RING_MID, compact: false })
    expect(tileLayout(620)).toMatchObject({ columns: 2, tile: 309, axes: true, legend: true, ring: RING_WIDE })
    /* Three side by side from 640 px; the disk has a tile of its own, wide enough for its list. */
    expect(tileLayout(700)).toMatchObject({ columns: 3, tile: 232, axes: false, legend: true, ring: RING_MID, compact: false })
    expect(tileLayout(1000)).toMatchObject({ columns: 3, axes: true })
    expect(tileLayout(null)).toMatchObject({ tile: null, axes: false, plot: SPARK_HEIGHT })
  })

  test('one column at 200–320 px stands no taller than it needs: 262 px at 240', () => {
    /* Two rows of 6 + 20 + 2 + 44 + 6, the disk's row as tall as its five-line list, and two hairlines. */
    expect(columnHeight(tileLayout(240), 5)).toBe(262)
    expect(columnHeight(tileLayout(200), 5)).toBe(262)
    /* With axes the plots are 72 and the doughnut 88, its list beside it shorter than it. */
    expect(columnHeight(tileLayout(280), 5)).toBe(2 * (6 + 20 + 2 + 72 + 6) + (6 + 20 + 2 + 88 + 6) + 2)
    expect(columnHeight(tileLayout(320), 3)).toBe(columnHeight(tileLayout(280), 3))
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

  test('the tooltip sits outside the plot: above when it fits, else below', () => {
    expect(tipSide(80, 60)).toBe('above')
    expect(tipSide(30, 60)).toBe('below')
    expect(tipSide(0, 0)).toBe('below')
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
    expect(cpuTip({ at: NOW, cpu: 1.34 }, 10)).toEqual({ value: '134% CPU', detail: '1.3 of 10 cores', note: clock(NOW) })
    expect(memoryTip({ at: NOW, rss: 960e6 }, 16e9)).toEqual({ value: '960 MB', detail: '6% of 16 GB', note: clock(NOW) })
    expect(memoryTip({ at: NOW, rss: 960e6 }, 0).detail).toBe('')
  })

  test('every tooltip is three short lines at most, however large the figures and long the names', () => {
    const tips: Tip[] = [
      cpuTip({ at: NOW, cpu: 12.345 }, 128),
      cpuTip({ at: NOW, cpu: 0 }, 8),
      memoryTip({ at: NOW, rss: 123.4e9 }, 1024e9),
      memoryTip({ at: NOW, rss: 1 }, 0),
      ...diskSegments({ ...snapshotOf(NOW).disk, uses: [{ label: 'Kehikot’s database', kind: 'kehikot', bytes: 999e9 }, { label: 'Installed modules', kind: 'kehikot', bytes: 1 }] }).map(segmentTip),
    ]
    for (const one of tips) {
      const lines = tipLines(one)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThanOrEqual(3)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(TIP_LINE_MAX)
    }
    expect(clip('A'.repeat(40))).toHaveLength(TIP_LINE_MAX)
    expect(clip('Kanban')).toBe('Kanban')
  })

  test('the disk: one segment per consumer, the biggest first, each named with its size', () => {
    const disk = { ...snapshotOf(NOW).disk }
    disk.uses = [...disk.uses, { label: 'Kehikot’s database', kind: 'kehikot', bytes: 40e6 }, { label: 'Kept versions', kind: 'kehikot', bytes: 1e9 }, { label: '~/x/worktrees', kind: 'worktrees', bytes: 5e9, count: 2, withModules: 1 }]
    const segments = diskSegments(disk)
    expect(segments.map((one) => [one.key, one.bytes])).toEqual([
      ['worktrees', 125e9],
      ['modules', 3e9],
      ['other', 1e9],
      ['frame', 40e6],
      ['logs', 2e6],
    ])
    expect(segments.map((one) => one.label)).toEqual(['Agent worktrees', 'Modules', 'Other', 'Database', 'Logs'])
    expect(segmentTip(segments[0]!)).toEqual({ value: 'Agent worktrees', detail: '125 GB · 97%', note: '' })
    expect(segmentSaid(segments[0]!)).toBe('Agent worktrees · 125 GB · 97%')
    expect(segmentSaid(segments[3]!)).toBe('Database · 40 MB · 0%')
    expect(segmentsSaid(segments)).toContain('Kehikot uses 129 GB: Agent worktrees · 125 GB · 97%; Modules · 3 GB · 2%')
    expect(diskSegments({ ...disk, uses: [] })).toEqual([])
  })

  test('the biggest segment’s name sits in the hole only when it fits', () => {
    const segments = diskSegments(snapshotOf(NOW).disk)
    expect(centreLabel(segments, RING_WIDE)).toBe('Worktrees')
    expect(centreLabel(segments, RING_MID)).toBeNull()
    expect(centreLabel(segments, SPARK_HEIGHT)).toBeNull()
    expect(centreLabel([{ ...segments[0]!, short: 'Logs' }], SPARK_HEIGHT)).toBe('Logs')
  })
})

describe('the Disk tile says what its numbers are', () => {
  const disk = snapshotOf(NOW).disk
  const segments = diskSegments(disk)

  test('the headline is what Kehikot uses and what is free; a low disk leads with how full it is', () => {
    expect(diskWords(disk, segments, false)).toEqual({ value: 'Kehikot uses 123 GB', sub: '60 GB free on this disk' })
    expect(diskWords({ ...disk, free: 40e9 }, segments, true)).toEqual({ value: 'Disk 92% full', sub: '40 GB free · Kehikot uses 123 GB' })
    expect(diskWords({ ...disk, free: null }, [], false)).toEqual({ value: '—', sub: 'measuring' })
  })
})

describe('the tiles drawn at each width', () => {
  const draw = (width: number) => {
    const snapshot = snapshotOf(NOW)
    return render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} box={{ width, height: 600 }} />)
  }

  for (const [width, axes, height] of [
    [200, false, SPARK_HEIGHT],
    [240, false, SPARK_HEIGHT],
    [280, true, AXES_HEIGHT],
    [320, true, AXES_HEIGHT],
  ] as const) {
    test(`${width} px: title, words and number on one row, then a plot ${height} px tall edge to edge${axes ? ', with axes' : ', a sparkline'}`, () => {
      draw(width)
      expect(screen.getByTestId('tiles').getAttribute('data-axes')).toBe(String(axes))
      expect(screen.getByTestId('tiles').getAttribute('data-compact')).toBe('true')
      for (const id of ['tile-cpu', 'tile-memory']) {
        const tile = screen.getByTestId(id)
        const [head, plot, more] = [...tile.children] as HTMLElement[]
        expect(head?.getAttribute('data-testid')).toBe(`${id}-head`)
        const [title, sub, value] = [...head!.children] as HTMLElement[]
        expect(title?.tagName).toBe('H2')
        expect(sub?.className).toContain('truncate')
        expect(value?.getAttribute('data-testid')).toBe(`${id}-value`)
        expect(plot?.getAttribute('data-testid')).toBe(`${id}-plot`)
        expect(plot?.style.height).toBe(`${height}px`)
        expect(plot?.style.marginInline).toBe(`-${PAD_X}px`)
        expect(more).toBeUndefined()
      }
      /* The doughnut keeps its words beside it in one column. */
      expect(screen.getByTestId('tile-disk-segments').className).not.toContain('sr-only')
      expect(screen.queryByTestId('tile-disk-centre')?.textContent ?? null).toBe(axes ? 'Worktrees' : null)
    })
  }

  test('no cards: no border, background card or gap of a tile’s own, a hairline between, tight padding', () => {
    draw(240)
    const tiles = screen.getByTestId('tiles')
    expect(tiles.className).toContain('gap-px')
    expect(tiles.className).toContain('bg-border')
    for (const tile of [...tiles.children] as HTMLElement[]) {
      expect(tile.className).not.toMatch(/\bborder\b|bg-card|rounded/)
      expect(tile.className).toContain('bg-background')
      expect(tile.style.padding).toBe(`${PAD_Y}px ${PAD_X}px`)
    }
  })

  test('two columns: the words go under the title, the disk takes the row below with its list beside it; three: its list is still there', () => {
    draw(400)
    expect(screen.getByTestId('tiles').getAttribute('data-compact')).toBe('false')
    const [head, sub, plot] = [...screen.getByTestId('tile-cpu').children] as HTMLElement[]
    expect(head?.getAttribute('data-testid')).toBe('tile-cpu-head')
    expect(sub?.className).toContain('truncate')
    expect(plot?.getAttribute('data-testid')).toBe('tile-cpu-plot')
    expect(screen.getByTestId('tile-disk').className).toContain('@min-[360px]:col-span-2')
    expect(screen.getByTestId('tile-disk-segments').className).not.toContain('sr-only')
    expect(screen.getByTestId('tiles').className).toContain('@min-[360px]:grid-cols-2')
    expect(screen.getByTestId('tiles').className).toContain('@min-[640px]:grid-cols-3')
    expect(screen.getByTestId('tile-disk-segments').textContent).toContain('Agent worktrees120 GB · 98%')
    expect(screen.getByTestId('tile-disk-value').textContent).toBe('Kehikot uses 123 GB')
    expect(screen.getByTestId('tile-disk').textContent).toContain('60 GB free on this disk')
    expect(screen.queryByTestId('tile-disk-hint')).toBeNull()
    cleanup()
    draw(700)
    expect(screen.getByTestId('tile-disk-segments').className).not.toContain('sr-only')
    expect(screen.getByTestId('tile-disk').className).toContain('@min-[640px]:col-span-1')
    expect(screen.queryByTestId('tile-calls')).toBeNull()
    expect(screen.queryByTestId('tile-restarts')).toBeNull()
  })

  test('the doughnut’s row is as tall as its list, so neither is cut off', () => {
    draw(240)
    const plot = screen.getByTestId('tile-disk-plot')
    expect(plot.style.height).toBe(`${Math.max(RING_MID, 3 * 14)}px`)
    expect((within(plot).getAllByRole('img')[0] as HTMLElement).style.width).toBe(`${RING_MID}px`)
  })

  test('long words truncate, with the whole of them as a tooltip', () => {
    draw(200)
    const sub = within(screen.getByTestId('tile-disk')).getByText('60 GB free on this disk')
    expect(sub.className).toContain('truncate')
    expect(sub.getAttribute('title')).toBe('60 GB free on this disk')
    expect(within(screen.getByTestId('tile-disk-segments')).getByTitle('Agent worktrees')).toBeTruthy()
  })
})

describe('the tooltip by keyboard', () => {
  const plotOf = (id: string) => within(screen.getByTestId(`${id}-plot`)).getAllByRole('img')[0] as HTMLElement
  const tip = (id: string) => screen.getByTestId(`${id}-tip`)

  test('Tab to CPU shows the latest point; ← moves back; Escape and leaving close it', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} box={{ width: 240, height: 600 }} />)
    const cpu = plotOf('tile-cpu')
    expect(cpu.tabIndex).toBe(0)
    expect(tip('tile-cpu').textContent).toBe('')
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(cpu)
    expect(tip('tile-cpu').textContent).toBe(`134% CPU1.3 of 10 cores${clock(NOW)}`)
    /* Solid, 12 px, a strong border and a shadow, wrapped within a width, outside the plot. */
    const shown = tip('tile-cpu')
    for (const one of ['bg-popover', 'text-xs', 'border-foreground/25', 'shadow-lg', 'break-words', 'max-w-[min(15rem,calc(100%-8px))]']) expect(shown.className).toContain(one)
    /* Never see-through: no opacity, no popover colour with an alpha. */
    expect(shown.className).not.toMatch(/opacity|bg-popover\//)
    expect(shown.getAttribute('data-side')).toBe('below')
    expect(shown.style.top).toBe('calc(100% + 4px)')
    expect((shown.firstElementChild as HTMLElement).className).toContain('font-semibold')
    expect(shown.children).toHaveLength(3)
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

  test('memory and each disk segment say their numbers; a segment its name, size and share', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} box={{ width: 320, height: 600 }} />)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(plotOf('tile-memory'))
    expect(tip('tile-memory').textContent).toBe(`960 MB6% of 16 GB${clock(NOW)}`)
    const disk = plotOf('tile-disk')
    fireEvent.focus(disk)
    expect(tip('tile-disk').textContent).toBe('Agent worktrees120 GB · 98%')
    fireEvent.keyDown(disk, { key: 'ArrowRight' })
    expect(tip('tile-disk').textContent).toBe('Modules3 GB · 2%')
    expect(disk.getAttribute('aria-label')).toContain('Kehikot uses 123 GB: Agent worktrees · 120 GB · 98%')
  })
})
