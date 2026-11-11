import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workQueueSchema } from 'kehikot-module-protocol'

import { heavyOutside, heavyWord, outsideSaid, parseProcLines, sessionFrom, type Outside } from '../src/health/heavy.ts'

/* What a work-queue provider's descriptor says its runs are known by: here, made up. */
const WRAP = '"$@"; c=$?; printf %s "$c" > "$0"; exit $c'
const MARKS = [WRAP, 'turns-cli']
import { healthSaid, judged } from '../src/health/model.ts'
import { healthItems } from '../src/footer.ts'
import { HealthView } from '../src/view/health.tsx'
import { HEAVY_MS, Sampler, type Deps } from '../health/sampler.ts'
import { snapshotOf } from './health-fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000

describe('what is heavy work, by its program', () => {
  test('a typecheck, a test suite, browser tests, a build, an install', () => {
    expect(heavyWord('node /w/app/node_modules/typescript/bin/tsc --noEmit')).toBe('tsc')
    expect(heavyWord('/w/app/node_modules/.bin/tsc -b')).toBe('tsc')
    expect(heavyWord('node /w/app/node_modules/vitest/vitest.mjs run')).toBe('vitest')
    expect(heavyWord('npx vitest')).toBe('vitest')
    expect(heavyWord('/opt/homebrew/bin/bun test')).toBe('bun test')
    expect(heavyWord('node /w/node_modules/@playwright/test/cli.js test')).toBe('playwright')
    expect(heavyWord('bunx playwright test --project chromium')).toBe('playwright')
    expect(heavyWord('node /w/node_modules/vite/bin/vite.js build')).toBe('vite build')
    expect(heavyWord('bun install --frozen-lockfile')).toBe('bun install')
    expect(heavyWord('npm ci')).toBe('npm ci')
  })
  test('not a shell\'s line that names one, not a dev server, not a lookup', () => {
    expect(heavyWord('/bin/zsh -c tsc --noEmit')).toBeNull()
    expect(heavyWord('grep -n tsc package.json')).toBeNull()
    expect(heavyWord('node /w/node_modules/vite/bin/vite.js')).toBeNull()
    expect(heavyWord('bun run dev')).toBeNull()
    expect(heavyWord('npx playwright install')).toBeNull()
  })
})

describe('outside the work queue, and whose', () => {
  const ps = (lines: Array<[number, number, number, string]>) => lines.map(([pid, ppid, cpu, args]) => `${pid} ${ppid} ${cpu} ${args}`).join('\n')
  test('a tsc under an agent CLI\'s shell is flagged, with its children\'s CPU, under that session', () => {
    const procs = parseProcLines(ps([
      [100, 1, 2, 'claude'],
      [200, 100, 0, '/bin/zsh -c tsc --noEmit'],
      [300, 200, 150, 'node /w/node_modules/typescript/bin/tsc --noEmit'],
      [301, 300, 20, 'node /w/node_modules/typescript/lib/worker.js'],
    ]))
    expect(heavyOutside(procs)).toEqual([{ pid: 300, word: 'tsc', kind: 'typecheck', pcpu: 170, sessionPid: 100, agent: 'claude', session: null }])
  })
  test('the same under a run of the provider, or under its CLI, by its marks, is not; with no provider, it is', () => {
    const procs = parseProcLines(ps([
      [100, 1, 2, '/Users/x/.local/bin/claude --resume abc'],
      [150, 100, 0, `/bin/sh -c ${WRAP} /q/exit/r1 bun test`],
      [160, 150, 90, 'bun test'],
      [200, 100, 0, 'bun /q/bin/turns-cli.ts run -- tsc'],
      [210, 200, 90, 'tsc'],
    ]))
    expect(heavyOutside(procs, 0, MARKS)).toEqual([])
    expect(heavyOutside(procs).map((one) => one.pid).sort()).toEqual([160, 210])
  })
  test('a person\'s own terminal is theirs: not flagged; Monitor itself never is', () => {
    const procs = parseProcLines(ps([
      [100, 1, 0, '/bin/zsh -l'],
      [110, 100, 90, 'bun test'],
    ]))
    expect(heavyOutside(procs)).toEqual([])
    expect(heavyOutside(parseProcLines(ps([[100, 1, 0, 'codex'], [7, 100, 50, 'bun test']])), 7)).toEqual([])
  })
  test('a test runner\'s own workers are part of it, not more work', () => {
    const procs = parseProcLines(ps([
      [100, 1, 0, 'codex exec'],
      [200, 100, 30, 'node /w/node_modules/vitest/vitest.mjs run'],
      [210, 200, 80, 'node /w/node_modules/vitest/vitest.mjs run --worker'],
    ]))
    expect(heavyOutside(procs)).toEqual([expect.objectContaining({ pid: 200, word: 'vitest', pcpu: 110, agent: 'codex' })])
  })
  test('the session\'s id is only its variable, read from the environment line', () => {
    expect(sessionFrom('bun test PATH=/bin SECRET_TOKEN=xyz CLAUDE_CODE_SESSION_ID=9186314e-8c95 HOME=/u')).toBe('9186314e-8c95')
    expect(sessionFrom('bun test KEHIKOT_SESSION_ID=mine CLAUDE_CODE_SESSION_ID=other')).toBe('mine')
    expect(sessionFrom('bun test PATH=/bin')).toBeNull()
  })
  test('said in one line: the kind, the session, the CPU — never a command line', () => {
    const one: Outside = { pid: 3, word: 'tsc', kind: 'typecheck', pcpu: 170, sessionPid: 100, agent: 'claude', session: '9186314e-8c95' }
    expect(outsideSaid([one], 'Turns')).toBe('Heavy work running outside Turns: tsc from claude session 9186314e (170% CPU)')
    expect(outsideSaid([one])).toBe('Heavy work running outside a work queue: tsc from claude session 9186314e (170% CPU)')
    expect(outsideSaid([{ ...one, session: null }])).toContain('tsc from claude session (pid 100)')
    expect(outsideSaid([])).toBe('')
  })
})

