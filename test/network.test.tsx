import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CLOCK, NETWORK, answer, tools } from '../doors.ts'
import { NET_EVERY_MS, NetworkSampler, TOP_MS, type NetDeps } from '../health/network.ts'
import { footerItems } from '../src/footer.ts'
import { judged } from '../src/health/model.ts'
import {
  HISTORY_MS,
  emptyNet,
  grew,
  isPhysical,
  kept,
  networkSaid,
  ownerOf,
  parseComm,
  parseNetstat,
  parseNettop,
  parseProcNetDev,
  rateOf,
  rateSaid,
  ratesSaid,
  topOf,
  type NetSnapshot,
} from '../src/health/network.ts'
import { resetTips } from '../src/lib/one-tip.ts'
import { HealthView } from '../src/view/health.tsx'
import { AXES_HEIGHT, SPARK_HEIGHT, networkLayout, networkTip } from '../src/view/tiles.ts'
import { readNetwork } from '../src/wire/use-network.ts'
import { snapshotOf } from './health-fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      198310581     0 246982685234 198310581     0 246982685234     0
lo0        16384 127           127.0.0.1       198310581     - 246982685234 198310581     - 246982685234     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#14>   a6:87:69:c5:f3:e2 55142858     0 46461705948 38181502     0 17631085610     0
en0        1500  fe80::a1:49 fe80:e::a1:498d:8 55142858     - 46461705948 38181502     - 17631085610     -
utun3      1380  <Link#20>                          100     0     500000      100     0     400000     0
`

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000    100    0    0    0     0          0         0  1000000    100    0    0    0     0       0          0
  eth0: 5000000   4000    0    0    0     0          0         0  2000000   3000    0    0    0     0       0          0
docker0:  300000    10    0    0    0     0          0         0   300000     10    0    0    0     0       0          0
`

/** A network snapshot with `count` points every 2 s up to `now`. */
function netOf(now: number, over: Partial<NetSnapshot> = {}, count = 30): NetSnapshot {
  const points = Array.from({ length: count }, (_, i) => ({ at: now - (count - 1 - i) * 2000, down: 2_400_000 + i * 1000, up: 120_000 }))
  return { ...emptyNet(), at: now, down: 2_400_000, up: 120_000, points, interfaces: ['en0'], ...over }
}

describe('counters and rates', () => {
  test('netstat: one line per interface, counted from the right, the down marker dropped', () => {
    expect(parseNetstat(NETSTAT)).toEqual([
      { name: 'lo0', rx: 246982685234, tx: 246982685234 },
      { name: 'gif0', rx: 0, tx: 0 },
      { name: 'en0', rx: 46461705948, tx: 17631085610 },
      { name: 'utun3', rx: 500000, tx: 400000 },
    ])
  })

  test('/proc/net/dev on Linux: received and sent bytes', () => {
    expect(parseProcNetDev(PROC_NET_DEV)).toEqual([
      { name: 'lo', rx: 1000000, tx: 1000000 },
      { name: 'eth0', rx: 5000000, tx: 2000000 },
      { name: 'docker0', rx: 300000, tx: 300000 },
    ])
  })

  test('loopback and virtual interfaces are left out; real ones are kept', () => {
    for (const name of ['lo0', 'lo', 'utun3', 'awdl0', 'llw0', 'bridge0', 'docker0', 'veth12', 'gif0', 'anpi1']) expect(isPhysical(name)).toBe(false)
    for (const name of ['en0', 'en7', 'eth0', 'wlan0', 'wlp2s0', 'enp3s0']) expect(isPhysical(name)).toBe(true)
  })

  test('a rate is the growth over the seconds between, over the physical interfaces only', () => {
    const before = [{ name: 'en0', rx: 1_000_000, tx: 500_000 }, { name: 'lo0', rx: 0, tx: 0 }, { name: 'utun3', rx: 0, tx: 0 }]
    const after = [{ name: 'en0', rx: 5_000_000, tx: 700_000 }, { name: 'lo0', rx: 9e9, tx: 9e9 }, { name: 'utun3', rx: 4_000_000, tx: 200_000 }]
    expect(rateOf(before, after, 2)).toEqual({ down: 2_000_000, up: 100_000 })
    expect(rateOf(before, after, 0)).toEqual({ down: 0, up: 0 })
  })

  test('a 32-bit counter that wrapped is counted round; a reset counts nothing', () => {
    expect(grew(2 ** 32 - 1000, 500)).toBe(1500)
    /* A 64-bit counter that went back to a small number: the interface came back, nothing is invented. */
    expect(grew(50_000_000_000, 1000)).toBe(0)
    expect(grew(3_000_000_000, 1_000_000_000)).toBe(0)
    expect(rateOf([{ name: 'en0', rx: 2 ** 32 - 1000, tx: 10 }], [{ name: 'en0', rx: 1000, tx: 10 }], 1)).toEqual({ down: 2000, up: 0 })
  })

  test('an interface that appears is counted from its second reading; one that goes is dropped', () => {
    const before = [{ name: 'en0', rx: 100, tx: 100 }, { name: 'en5', rx: 100, tx: 100 }]
    const after = [{ name: 'en0', rx: 300, tx: 200 }, { name: 'en7', rx: 9_000_000, tx: 9_000_000 }]
    expect(rateOf(before, after, 1)).toEqual({ down: 200, up: 100 })
  })

  test('rates in words, decimal units', () => {
    expect(rateSaid(0)).toBe('0 B/s')
    expect(rateSaid(820)).toBe('820 B/s')
    expect(rateSaid(120_000)).toBe('120 kB/s')
    expect(rateSaid(2_400_000)).toBe('2.4 MB/s')
    expect(rateSaid(1_100_000_000)).toBe('1.1 GB/s')
    expect(ratesSaid({ down: 2_400_000, up: 120_000 })).toBe('↓ 2.4 MB/s · ↑ 120 kB/s')
    expect(ratesSaid({ down: null, up: null })).toBe('')
  })
})

