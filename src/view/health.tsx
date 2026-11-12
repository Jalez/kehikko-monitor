import { useRef } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import {
  average,
  cpuSaid,
  crashesSaid,
  detailOf,
  memorySaid,
  percent,
  sizeSaid,
  totals,
  totalsOver,
  type Judged,
  type Level,
  type Box,
  type Snapshot,
} from '@/health/model'
import { emptyNet, networkChartSaid, rateSaid, topSaid, type NetSnapshot } from '@/health/network'
import { emptyQuality, hostSaid, SPEED_SAID, speedSaid, verdictSaid, withLatency, type QualityLevel, type SpeedState, type Verdict } from '@/health/quality'
import type { SpeedAction } from '@/wire/use-network'
import { Plot } from '@/view/plot'
import { cpuTip, HEAD_HEIGHT, memoryTip, networkLayout, networkTip, niceTop, PAD_X, PAD_Y, ROW_GAP, SUB_HEIGHT, tileLayout, type TileLayout } from '@/view/tiles'
import { useBox } from '@/view/use-box'

/**
 * The Health view: how heavy and how well Kehikot and its modules are running on this computer, at
 * a glance. Two tiles — CPU and memory — each with its number in words and
 * a small chart that is an image of the same sentence — and the Network tile under them, the
 * computer's download and upload in one chart of two series; then, as the container grows, one line when a module
 * crashed in the last hour and a table of every running module. The page measures its own box (`useBox`), as
 * Test runs does, because a container on a canvas is sized by the person, not by the window.
 *
 * Never colour alone: a level is a word (`warning`, `critical`) beside its colour.
 */

const CPU: ChartConfig = { cpu: { label: 'CPU (cores)', color: 'var(--series-1)' } }
const MEMORY: ChartConfig = { gb: { label: 'Memory (GB)', color: 'var(--series-3)' } }
/*
 * Three series in one chart: download and upload, each its own colour, the upload's line dashed; and the
 * connection's round trip on its own scale, a thin dotted step line with no fill (never colour alone: each
 * is named with its swatch in the tile's head).
 */
const NETWORK: ChartConfig = { down: { label: 'Download', color: 'var(--series-7)' }, up: { label: 'Upload', color: 'var(--series-2)' }, ms: { label: 'Latency', color: 'var(--series-5)' } }

/* The verdict's badge: its word always, the tone only beside it. */
const VERDICT_TONE: Record<QualityLevel, string> = {
  measuring: 'border-border text-muted-foreground bg-transparent',
  good: 'border-transparent bg-emerald-600/15 text-emerald-800 dark:text-emerald-300',
  fair: 'border-transparent bg-amber-500/20 text-amber-800 dark:text-amber-300',
  poor: 'border-transparent bg-destructive/15 text-destructive',
  offline: 'border-transparent bg-destructive text-white',
}

const LEVEL_TONE: Record<Level, string> = { normal: 'text-muted-foreground', warn: 'text-amber-700 dark:text-amber-400', critical: 'text-destructive' }
const LEVEL_SAID: Record<Level, string> = { normal: '', warn: 'warning', critical: 'critical' }

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function HealthView({ snapshot, judged, problem, now, box: given, net = emptyNet(), netProblem = null, onSpeed }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; box?: Box; net?: NetSnapshot; netProblem?: string | null; onSpeed?: (action: SpeedAction) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const measured = useBox(box)
  const size = given ?? measured
  const detail = detailOf(size)
  return (
    /* One box, measured from the first render: what is inside changes, the box does not. */
    <div ref={box} className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-testid="health" data-detail={detail}>
      {!snapshot.at ? (
        <p className="text-muted-foreground rounded-md border p-3 text-xs" role="status">
          {problem ?? (snapshot.why || 'Looking at the processes… the first figures come in a few seconds.')}
        </p>
      ) : (
        <Shown snapshot={snapshot} judged={judged} problem={problem} now={now} detail={detail} width={size?.width ?? null} net={net} netProblem={netProblem} onSpeed={onSpeed} />
      )}
    </div>
  )
}