describe('where it is said', () => {
  const outside: Outside[] = [{ pid: 3, word: 'vitest', kind: 'test', pcpu: 240, sessionPid: 100, agent: 'claude', session: 'abcdef1234' }]
  test('the health tool and the footer; the Health view keeps no strip for it', () => {
    const snapshot = { ...snapshotOf(NOW), outside, provider: 'Turns' }
    expect(healthSaid(snapshot, NOW)).toContain('Heavy work running outside Turns: vitest from claude session abcdef12 (240% CPU).')
    expect(healthItems({ snapshot, judged: judged(snapshot, NOW) })).toContainEqual(expect.objectContaining({ id: 'outside', text: '1 heavy run outside Turns', level: 'warn' }))
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} />)
    expect(screen.queryByTestId('outside')).toBeNull()
    expect(document.body.textContent).not.toContain('Heavy work')
  })
  test('nothing outside, nothing said', () => {
    const snapshot = snapshotOf(NOW)
    expect(healthSaid(snapshot, NOW)).not.toContain('Heavy work')
    expect(healthItems({ snapshot, judged: judged(snapshot, NOW) }).some((one) => (one as { id: string }).id === 'outside')).toBe(false)
  })
})

describe('the sampler looks, cheaply', () => {
  test('one process list every HEAVY_MS while watched; a flagged process\'s environment once, for its session alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'monitor-heavy-'))
    let clock = NOW
    const ran: string[] = []
    const deps: Deps = {
      now: () => clock,
      env: { KEHIKOT_MODULES_DIR: join(home, 'none'), KEHIKOT_LOGS_DIR: join(home, 'none'), KEHIKOT_INSTALLS_DIR: join(home, 'none'), KEHIKOT_VERSIONS_DIR: join(home, 'none'), KEHIKOT_FRAME_DB: join(home, 'none.sqlite') },
      home,
      cores: 8,
      memory: 16e9,
      pid: 900,
      run: async (file, args) => {
        ran.push(`${file} ${args.join(' ')}`)
        if (file === 'ps' && args.includes('-E')) return 'node /w/tsc --noEmit PATH=/bin CLAUDE_CODE_SESSION_ID=sess-1234-5678 GH_TOKEN=nope'
        if (file === 'ps' && args.includes('pid=,ppid=,pcpu=,args=')) return '100 1 1.0 claude\n300 100 120.0 node /w/node_modules/typescript/bin/tsc --noEmit\n'
        if (file === 'ps') return '100 1 1000 0:01\n300 100 2000 0:30\n900 1 4096 0:00.10\n'
        if (file === 'lsof') return ''
        if (file === 'df') return 'h\n/dev/x 100 50 40 50% /'
        return ''
      },
    }
    /* A provider that wants a typecheck at once (made up: Monitor knows none by name). */
    const descriptor = workQueueSchema.parse({ name: 'Turns', run: { typecheck: 't {command}' }, wants: { typecheck: { sustainedSeconds: 0 } } })
    deps.ask = async (method) => (method === 'services.find' ? { ok: true, data: { providers: [{ module: 'kehikot.turns', name: 'Turns', descriptor, placed: null }] } } : { ok: true, data: { outcome: 'declined' } })
    const sampler = new Sampler(deps)
    try {
      const first = await sampler.snapshot()
      expect(first.outside).toEqual([{ pid: 300, word: 'tsc', kind: 'typecheck', pcpu: 120, sessionPid: 100, agent: 'claude', session: 'sess-1234-5678' }])
      clock += 1_000
      await sampler.snapshot()
      clock += HEAVY_MS
      await sampler.snapshot()
      expect(ran.filter((one) => one.includes('pcpu=,args='))).toHaveLength(2)
      expect(ran.filter((one) => one.includes('-E'))).toHaveLength(1)
      expect(JSON.stringify(await sampler.snapshot())).not.toContain('GH_TOKEN')
    } finally {
      sampler.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
