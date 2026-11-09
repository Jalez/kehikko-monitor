import { describe, expect, test } from 'bun:test'

import { onScreen } from '../src/wire/use-on-screen.ts'

describe('Monitor reads only while it is on screen', () => {
  test('shown by the host and in a window that is not hidden', () => {
    expect(onScreen(true, false)).toBe(true)
  })
  test('a host before kehikot.visible says nothing: shown', () => {
    expect(onScreen(undefined, false)).toBe(true)
  })
  test('kept hidden by the host, or the window hidden: not read', () => {
    expect(onScreen(false, false)).toBe(false)
    expect(onScreen(true, true)).toBe(false)
  })
})