function Shown({ snapshot, judged, problem, now, detail, width, net, netProblem, onSpeed }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; detail: ReturnType<typeof detailOf>; width: number | null; net: NetSnapshot; netProblem: string | null; onSpeed?: (action: SpeedAction) => void }) {
  const crashed = crashesSaid(snapshot, now)
  return (
    <>
      {problem || snapshot.why ? (
        <p className="text-destructive text-xs" role="status">
          {problem ?? snapshot.why}
        </p>
      ) : null}
      <Tiles snapshot={snapshot} width={width} net={net} netProblem={netProblem} roomy={detail === 'full'} onSpeed={onSpeed} />
      {/* Only a crash in the last hour is said, as one quiet line; otherwise nothing. */}
      {detail !== 'glance' && crashed ? (
        <p className="text-muted-foreground text-xs" data-testid="flagged">
          {crashed}.
        </p>
      ) : null}
      {/* Heavy work an agent session started on its own is in the Inbox and the footer, not here: it takes no height (0.15.0). */}
            {detail === 'full' ? <Modules snapshot={snapshot} judged={judged} /> : null}
      {detail === 'full' && snapshot.self ? (
        <p className="text-muted-foreground text-xs" data-testid="self">
          Monitor itself: {percent(snapshot.self.cpu)} CPU, {sizeSaid(snapshot.self.rss)}. It samples every {snapshot.every} s only while this page or an agent is looking.
        </p>
      ) : null}
    </>
  )
}

function Tiles({ snapshot, width, net, netProblem, roomy, onSpeed }: { snapshot: Snapshot; width: number | null; net: NetSnapshot; netProblem: string | null; roomy: boolean; onSpeed?: (action: SpeedAction) => void }) {
  const layout = tileLayout(width)
  const sum = totals(snapshot)
  const over = totalsOver(snapshot).map((one) => ({ at: one.at, cpu: Math.round(one.cpu * 100) / 100, rss: one.rss, gb: Math.round((one.rss / 1e9) * 100) / 100 }))
  return (
    /* No cards: the grid's 1 px gap shows the border colour between tiles, which stand on the page's own background. */
    <div className="bg-border grid min-w-0 shrink-0 grid-cols-1 gap-px @min-[360px]:grid-cols-2" data-testid="tiles" data-axes={layout.axes} data-compact={layout.compact}>
      <Tile layout={layout} title="CPU" value={percent(sum.cpu)} sub={`${sum.running} running · ${snapshot.cores} cores`} testId="tile-cpu">
        <Plot said={cpuSaid(snapshot)} count={over.length > 1 ? over.length : 0} kind="line" height={layout.plot} tip={(i) => cpuTip(over[i] as (typeof over)[number], snapshot.cores)} testId="tile-cpu">
          {(active) => (over.length > 1 ? <AreaPlot data={over} dataKey="cpu" config={CPU} axes={layout.axes} active={active} format={(v) => percent(v)} /> : null)}
        </Plot>
      </Tile>
      <Tile layout={layout} title="Memory" value={sizeSaid(sum.rss)} sub={snapshot.memory ? `of ${sizeSaid(snapshot.memory)}` : 'resident'} testId="tile-memory">
        <Plot said={memorySaid(snapshot)} count={over.length > 1 ? over.length : 0} kind="line" height={layout.plot} tip={(i) => memoryTip(over[i] as (typeof over)[number], snapshot.memory)} testId="tile-memory">
          {(active) => (over.length > 1 ? <AreaPlot data={over} dataKey="gb" config={MEMORY} axes={layout.axes} active={active} format={(v) => `${v} GB`} /> : null)}
        </Plot>
      </Tile>
      <NetworkTile net={net} problem={netProblem} width={width} roomy={roomy} onSpeed={onSpeed} />
    </div>
  )
}

/**
 * The machine's network: ONE chart at every size — download and upload as two series, and the
 * connection's round trip as a third on its own scale — with the connection's verdict in its head line
 * ("Good · 24 ms · 0% loss"; narrow, "Good · 24 ms") and the rates under it as the legend. Narrow, the
 * chart is a sparkline with no axes; wide, it has axes and, with room to spare, each host's round trip
 * and loss, the speed test and the busiest processes under it. It spans both columns.
 */