describe('the history', () => {
  test('keeps five minutes and drops what is older', () => {
    let points: { at: number; down: number; up: number }[] = []
    for (let at = 0; at <= 10 * 60_000; at += 2000) points = kept(points, { at, down: 1, up: 1 })
    expect(points.at(-1)!.at).toBe(10 * 60_000)
    expect(points[0]!.at).toBeGreaterThan(10 * 60_000 - HISTORY_MS)
    expect(points).toHaveLength(HISTORY_MS / 2000)
  })
})

describe('the busiest processes', () => {
  const before = parseNettop(',bytes_in,bytes_out,\nzen.68424,1000,500,\n2.1.319.11608,0,0,\nbun.500,0,0,\ngone.77,10,10,\n')
  const after = parseNettop(',bytes_in,bytes_out,\nzen.68424,21000,1500,\n2.1.319.11608,4000,8000,\nbun.500,600,0,\nnew.88,9000000,0,\n')

  test('nettop is read by name and pid; a rate is the growth, the busiest first, a process new since left out', () => {
    expect(after.get(11608)).toEqual({ name: '2.1.319', rx: 4000, tx: 8000 })
    expect(topOf(before, after, 10)).toEqual([
      { pid: 68424, name: 'zen', down: 2000, up: 100 },
      { pid: 11608, name: '2.1.319', down: 400, up: 800 },
      { pid: 500, name: 'bun', down: 60, up: 0 },
    ])
  })

  test('a process is said as the agent session or Kehikot module above it, by executable only', () => {
    const procs = parseComm(' 11608 11543 claude bg-spare\n 11543 1 /bin/zsh\n 500 400 /opt/homebrew/bin/bun\n 400 1 /Applications/K.app/kehikko-host\n 68424 1 /Applications/Zen.app/zen\n')
    const owners = new Map([[500, 'kehikot.kanban'], [11608, 'kehikot.claude']])
    expect(ownerOf(11608, procs, owners)).toEqual({ kind: 'agent', name: 'claude' })
    expect(ownerOf(500, procs, owners)).toEqual({ kind: 'module', name: 'Kanban' })
    expect(ownerOf(68424, procs, owners)).toBeNull()
  })
})

