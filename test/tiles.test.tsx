import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { judged } from '../src/health/model.ts'
import { HealthView } from '../src/view/health.tsx'
import {
  AXES_HEIGHT,
  PAD_X,
  PAD_Y,
  SPARK_HEIGHT,
  TIP_LINE_MAX,
  clip,
  clock,
  columnHeight,
  cpuTip,
  indexAt,
  memoryTip,
  niceTop,
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
 * plot — by pointer, finger or keyboard. Two tiles, CPU and memory: the disk moved to Worktrees (0.14.0).
 */

afterEach(cleanup)

const NOW = 2_000_000_000

describe('the layout at each width', () => {
  test('200 and 240 px: one compact column of sparklines; 280 and 320: axes and a taller plot; two and three columns are sparklines again', () => {
    expect(tileLayout(200)).toEqual({ columns: 1, tile: 200, axes: false, plot: SPARK_HEIGHT, compact: true })
    expect(tileLayout(240)).toMatchObject({ columns: 1, axes: false, plot: SPARK_HEIGHT, compact: true })
    expect(tileLayout(280)).toEqual({ columns: 1, tile: 280, axes: true, plot: AXES_HEIGHT, compact: true })
    expect(tileLayout(320)).toMatchObject({ columns: 1, axes: true, plot: AXES_HEIGHT })
    /* Two columns from 360 px: CPU and Memory side by side, and never three. */
    expect(tileLayout(400)).toMatchObject({ columns: 2, tile: 199, axes: false, compact: false })
    expect(tileLayout(620)).toMatchObject({ columns: 2, tile: 309, axes: true })
    expect(tileLayout(1000)).toMatchObject({ columns: 2, axes: true })
    expect(tileLayout(null)).toMatchObject({ tile: null, axes: false, plot: SPARK_HEIGHT })
  })

  test('one column at 200–320 px stands no taller than it needs: 157 px at 240', () => {
    /* Two rows of 6 + 20 + 2 + 44 + 6 and one hairline. */
    expect(columnHeight(tileLayout(240))).toBe(157)
    expect(columnHeight(tileLayout(200))).toBe(157)
    expect(columnHeight(tileLayout(280))).toBe(2 * (6 + 20 + 2 + 72 + 6) + 1)
  })

  test('a pointer picks the nearest point of a line and the bar it is over, and stays inside the plot', () => {
    expect(indexAt(0, 200, 6, 'line')).toBe(0)
    expect(indexAt(95, 200, 6, 'line')).toBe(2)
    expect(indexAt(500, 200, 6, 'line')).toBe(5)
    expect(indexAt(-5, 200, 4, 'bar')).toBe(0)
    expect(indexAt(120, 200, 4, 'bar')).toBe(2)
    expect(indexAt(10, 0, 4, 'bar')).toBeNull()
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
      expect(screen.queryByTestId('tile-disk')).toBeNull()
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

  test('two columns: the words go under the title, CPU and Memory side by side, no disk', () => {
    draw(400)
    expect(screen.getByTestId('tiles').getAttribute('data-compact')).toBe('false')
    const [head, sub, plot] = [...screen.getByTestId('tile-cpu').children] as HTMLElement[]
    expect(head?.getAttribute('data-testid')).toBe('tile-cpu-head')
    expect(sub?.className).toContain('truncate')
    expect(plot?.getAttribute('data-testid')).toBe('tile-cpu-plot')
    expect(screen.getByTestId('tiles').className).toContain('@min-[360px]:grid-cols-2')
    expect(screen.getByTestId('tiles').className).not.toContain('grid-cols-3')
    expect(screen.getByTestId('tiles').children).toHaveLength(2)
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

  test('memory says its numbers', () => {
    const snapshot = snapshotOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} box={{ width: 320, height: 600 }} />)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(plotOf('tile-memory'))
    expect(tip('tile-memory').textContent).toBe(`960 MB6% of 16 GB${clock(NOW)}`)
  })
})
