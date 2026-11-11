import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WORK_QUEUE, workQueueSchema } from 'kehikot-module-protocol'

import { HEAVY_MS, Sampler, type Deps } from '../health/sampler.ts'
import { shortCommand } from '../src/health/heavy.ts'
import { TELL_AGAIN_MS } from '../src/health/tell.ts'
import { headerItems, pressed } from '../src/header.ts'
import { tellUrl } from '../src/wire/use-health.ts'

/**
 * Telling the agent session that started heavy work on its own how to hand it to the work queue here —
 * only with a provider of the protocol's work-queue service, in its descriptor's words.
 */

const NOW = 2_000_000_000
const SESSION = 'sess-1234-5678-9abc'

/* A provider as `services.find` answers it. Made up: Monitor knows none by name. */
const TURNS = workQueueSchema.parse({
  name: 'Turns',
  run: { test: "'/t/bin/turns' run --kind verify -- {command}", typecheck: "'/t/bin/turns' run --kind typecheck -- {command}" },
  tool: 'turns_run',
  marks: ['turns-wrapper'],
  /* Wanted at once, so these tests are about telling; what is wanted is below. */
  wants: { test: { minCpu: 50, sustainedSeconds: 0, wholeSuiteOnly: false }, typecheck: { minCpu: 50, sustainedSeconds: 0 } },
})

interface World {
  providers: unknown[] | null
  /** What `ps -A -o pid=,ppid=,pcpu=,args=` says. */
  procs: string
  /** What `ps -E` says of a flagged process. */
  env: string
  /** What the host answers a notice with. */
  outcome: 'sent' | 'declined'
}