function NetworkTile({ net, problem, width, roomy, onSpeed }: { net: NetSnapshot; problem: string | null; width: number | null; roomy: boolean; onSpeed?: (action: SpeedAction) => void }) {
  const layout = networkLayout(width, roomy)
  const quality = net.quality ?? emptyQuality()
  const data = withLatency(net.points, quality.points)
  const measured = net.down !== null && net.up !== null
  const ratesText = measured ? `↓ ${rateSaid(net.down as number)} · ↑ ${rateSaid(net.up as number)}` : ''
  const where = net.interfaces.length ? `${net.interfaces.join(', ')} · every ${net.every} s` : measured ? 'no interface carrying anything' : 'measuring…'
  const trouble = problem ?? (net.why || null)
  const sub = trouble ?? (layout.compact ? ratesText || where : [ratesText, where].filter(Boolean).join(' · '))
  const subNode =
    trouble || !measured ? undefined : (
      <span data-testid="tile-network-rates">
        <Rate dataKey="down" arrow="↓" rate={net.down as number} />
        <span> · </span>
        <Rate dataKey="up" arrow="↑" rate={net.up as number} />
        {layout.compact ? null : <span> · {where}</span>}
      </span>
    )
  return (
    <Tile
      layout={layout}
      className="@min-[360px]:col-span-2"
      style={{ '--color-down': NETWORK.down?.color, '--color-up': NETWORK.up?.color, '--color-ms': NETWORK.ms?.color } as React.CSSProperties}
      title="Network"
      value={verdictSaid(quality.verdict, layout.compact)}
      valueNode={<VerdictSaid verdict={quality.verdict} short={layout.compact} />}
      sub={sub}
      subNode={subNode}
      subTone={trouble ? 'text-destructive' : undefined}
      testId="tile-network"
    >
      <Plot said={networkChartSaid(net)} count={data.length > 1 ? data.length : 0} kind="line" height={layout.plot} tip={(i) => networkTip(data[i] as (typeof data)[number])} testId="tile-network">
        {(active) => (data.length > 1 ? <RatesPlot data={data} axes={layout.axes} active={active} /> : null)}
      </Plot>
      {layout.top ? <Connection verdict={quality.verdict} hosts={quality.hosts} speed={quality.speed} onSpeed={onSpeed} /> : null}
      {layout.top && net.top?.length ? (
        <ul className="text-muted-foreground mt-1 flex min-w-0 flex-col text-[11px] tabular-nums" aria-label="Busiest processes" data-testid="tile-network-top">
          {net.top.map((one) => (
            <li key={one.pid} className="truncate" title={topSaid(one)}>
              {topSaid(one)}
            </li>
          ))}
        </ul>
      ) : null}
    </Tile>
  )
}

/** The verdict in the head line: its word as a badge, then the round trip (with the latency series' swatch) and, unless short, the loss. */
function VerdictSaid({ verdict, short }: { verdict: Verdict; short: boolean }) {
  const said = verdictSaid(verdict, short)
  const rest = said.slice(verdict.word.length)
  return (
    <span className="inline-flex min-w-0 items-baseline gap-0" data-testid="tile-network-verdict" data-level={verdict.level}>
      <Badge variant="outline" className={`px-1.5 py-0 text-[11px] leading-4 ${VERDICT_TONE[verdict.level]}`}>
        {verdict.word}
      </Badge>
      {rest ? (
        <span className="truncate">
          {' · '}
          <span aria-hidden className="mr-1 inline-block size-2 rounded-[2px] align-middle" style={{ background: 'var(--color-ms)' }} />
          {rest.replace(/^ · /, '')}
        </span>
      ) : null}
    </span>
  )
}

/**
 * With room: why the verdict is what it is, each host's round trip and loss over the last minute, and
 * the speed test — what it spends said beside its button, the last result with when it was measured.
 */