describe('the sampler reads only while watched', () => {
  function deps(platform = 'darwin') {
    let clock = NOW
    let rx = 1_000_000
    const ran: string[] = []
    const d: NetDeps = {
      now: () => clock,
      platform,
      owners: () => new Map([[500, 'kehikot.kanban']]),
      read: async (file) => {
        ran.push(file)
        return `  eth0: ${rx} 0 0 0 0 0 0 0 ${rx / 10} 0 0 0 0 0 0 0\n`
      },
      run: async (file) => {
        ran.push(file)
        if (file === 'netstat') return `en0 1500 <Link#14> a:b 1 0 ${rx} 1 0 ${rx / 10} 0\nlo0 16384 <Link#1> 1 0 99999999 1 0 99999999 0\n`
        if (file === 'nettop') return `,bytes_in,bytes_out,\nbun.500,${rx},0,\n`
        if (file === 'ps') return ' 500 400 /opt/homebrew/bin/bun\n'
        throw new Error(file)
      },
    }
    return { d, ran, tick: (ms: number, grow: number) => ((clock += ms), (rx += grow)) }
  }

  test('nothing is read when nobody asks', async () => {
    const { d, ran } = deps()
    const sampler = new NetworkSampler(d)
    await new Promise((done) => setTimeout(done, 20))
    expect(ran).toEqual([])
    sampler.stop()
  })

  test('two readings make a rate and a point; the busiest processes every TOP_MS, marked by module', async () => {
    const { d, ran, tick } = deps()
    const sampler = new NetworkSampler(d)
    try {
      const first = await sampler.snapshot()
      expect(first.down).toBeNull()
      expect(ratesSaid(first)).toBe('')
      tick(NET_EVERY_MS, 4_000_000)
      const second = await sampler.snapshot()
      expect(second.down).toBe(2_000_000)
      expect(second.up).toBe(200_000)
      expect(second.points).toHaveLength(1)
      expect(second.interfaces).toEqual(['en0'])
      /* Asked again within the interval: the same reading, nothing run. */
      const runs = ran.length
      await sampler.snapshot()
      expect(ran.length).toBe(runs)
      expect(ran.filter((one) => one === 'nettop')).toHaveLength(1)
      tick(TOP_MS, 1_000_000)
      const third = await sampler.snapshot()
      expect(third.top).toEqual([{ pid: 500, name: 'bun', down: 5_000_000 / ((TOP_MS + NET_EVERY_MS) / 1000), up: 0, owner: { kind: 'module', name: 'Kanban' } }])
    } finally {
      sampler.stop()
    }
  })

  test('on Linux it reads /proc/net/dev and says no busiest processes', async () => {
    const { d, ran, tick } = deps('linux')
    const sampler = new NetworkSampler(d)
    try {
      await sampler.snapshot()
      tick(NET_EVERY_MS, 2_000_000)
      const snap = await sampler.snapshot()
      expect(snap.down).toBe(1_000_000)
      expect(snap.top).toBeNull()
      expect(ran.every((one) => one === '/proc/net/dev')).toBe(true)
    } finally {
      sampler.stop()
    }
  })

  test('counters that cannot be read are said, not guessed', async () => {
    const sampler = new NetworkSampler({ ...deps().d, run: async () => Promise.reject(new Error('no netstat')) })
    try {
      const snap = await sampler.snapshot()
      expect(snap.why).toContain('no netstat')
      expect(snap.down).toBeNull()
    } finally {
      sampler.stop()
    }
  })
})

describe('the Network tile', () => {
  const snapshot = snapshotOf(NOW)

  test('the layout: one chart at every size, a sparkline under 260 px and axes from there, the busiest only with room', () => {
    expect(networkLayout(200)).toMatchObject({ axes: false, plot: SPARK_HEIGHT, compact: true, top: false })
    expect(networkLayout(300)).toMatchObject({ axes: true, plot: AXES_HEIGHT, compact: true, top: false })
    expect(networkLayout(700)).toMatchObject({ axes: true, compact: false, top: true })
    expect(networkLayout(700, false)).toMatchObject({ top: false })
    expect(networkTip({ at: NOW, down: 2_400_000, up: 120_000 })).toMatchObject({ value: '↓ 2.4 MB/s · ↑ 120 kB/s', detail: '' })
    expect(networkTip({ at: NOW, down: 2_400_000, up: 120_000, ms: 24.4 })).toMatchObject({ detail: '24 ms round trip' })
    expect(networkTip({ at: NOW, down: 2_400_000, up: 120_000, ms: null })).toMatchObject({ detail: 'probes lost' })
  })

  test('large: both rates under the head line as the legend, one chart, the busiest processes under it', () => {
    const net = netOf(NOW, { top: [{ pid: 1, name: 'zen', down: 1_200_000, up: 4000, owner: { kind: 'agent', name: 'claude' } }] })
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={net} box={{ width: 700, height: 800 }} />)
    expect(screen.getByRole('region', { name: 'Network' })).toBeTruthy()
    expect(screen.getByTestId('tiles').children).toHaveLength(3)
    expect(screen.getByTestId('tile-network-value').textContent).toBe('Measuring')
    expect(screen.getByTestId('tile-network-rates').textContent).toBe('↓ 2.4 MB/s · ↑ 120 kB/s · en0 · every 2 s')
    expect([...screen.getByTestId('tile-network-rates').querySelectorAll('[data-series]')].map((one) => one.getAttribute('data-series'))).toEqual(['down', 'up'])
    expect(screen.getByTestId('tile-network-plot').getAttribute('data-kind')).toBe('line')
    expect(screen.getByTestId('tile-network-plot').style.height).toBe(`${AXES_HEIGHT}px`)
    expect(screen.getAllByRole('img').some((one) => one.getAttribute('aria-label')?.startsWith('This computer downloads 2.4 MB/s and uploads 120 kB/s now'))).toBe(true)
    expect(screen.getByTestId('tile-network-top').textContent).toContain('zen: ↓ 1.2 MB/s · ↑ 4 kB/s (agent session: claude)')
  })

  test('small: the same chart as a sparkline, the minimal head with both rates, no busiest list', () => {
    const net = netOf(NOW, { top: [{ pid: 1, name: 'zen', down: 1_200_000, up: 4000, owner: null }] })
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={net} box={{ width: 220, height: 200 }} />)
    expect(screen.getByTestId('tile-network-rates').textContent).toBe('↓ 2.4 MB/s · ↑ 120 kB/s')
    expect(screen.getByTestId('tile-network-plot').style.height).toBe(`${SPARK_HEIGHT}px`)
    expect(screen.queryByTestId('tile-network-top')).toBeNull()
  })

  test('its tooltip shows on pointing and goes when the pointer leaves: it never sticks', () => {
    const net = netOf(NOW)
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={net} box={{ width: 220, height: 200 }} />)
    resetTips()
    const plot = screen.getByTestId('tile-network-plot').firstElementChild as HTMLElement
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 100, clientY: 20, pointerType: 'mouse' })
    expect(screen.getByTestId('tile-network-tip').textContent).toContain('↓')
    fireEvent.pointerLeave(plot, { pointerType: 'mouse' })
    expect(screen.getByTestId('tile-network-tip').textContent).toBe('')
  })

  test('before two readings it measures; a server that cannot say is said in the tile', () => {
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={emptyNet()} netProblem="Monitor’s server answered 404." box={{ width: 700, height: 800 }} />)
    expect(screen.queryByTestId('tile-network-rates')).toBeNull()
    expect(screen.getByRole('region', { name: 'Network' }).textContent).toContain('answered 404')
  })
})