function sampler(world: World) {
  const home = mkdtempSync(join(tmpdir(), 'monitor-tell-'))
  let clock = NOW
  const notices: Array<Record<string, unknown>> = []
  const asked: string[] = []
  const none = join(home, 'none')
  const deps: Deps = {
    now: () => clock,
    env: { KEHIKOT_MODULES_DIR: none, KEHIKOT_LOGS_DIR: none, KEHIKOT_INSTALLS_DIR: none, KEHIKOT_VERSIONS_DIR: none, KEHIKOT_FRAME_DB: join(home, 'none.sqlite') },
    home,
    cores: 8,
    memory: 16e9,
    pid: 900,
    run: async (file, args) => {
      if (file === 'ps' && args.includes('-E')) return world.env
      if (file === 'ps' && args.includes('pid=,ppid=,pcpu=,args=')) return world.procs
      if (file === 'ps') return '100 1 1000 0:01\n'
      return ''
    },
    ask: async (method, params) => {
      asked.push(method)
      if (method === 'services.find') return world.providers ? { ok: true, data: { providers: world.providers } } : { ok: false }
      notices.push(params)
      return { ok: true, data: { outcome: world.outcome, id: world.outcome === 'sent' ? notices.length : null, why: world.outcome === 'sent' ? '' : 'The person muted this module’s messages.' } }
    },
  }
  const one = new Sampler(deps)
  return {
    one,
    notices,
    asked,
    /** Later by `ms`, and looked again. */
    async after(ms: number, tell?: boolean) {
      clock += ms
      return one.snapshot(tell)
    },
    done() {
      one.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const VITEST = '100 1 1.0 claude\n300 100 95.0 node /Users/p/app/node_modules/.bin/vitest run src --reporter=dot GH_TOKEN=abc\n'
const world = (more: Partial<World> = {}): World => ({
  providers: [{ module: 'kehikot.turns', name: 'Turns', descriptor: TURNS, placed: null }],
  procs: VITEST,
  env: `node vitest PATH=/bin CLAUDE_CODE_SESSION_ID=${SESSION}`,
  outcome: 'sent',
  ...more,
})

describe('telling the session', () => {
  test('heavy work it started → one notice, to that session, in the provider’s words, with its command shortened', async () => {
    const s = sampler(world())
    try {
      const first = await s.one.snapshot()
      expect(first.provider).toBe('Turns')
      expect(s.notices).toEqual([
        {
          session: SESSION,
          kind: 'report',
          body: "vitest is running outside Turns (95% CPU): `node vitest run src --reporter=dot GH_TOKEN=…`. Run it through Turns: `'/t/bin/turns' run --kind verify -- node vitest run src --reporter=dot GH_TOKEN=…` from the same folder, or with the turns_run tool.",
        },
      ])
      /* The same run, looked at again and again: once. */
      await s.after(HEAVY_MS)
      await s.after(HEAVY_MS)
      expect(s.notices).toHaveLength(1)
      /* Never shown: the command line is in no snapshot. */
      expect(JSON.stringify(await s.after(1))).not.toContain('reporter')
    } finally {
      s.done()
    }
  })

  test('a new run of the same kind is told again only after the window', async () => {
    const w = world()
    const s = sampler(w)
    try {
      await s.one.snapshot()
      w.procs = '100 1 1.0 claude\n301 100 95.0 vitest run\n'
      await s.after(HEAVY_MS)
      expect(s.notices).toHaveLength(1)
      w.procs = '100 1 1.0 claude\n302 100 95.0 vitest run\n'
      await s.after(TELL_AGAIN_MS)
      expect(s.notices).toHaveLength(2)
      expect(s.notices[1]!.body).toContain('`vitest run`')
    } finally {
      s.done()
    }
  })

  test('muted: the host declines it, and Monitor does not ask again for that run', async () => {
    const s = sampler(world({ outcome: 'declined' }))
    try {
      await s.one.snapshot()
      await s.after(HEAVY_MS)
      await s.after(HEAVY_MS)
      expect(s.notices).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('work it cannot attribute — no agent above it, or no session id — is told to no one', async () => {
    const mine = sampler(world({ procs: '100 1 0 /bin/zsh -l\n300 100 95.0 vitest run\n' }))
    const nameless = sampler(world({ env: 'node vitest PATH=/bin' }))
    try {
      await mine.one.snapshot()
      await nameless.one.snapshot()
      expect(mine.notices).toEqual([])
      expect(nameless.notices).toEqual([])
      expect((await nameless.after(1)).outside).toHaveLength(1)
    } finally {
      mine.done()
      nameless.done()
    }
  })

  test('"Tell agents" off → nothing is told; on again → it is', async () => {
    const s = sampler(world())
    try {
      await s.one.snapshot(false)
      await s.after(HEAVY_MS, false)
      expect(s.notices).toEqual([])
      await s.after(HEAVY_MS, true)
      expect(s.notices).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('no provider, or an older host → nothing is flagged, and nothing is told', async () => {
    const s = sampler(world({ providers: null }))
    const empty = sampler(world({ providers: [] }))
    try {
      const said = await s.one.snapshot()
      await empty.one.snapshot()
      expect(said.provider).toBeNull()
      expect(said.outside).toEqual([])
      expect(s.notices).toEqual([])
      expect(empty.notices).toEqual([])
    } finally {
      s.done()
      empty.done()
    }
  })

  test('a provider that does not take that kind of work → not flagged, nothing is told', async () => {
    const s = sampler(world({ procs: '100 1 1.0 claude\n300 100 95.0 bun install\n' }))
    try {
      const said = await s.one.snapshot()
      expect(said.outside).toEqual([])
      expect(s.notices).toEqual([])
    } finally {
      s.done()
    }
  })

  test('a provider’s own runs, known by its marks, are not flagged', async () => {
    const s = sampler(world({ procs: '100 1 1.0 claude\n200 100 0 sh -c turns-wrapper x\n300 200 95.0 vitest run\n' }))
    try {
      expect((await s.one.snapshot()).outside).toEqual([])
      expect(s.notices).toEqual([])
    } finally {
      s.done()
    }
  })
})

/* A provider with rules of its own: whole test suites at 50% for 15 s, typechecks and builds at 80% for 10 s, installs left out. */
const RULED = workQueueSchema.parse({
  name: 'Turns',
  run: { test: "'/t/bin/turns' run -- {command}", typecheck: "'/t/bin/turns' run -- {command}", build: "'/t/bin/turns' run -- {command}", install: "'/t/bin/turns' run -- {command}" },
  marks: ['turns-wrapper'],
  wants: { test: { minCpu: 50, sustainedSeconds: 15, wholeSuiteOnly: true }, typecheck: { minCpu: 80, sustainedSeconds: 10 }, build: { minCpu: 80, sustainedSeconds: 10 } },
})
const ruled = (procs: string) => world({ providers: [{ module: 'kehikot.turns', name: 'Turns', descriptor: RULED, placed: null }], procs })
const under = (line: string, pcpu: number) => `100 1 1.0 claude\n300 100 ${pcpu} ${line}\n`

describe('only what the provider wants', () => {
  test('a targeted test run is not flagged, however long and hard it runs', async () => {
    const s = sampler(ruled(under('bun test test/a.test.tsx test/b.test.tsx', 68)))
    try {
      await s.one.snapshot()
      for (let i = 0; i < 6; i++) expect((await s.after(HEAVY_MS)).outside).toEqual([])
      expect(s.notices).toEqual([])
    } finally {
      s.done()
    }
  })

  test('a whole suite at high CPU is flagged once it has held long enough, and told', async () => {
    const s = sampler(ruled(under('bun test', 68)))
    try {
      expect((await s.one.snapshot()).outside).toEqual([])
      expect((await s.after(10_000)).outside).toEqual([])
      const said = await s.after(5_000)
      expect(said.outside?.map((one) => one.word)).toEqual(['bun test'])
      expect(s.notices).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('an install the provider leaves out is never flagged', async () => {
    const s = sampler(ruled(under('bun install', 1)))
    try {
      await s.one.snapshot()
      expect((await s.after(60_000)).outside).toEqual([])
      expect(s.notices).toEqual([])
    } finally {
      s.done()
    }
  })

  test('a sustained typecheck is flagged', async () => {
    const s = sampler(ruled(under('node /w/node_modules/typescript/bin/tsc --noEmit', 145)))
    try {
      expect((await s.one.snapshot()).outside).toEqual([])
      expect((await s.after(HEAVY_MS)).outside).toEqual([])
      expect((await s.after(HEAVY_MS)).outside?.map((one) => one.word)).toEqual(['tsc'])
      expect(s.notices).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('a short spike is not: dropping below the rule starts the streak over', async () => {
    const w = ruled(under('tsc --noEmit', 145))
    const s = sampler(w)
    try {
      await s.one.snapshot()
      w.procs = under('tsc --noEmit', 20)
      expect((await s.after(HEAVY_MS)).outside).toEqual([])
      w.procs = under('tsc --noEmit', 145)
      expect((await s.after(HEAVY_MS)).outside).toEqual([])
      w.procs = ''
      expect((await s.after(HEAVY_MS)).outside).toEqual([])
      expect(s.notices).toEqual([])
    } finally {
      s.done()
    }
  })
})

describe('the command line, shortened', () => {
  test('programs by name, secrets hidden, one line, bounded', () => {
    expect(shortCommand('/usr/local/bin/node /w/node_modules/typescript/bin/tsc --noEmit -p .')).toBe('node tsc --noEmit -p .')
    expect(shortCommand('bun test API_KEY=xyz --token=abc src/a.test.ts')).toBe('bun test API_KEY=… --token=… src/a.test.ts')
    expect(shortCommand(`vitest ${'x'.repeat(400)}`)).toHaveLength(160)
  })
})

describe('the setting', () => {
  test('a header toggle in Health, on by default, the person’s, kept', () => {
    const base = { view: 'health' as const, range: 5 as const, style: 'lines' as const, paused: false, caller: null, callers: [] }
    expect(headerItems(base)).toContainEqual({ kind: 'toggle', id: 'tell', label: 'Tell agents', agents: false, checked: true })
    expect(headerItems({ ...base, tell: false })).toContainEqual({ kind: 'toggle', id: 'tell', label: 'Tell agents', agents: false, checked: false })
    expect(pressed('tell', false, [])).toEqual({ tell: false })
    expect(typeof pressed('tell', 'x', [])).toBe('string')
    expect(tellUrl('/api/health', false)).toBe('/api/health?tell=0')
    expect(tellUrl('/api/health', true)).toBe('/api/health')
  })
})

describe('Monitor names no provider', () => {
  test('no word of the provider in its code: only the protocol’s service name', () => {
    const root = resolve(import.meta.dir, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    for (const dir of ['src', 'health']) walk(join(root, dir))
    files.push(...['doors.ts', 'manifest.ts', 'skills.ts', 'serve.ts'].map((name) => join(root, name)))
    for (const file of files) {
      /* `WORK_QUEUE`, `workQueue…` and `wantsQueued` are the protocol's own names for the service; "a work queue" is said when none is here. */
      const text = readFileSync(file, 'utf8').replace(/\bWORK_QUEUE\b|\bworkQueue\w*|\bWorkQueue\b|\bwantsQueued\b|\ba work queue\b/g, '')
      expect({ file, queue: /queue/i.test(text) }).toEqual({ file, queue: false })
    }
    expect(WORK_QUEUE).toBe('work.queue')
  })
})
