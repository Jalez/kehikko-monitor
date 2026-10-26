import { describe, expect, test } from 'bun:test'

import { headerItemsSchema } from 'kehikot-module-protocol'

import { CALLERS_LISTED, EVERY, LABEL_FIT, callerOption, headerItems, keptStyle, pressed } from '../src/header.ts'

const state = { range: 5 as const, style: 'lines' as const, paused: false, caller: null, callers: ['kehikko', 'kehikot.kanban', ''] }

describe('the header', () => {
  test('range, pause and caller for agents; Clear is the person’s', () => {
    const items = headerItems(state)
    expect(headerItemsSchema.safeParse(items).success).toBe(true)
    expect(items.map((item) => [item.id, item.kind, item.agents === true])).toEqual([
      ['range', 'switch', true],
      ['style', 'switch', true],
      ['pause', 'toggle', true],
      ['caller', 'switch', true],
      ['clear', 'run', false],
    ])
  })

  test('every label reads in a narrow menu, however many callers', () => {
    const many = Array.from({ length: 30 }, (_, i) => `kehikot.a-module-with-a-very-long-name-${i}`)
    const items = headerItems({ ...state, callers: many })
    for (const item of items) {
      expect(item.label.length).toBeLessThanOrEqual(LABEL_FIT)
      if ('options' in item) for (const option of item.options) expect(option.label.length).toBeLessThanOrEqual(LABEL_FIT)
    }
    const caller = items.find((item) => item.id === 'caller')!
    expect('options' in caller && caller.options.length).toBe(CALLERS_LISTED + 1)
  })

  test('a press asks for what it says, and anything else is a sentence', () => {
    expect(pressed('range', 'm15', state.callers)).toEqual({ range: 15 })
    expect(pressed('range', 'm7', state.callers)).toBeTypeOf('string')
    expect(pressed('pause', true, state.callers)).toEqual({ paused: true })
    expect(pressed('style', 'bars', state.callers)).toEqual({ style: 'bars' })
    expect(pressed('style', 'pie', state.callers)).toBeTypeOf('string')
    expect(pressed('caller', EVERY, state.callers)).toEqual({ caller: null })
    expect(pressed('caller', callerOption('kehikot.kanban'), state.callers)).toEqual({ caller: 'kehikot.kanban' })
    expect(pressed('caller', callerOption(''), state.callers)).toEqual({ caller: '' })
    expect(pressed('caller', 'kehikot.none', state.callers)).toBeTypeOf('string')
    expect(pressed('clear', undefined, state.callers)).toEqual({ clear: true })
    expect(pressed('nothing', undefined, state.callers)).toBeTypeOf('string')
  })

  test('Chart: lines, bars or area, lines by default, and what is kept is read back or ignored', () => {
    const chart = headerItems(state).find((item) => item.id === 'style')!
    expect(chart).toMatchObject({ kind: 'switch', label: 'Chart', agents: true, value: 'lines' })
    expect('options' in chart && chart.options.map((one) => one.label)).toEqual(['Lines', 'Bars', 'Area'])
    expect(headerItems({ ...state, style: 'area' }).find((item) => item.id === 'style')).toMatchObject({ value: 'area' })
    expect(keptStyle({ style: 'bars' })).toBe('bars')
    expect(keptStyle(null)).toBe('lines')
    expect(keptStyle({ style: 'pie' })).toBe('lines')
    expect(keptStyle('bars')).toBe('lines')
  })
})