describe('the footer and the tool', () => {
  const base = { paused: false, rows: [], repeating: 0, budgets: [], gap: false, problem: null }

  test('the footer says both rates once two readings are held, and nothing before', () => {
    const item = footerItems({ ...base, network: netOf(NOW) }).find((one) => one.id === 'network')
    expect(item).toMatchObject({ kind: 'text', text: '↓ 2.4 MB/s · ↑ 120 kB/s' })
    expect(footerItems({ ...base, network: emptyNet() }).some((one) => one.id === 'network')).toBe(false)
    /* Clear stays last. */
    expect(footerItems({ ...base, network: netOf(NOW) }).at(-1)).toMatchObject({ id: 'clear' })
  })

  test('health’s network view: the rate now, each minute and the peak, the busiest marked', async () => {
    CLOCK.now = () => NOW
    NETWORK.snapshot = async () => netOf(NOW, { top: [{ pid: 1, name: 'node', down: 50_000, up: 9_000_000, owner: { kind: 'module', name: 'Kanban' } }] }, 150)
    const health = tools().find((one) => one.name === 'health')!
    expect((health.inputSchema.properties.view as { enum: string[] }).enum).toContain('network')
    const reply = await answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', arguments: { view: 'network' } } }, null)
    const said = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(said).toContain('download 2.4 MB/s, upload 120 kB/s (en0;')
    expect(said).toContain('- the last minute: ↓')
    expect(said).toContain('- 5–4 min ago: ↓')
    expect(said).toContain('the most was 2.5 MB/s down')
    expect(said).toContain('- node: ↓ 50 kB/s · ↑ 9 MB/s (Kehikot module: Kanban)')
  })

  test('the tool says when nothing is read yet; /api/network answers GET only', async () => {
    expect(networkSaid(emptyNet(), NOW)).toContain('has not read the network yet')
    expect(networkSaid({ ...emptyNet(), at: NOW }, NOW)).toContain('next reading')
    NETWORK.snapshot = async () => netOf(NOW)
    const reply = await answer('GET', '/api/network', new URLSearchParams(), null, null)
    expect(reply?.status).toBe(200)
    expect(await readNetwork(async () => ({ ok: true, status: 200, json: async () => reply?.body }), '/api/network')).toMatchObject({ down: 2_400_000 })
    expect((await answer('POST', '/api/network', new URLSearchParams(), {}, null))?.status).toBe(405)
    await expect(readNetwork(async () => ({ ok: false, status: 404, json: async () => null }), '/api/network')).rejects.toThrow('404')
  })
})
