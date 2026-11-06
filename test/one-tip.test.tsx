import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { judged } from '../src/health/model.ts'
import { TOUCH_MS, resetTips } from '../src/lib/one-tip.ts'
import { HealthView } from '../src/view/health.tsx'
import { Timeline } from '../src/view/timeline.tsx'
import { snapshotOf } from './health-fixtures.ts'
import { polling } from './fixtures.ts'

/*
 * Chart tooltips no longer stay on screen (Monitor 0.10.x): one tooltip on the page at a time, gone
 * when the pointer leaves the plot or the page, and shown by focus only from the keyboard.
 */

const NOW = 2_000_000_000

beforeEach(resetTips)
afterEach(cleanup)

const draw = () => {
  const snapshot = snapshotOf(NOW)
  render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} box={{ width: 320, height: 600 }} />)
}
const plotOf = (id: string) => {
  const el = within(screen.getByTestId(`${id}-plot`)).getAllByRole('img')[0] as HTMLElement
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) })
  return el
}
const tip = (id: string) => screen.getByTestId(`${id}-tip`).textContent
const hover = (el: HTMLElement) => fireEvent.pointerMove(el, { pointerType: 'mouse', clientX: 100, clientY: 20 })

describe('one chart tooltip, and only while it is wanted', () => {
  test('leaving the plot hides it', () => {
    draw()
    const cpu = plotOf('tile-cpu')
    hover(cpu)
    expect(tip('tile-cpu')).not.toBe('')
    fireEvent.pointerLeave(cpu, { pointerType: 'mouse' })
    expect(tip('tile-cpu')).toBe('')
  })

  test('the pointer leaving the page (the module) hides it', () => {
    draw()
    const cpu = plotOf('tile-cpu')
    hover(cpu)
    expect(tip('tile-cpu')).not.toBe('')
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))
    })
    expect(tip('tile-cpu')).toBe('')
    hover(cpu)
    expect(tip('tile-cpu')).not.toBe('')
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', relatedTarget: null }))
    })
    expect(tip('tile-cpu')).toBe('')
  })

  test('the window losing focus, a scroll, a resize and Escape each hide it', () => {
    draw()
    const cpu = plotOf('tile-cpu')
    for (const away of [() => window.dispatchEvent(new Event('blur')), () => window.dispatchEvent(new Event('scroll')), () => window.dispatchEvent(new Event('resize')), () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))]) {
      hover(cpu)
      expect(tip('tile-cpu')).not.toBe('')
      act(away)
      expect(tip('tile-cpu')).toBe('')
    }
  })

  test('showing a second hides the first', () => {
    draw()
    hover(plotOf('tile-cpu'))
    expect(tip('tile-cpu')).not.toBe('')
    hover(plotOf('tile-memory'))
    expect(tip('tile-memory')).not.toBe('')
    expect(tip('tile-cpu')).toBe('')
  })

  test('a click that focuses a chart leaves no tooltip once the pointer goes', () => {
    draw()
    const cpu = plotOf('tile-cpu')
    fireEvent.pointerDown(cpu, { pointerType: 'mouse', clientX: 100, clientY: 20 })
    fireEvent.focus(cpu)
    expect(tip('tile-cpu')).not.toBe('')
    fireEvent.pointerLeave(cpu, { pointerType: 'mouse' })
    expect(tip('tile-cpu')).toBe('')
    /* Focus from that click raises nothing by itself. */
    fireEvent.blur(cpu)
    fireEvent.focus(cpu)
    expect(tip('tile-cpu')).toBe('')
  })

  test('keyboard focus still shows it, and blur hides it', () => {
    draw()
    const cpu = plotOf('tile-cpu')
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(cpu)
    expect(tip('tile-cpu')).toContain('134% CPU')
    fireEvent.keyDown(cpu, { key: 'ArrowLeft' })
    expect(tip('tile-cpu')).not.toBe('')
    fireEvent.blur(cpu)
    expect(tip('tile-cpu')).toBe('')
  })

  test('a tap shows it; a tap elsewhere or the time hides it', () => {
    jest.useFakeTimers()
    draw()
    const cpu = plotOf('tile-cpu')
    fireEvent.pointerDown(cpu, { pointerType: 'touch', clientX: 100, clientY: 20 })
    fireEvent.pointerLeave(cpu, { pointerType: 'touch' })
    expect(tip('tile-cpu')).not.toBe('')
    fireEvent.pointerDown(document.body, { pointerType: 'touch' })
    expect(tip('tile-cpu')).toBe('')
    fireEvent.pointerDown(cpu, { pointerType: 'touch', clientX: 100, clientY: 20 })
    expect(tip('tile-cpu')).not.toBe('')
    act(() => {
      jest.advanceTimersByTime(TOUCH_MS + 1)
    })
    expect(tip('tile-cpu')).toBe('')
    jest.useRealTimers()
  })

  test('the timeline takes the page tooltip from a tile while the pointer is on it', () => {
    draw()
    hover(plotOf('tile-cpu'))
    expect(tip('tile-cpu')).not.toBe('')
    render(<Timeline calls={polling(NOW, 2000, 20)} range={5} order={['kehikot.kanban']} only={null} now={NOW} />)
    fireEvent.pointerMove(screen.getByTestId('timeline-chart'), { pointerType: 'mouse' })
    expect(tip('tile-cpu')).toBe('')
  })
})