function Connection({ verdict, hosts, speed, onSpeed }: { verdict: Verdict; hosts: ReturnType<typeof emptyQuality>['hosts']; speed: SpeedState; onSpeed?: (action: SpeedAction) => void }) {
  const testing = speed.state === 'testing'
  return (
    <div className="text-muted-foreground mt-1 grid min-w-0 gap-x-4 gap-y-2 text-[11px] tabular-nums @min-[560px]:grid-cols-2" data-testid="tile-network-quality">
      <div className="flex min-w-0 flex-col">
        <p className="text-foreground truncate" title={`${verdict.word}: ${verdict.reason}`}>
          {verdict.level === 'measuring' ? 'Probing the connection…' : `Connection ${verdict.word.toLowerCase()}: ${verdict.reason}`}
        </p>
        {hosts.length ? (
          <ul aria-label="Round trip by host" data-testid="tile-network-hosts" className="flex min-w-0 flex-col">
            {hosts.map((one) => (
              <li key={one.host} className="truncate" title={hostSaid(one)}>
                {hostSaid(one)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1" data-testid="tile-network-speed">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!onSpeed} onClick={() => onSpeed?.(testing ? 'cancel' : 'start')}>
            {testing ? 'Cancel' : 'Test speed'}
          </Button>
          <span className="text-foreground truncate" role="status" aria-live="polite">
            {testing
              ? `Testing ${speed.phase === 'upload' ? 'upload' : 'download'}…`
              : speed.last
                ? `${speedSaid(speed.last)} · measured ${hm(speed.last.at)}`
                : 'No speed test yet'}
          </span>
        </div>
        <p>{SPEED_SAID}</p>
        {speed.state === 'failed' ? <p className="text-destructive">The speed test failed: {speed.why}</p> : null}
        {speed.state === 'cancelled' ? <p>The speed test was cancelled.</p> : null}
      </div>
    </div>
  )
}

/** One rate in the head line, with its series' swatch: the chart's legend. */
function Rate({ dataKey, arrow, rate }: { dataKey: 'down' | 'up'; arrow: string; rate: number }) {
  return (
    <span className="whitespace-nowrap" data-series={dataKey}>
      <span aria-hidden className="mr-1 inline-block size-2 rounded-[2px] align-middle" style={{ background: `var(--color-${dataKey})` }} />
      {arrow} {rateSaid(rate)}
    </span>
  )
}

type RatePoint = NetSnapshot['points'][number] & { ms?: number | null }

function RatesPlot({ data, axes, active }: { data: RatePoint[]; axes: boolean; active: number | null }) {
  const top = niceTop(Math.max(...data.map((one) => Math.max(one.down, one.up))))
  const msTop = niceTop(Math.max(0, ...data.map((one) => one.ms ?? 0)))
  const first = data[0]?.at ?? 0
  const last = data.at(-1)?.at ?? 0
  const on = active === null ? null : data[active]
  const latency = data.some((one) => typeof one.ms === 'number')
  return (
    <ChartContainer config={NETWORK} className="aspect-auto size-full">
      <AreaChart data={data} margin={axes ? { ...AXES_MARGIN, left: 8 } : MARGIN} accessibilityLayer={false}>
        {axes ? <CartesianGrid vertical={false} stroke="var(--grid)" /> : null}
        {axes ? <YAxis width={56} domain={[0, top]} ticks={[0, top]} tickFormatter={rateSaid} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} /> : <YAxis hide domain={[0, top]} />}
        {/* The round trip's own scale, on the right with axes. */}
        {axes && latency ? (
          <YAxis yAxisId="ms" orientation="right" width={44} domain={[0, msTop]} ticks={[0, msTop]} tickFormatter={(v: number) => `${v} ms`} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} />
        ) : (
          <YAxis yAxisId="ms" hide domain={[0, msTop]} />
        )}
        <XAxis hide={!axes} dataKey="at" type="number" domain={[first, last]} ticks={[first, last]} interval={0} tickLine={false} axisLine={false} height={16} tick={<EdgeTick format={hm} />} />
        {on ? <ReferenceLine x={on.at} stroke="var(--muted-foreground)" strokeDasharray="2 2" /> : null}
        <Area dataKey="down" type="monotone" stroke="var(--color-down)" fill="var(--color-down)" fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
        <Area dataKey="up" type="monotone" stroke="var(--color-up)" fill="var(--color-up)" fillOpacity={0.15} strokeWidth={2} strokeDasharray="4 2" isAnimationActive={false} />
        {latency ? <Area yAxisId="ms" dataKey="ms" type="stepAfter" stroke="var(--color-ms)" fill="none" fillOpacity={0} strokeWidth={1.5} strokeDasharray="1 2" isAnimationActive={false} /> : null}
        {on ? <ReferenceDot x={on.at} y={on.down} r={3} fill="var(--color-down)" stroke="var(--background)" /> : null}
        {on ? <ReferenceDot x={on.at} y={on.up} r={3} fill="var(--color-up)" stroke="var(--background)" /> : null}
        {on && typeof on.ms === 'number' ? <ReferenceDot yAxisId="ms" x={on.at} y={on.ms} r={3} fill="var(--color-ms)" stroke="var(--background)" /> : null}
      </AreaChart>
    </ChartContainer>
  )
}

const MARGIN = { top: 2, right: 0, bottom: 0, left: 0 }
/* Room for the top tick's text above the plot and the last time's below it, so no axis is clipped. */
const AXES_MARGIN = { top: 6, right: 4, bottom: 0, left: 0 }

/** The first time anchored at its start and the last at its end, so neither runs off the plot. */
function EdgeTick({ x, y, payload, index, format }: { x?: number; y?: number; payload?: { value: number }; index?: number; format: (value: number) => string }) {
  return (
    <text x={x} y={y} dy={10} textAnchor={index === 0 ? 'start' : 'end'} fontSize={10} fill="var(--muted-foreground)">
      {format(Number(payload?.value ?? 0))}
    </text>
  )
}

function YTicks({ top, format }: { top: number; format: (value: number) => string }) {
  return <YAxis width={40} domain={[0, top]} ticks={[0, top]} tickFormatter={format} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} />
}

function AreaPlot<T extends { at: number }>({ data, dataKey, config, axes, active, format }: { data: T[]; dataKey: keyof T & string; config: ChartConfig; axes: boolean; active: number | null; format: (value: number) => string }) {
  const top = niceTop(Math.max(...data.map((one) => Number(one[dataKey]))))
  const first = data[0]?.at ?? 0
  const last = data.at(-1)?.at ?? 0
  const on = active === null ? null : data[active]
  return (
    <ChartContainer config={config} className="aspect-auto size-full">
      <AreaChart data={data} margin={axes ? AXES_MARGIN : MARGIN} accessibilityLayer={false}>
        {axes ? <CartesianGrid vertical={false} stroke="var(--grid)" /> : null}
        {axes ? <YTicks top={top} format={format} /> : <YAxis hide domain={[0, top]} />}
        <XAxis hide={!axes} dataKey="at" type="number" domain={[first, last]} ticks={[first, last]} interval={0} tickLine={false} axisLine={false} height={16} tick={<EdgeTick format={hm} />} />
        {on ? <ReferenceLine x={on.at} stroke="var(--muted-foreground)" strokeDasharray="2 2" /> : null}
        <Area dataKey={dataKey} type="monotone" stroke={`var(--color-${dataKey})`} fill={`var(--color-${dataKey})`} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
        {on ? <ReferenceDot x={on.at} y={Number(on[dataKey])} r={3} fill={`var(--color-${dataKey})`} stroke="var(--background)" /> : null}
      </AreaChart>
    </ChartContainer>
  )
}

/**
 * A glance tile, with no card of its own: tight padding, the page's background, a hairline between
 * it and the next (the grid's gap). In one column (`compact`) its title, line in words and number are
 * one row, the plot directly under it; side by side the words go on a line under the title. Nothing
 * overlays the plot but the tooltip, which sits outside it.
 */
function Tile({ layout, className = '', style, title, value, valueNode, sub, subNode, subTone, testId, children }: { layout: TileLayout; className?: string; style?: React.CSSProperties; title: string; value: string; valueNode?: React.ReactNode; sub: string; subNode?: React.ReactNode; subTone?: string; testId: string; children: React.ReactNode }) {
  const words = (
    <p className={`min-w-0 truncate text-[11px] ${subTone ?? 'text-muted-foreground'} ${layout.compact ? 'flex-1' : ''}`} style={{ lineHeight: `${layout.compact ? HEAD_HEIGHT : SUB_HEIGHT}px` }} title={sub}>
      {subNode ?? sub}
    </p>
  )
  return (
    <section
      aria-label={title}
      className={`bg-background flex min-w-0 flex-col ${className}`}
      style={{ ...style, padding: `${PAD_Y}px ${PAD_X}px`, rowGap: ROW_GAP }}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2" style={{ height: HEAD_HEIGHT, lineHeight: `${HEAD_HEIGHT}px` }} data-testid={`${testId}-head`}>
        <h2 className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">{title}</h2>
        {layout.compact ? words : null}
        <p className="min-w-0 truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`} title={value}>
          {valueNode ?? value}
        </p>
      </div>
      {layout.compact ? null : words}
      {children}
    </section>
  )
}

function Modules({ snapshot, judged }: { snapshot: Snapshot; judged: readonly Judged[] }) {
  const byId = new Map(snapshot.modules.map((m) => [m.id, m]))
  const rows = judged.filter((one) => byId.get(one.id)?.running || one.level !== 'normal')
  const stopped = snapshot.modules.length - rows.length
  return (
    <section aria-labelledby="modules-title" className="flex min-w-0 flex-col gap-1">
      <h2 id="modules-title" className="text-sm font-medium">
        Modules
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums [&_td]:whitespace-nowrap" data-testid="modules">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1 pr-2 font-normal">Module</th>
              <th className="py-1 pr-2 text-right font-normal">CPU</th>
              <th className="py-1 pr-2 text-right font-normal">Memory</th>
              <th className="py-1 font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((one) => {
              const m = byId.get(one.id)
              if (!m) return null
              return (
                <tr key={one.id} className="border-t">
                  <td className="py-1 pr-2">{one.name}</td>
                  <td className="py-1 pr-2 text-right">{m.running ? percent(average(m.points.slice(-6))) : '—'}</td>
                  <td className="py-1 pr-2 text-right">{m.running && m.now ? sizeSaid(m.now.rss) : '—'}</td>
                  <td className={`py-1 ${LEVEL_TONE[one.level]}`}>{one.level === 'normal' ? (m.running ? 'running' : 'not running') : `${LEVEL_SAID[one.level]}: ${one.said}`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {stopped > 0 ? <p className="text-muted-foreground text-xs">{stopped} more registered modules are not running.</p> : null}
    </section>
  )
}
