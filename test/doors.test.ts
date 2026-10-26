import { describe, expect, test } from 'bun:test'

import { skillPath, skillTextIssue } from 'kehikot-module-protocol'

import { ASK, CLOCK, MANIFEST, answer, callerNamed, servingAt, trafficSaid } from '../doors.ts'
import { ID } from '../manifest.ts'
import { call, polling } from './fixtures.ts'

const NOW = 2_000_000_000
CLOCK.now = () => NOW

/** What the stand-in host was asked, and what it answers: the record, or a refusal. */
const asked: Record<string, unknown>[] = []
let refusal: { reason: string; error: string; refused?: string } | null = null
const RECORD = [...polling(NOW, 2000, 20), call({ at: NOW - 500, by: 'kehikko', side: 'out', via: 'server', kind: 'gh api', host: 'api.github.com', path: '/repos/a/b/releases', reason: 'GitHub releases: a/b', reported: 'host' })]

ASK.options = {
  env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:1' },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname !== '/host/server-ask') return Response.json({ ok: false }, { status: 404 })
    asked.push(JSON.parse(String(init?.body)))
    if (refusal) return Response.json({ ok: false, ...refusal })
    return Response.json({ ok: true, data: { calls: RECORD, newest: RECORD.length, oldest: 1, kept: 5000, started: 1, budgets: [{ name: 'GitHub API without an account', used: 3, limit: 30, left: 27, resets: null, note: '' }] } })
  }) as typeof fetch,
}

const none = new URLSearchParams()

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null)
  return reply?.body as { result: { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; content?: { text: string }[]; isError?: boolean } }
}

describe('the doors', () => {
  test('the health check says which module this is', async () => {
    const reply = await answer('GET', '/healthz', none, null, null)
    expect((reply?.body as { id: string }).id).toBe(ID)
  })

  test('a path that is not ours is left to Vite, and an unknown /api path is refused', async () => {
    expect(await answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
    expect((await answer('GET', '/api/nothing', none, null, null))?.status).toBe(404)
  })

  test('the MCP door lists one read-only tool, traffic', async () => {
    expect((await answer('GET', '/mcp', none, null, null))?.status).toBe(405)
    const tools = (await rpc('tools/list')).result.tools!
    expect(tools.map((one) => one.name)).toEqual(['traffic'])
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true)
  })

  test('traffic reads the host’s record as Monitor, about no project, and says what repeats', async () => {
    refusal = null
    asked.length = 0
    const said = await rpc('tools/call', { name: 'traffic', arguments: {} })
    expect(said.result.isError).toBeUndefined()
    const text = said.result.content![0]!.text
    expect(text).toContain('Kanban asks Kehikot /host/call (tracker.get) every 2 s — 20 times, getting the same answer each time')
    expect(text).toContain('GitHub API without an account: 3 used, 27 left of 30 an hour.')
    expect(asked[0]).toMatchObject({ module: ID, method: 'traffic.read' })
    expect(asked[0]).not.toHaveProperty('project')
  })

  test('a host that refuses says so in words, as an error the agent reads', async () => {
    refusal = { reason: 'failed', error: 'This module’s manifest does not ask for traffic:read.', refused: 'grant' }
    const said = await rpc('tools/call', { name: 'traffic', arguments: {} })
    expect(said.result.isError).toBe(true)
    expect(said.result.content![0]!.text).toContain('did not let Monitor read its traffic')
    refusal = null
  })

  test('each skill is served at its path, with the origin filled in and a text a host accepts', async () => {
    servingAt('http://127.0.0.1:8070')
    for (const skill of MANIFEST.declares.skills ?? []) {
      const reply = await answer('GET', skillPath(skill.name), none, null, null)
      const text = reply?.raw?.bytes as string
      expect(skillTextIssue(text, skill.name)).toBeNull()
      expect(text).toContain('http://127.0.0.1:8070')
      expect(text).toContain('mcp__monitor__traffic')
    }
  })
})

describe('what traffic says', () => {
  const read = { calls: RECORD, newest: RECORD.length, oldest: 1, gap: false, kept: 5000, started: 1, budgets: [], processes: null }

  test('one view at a time, a caller by id or name, words, and a sentence for a caller not seen', () => {
    expect(trafficSaid(read, { view: 'calls', caller: 'Kehikot' }, NOW)).toContain('Kehikot called gh api api.github.com/repos/a/b/releases')
    expect(trafficSaid(read, { view: 'calls', text: 'releases' }, NOW)).toContain('The newest 1 of 1 calls')
    expect(trafficSaid(read, { view: 'summary' }, NOW)).toContain('Kanban (kehikot.kanban): 20 calls')
    expect(trafficSaid(read, { view: 'repeats' }, NOW)).not.toContain('Callers in the last')
    expect(trafficSaid(read, { caller: 'Nobody' }, NOW)).toContain('No call by "Nobody"')
    expect(callerNamed('kanban', ['kehikot.kanban', 'kehikko'])).toBe('kehikot.kanban')
  })

  test('the limits: the account, Kehikot’s share and a pause, as the page says them; the old list from an older Kehikot', () => {
    const account = {
      login: 'Jalez',
      core: { limit: 5000, used: 188, remaining: 4812, resets: null, share: { limit: 1000, used: 312 }, floor: 500 },
      graphql: null,
      paused: true,
      why: "Kehikot's share of your GitHub limit is used until 11:00",
      until: null,
      at: NOW,
    }
    const anonymous = { name: 'GitHub without an account', used: 0, limit: 30, left: 30, resets: null, note: '' }
    const said = trafficSaid({ ...read, limits: { github: { account, anonymous }, gitlab: { account: { ...account, login: 'me', core: { ...account.core, share: null, floor: null }, paused: false, why: '' } } } }, { view: 'summary' }, NOW)
    expect(said).toContain('Limits Kehikot spends for you:')
    expect(said).toContain('- GitHub as Jalez: 4,812 of 5,000 left this hour.')
    expect(said).toContain("- Kehikot's share: 312 of 1,000 used.")
    expect(said).toContain("- Paused: Kehikot's share of your GitHub limit is used until 11:00.")
    expect(said).toContain('- GitLab as me: 4,812 of 5,000 left this hour.')
    expect(said).not.toContain('Without an account')
    const old = trafficSaid({ ...read, budgets: [{ ...anonymous, name: 'GitHub API without an account', used: 3, left: 27 }] }, { view: 'summary' }, NOW)
    expect(old).toContain('- GitHub API without an account: 3 used, 27 left of 30 an hour.')
  })

  test('a program Kehikot named, by its name or the start of it; sessions under their agent module', () => {
    const curl = call({ at: NOW - 300, by: '', via: 'process', path: '/host/health', caller: { kind: 'program', name: 'curl, from your terminal (zsh)', how: 'process', process: 'curl', parent: 'zsh' } })
    const session = call({ at: NOW - 200, by: 'kehikot.claude', via: 'process', path: '/mcp', caller: { kind: 'session', name: 'Claude session on Wide · methods', how: 'token', pid: 7 } })
    const named = { ...read, calls: [...RECORD, curl, session], newest: RECORD.length + 2 }
    expect(callerNamed('curl', ['~program:curl, from your terminal (zsh)'])).toBe('~program:curl, from your terminal (zsh)')
    expect(trafficSaid(named, { view: 'calls', caller: 'curl' }, NOW)).toContain('curl, from your terminal (zsh) asks GET Kehikot /host/health')
    const summary = trafficSaid(named, { view: 'summary' }, NOW)
    expect(summary).toContain('- Claude: 1 session (kehikot.claude): 1 calls')
    expect(summary).toContain('- curl, from your terminal (zsh): 1 calls')
    expect(summary.toLowerCase()).not.toContain('unknown')
  })
})
