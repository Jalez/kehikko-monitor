import { useRef } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'

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
/* Two series in one chart: download and upload, each its own colour, the upload's line dashed (never colour alone). */
const NETWORK: ChartConfig = { down: { label: 'Download', color: 'var(--series-7)' }, up: { label: 'Upload', color: 'var(--series-2)' } }

const LEVEL_TONE: Record<Level, string> = { normal: 'text-muted-foreground', warn: 'text-amber-700 dark:text-amber-400', critical: 'text-destructive' }
const LEVEL_SAID: Record<Level, string> = { normal: '', warn: 'warning', critical: 'critical' }

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function HealthView({ snapshot, judged, problem, now, box: given, net = emptyNet(), netProblem = null }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; box?: Box; net?: NetSnapshot; netProblem?: string | null }) {
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
        <Shown snapshot={snapshot} judged={judged} problem={problem} now={now} detail={detail} width={size?.width ?? null} net={net} netProblem={netProblem} />
      )}
    </div>
  )
}

function Shown({ snapshot, judged, problem, now, detail, width, net, netProblem }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; detail: ReturnType<typeof detailOf>; width: number | null; net: NetSnapshot; netProblem: string | null }) {
  const crashed = crashesSaid(snapshot, now)
  return (
    <>
      {problem || snapshot.why ? (
        <p className="text-destructive text-xs" role="status">
          {problem ?? snapshot.why}
        </p>
      ) : null}
      <Tiles snapshot={snapshot} width={width} net={net} netProblem={netProblem} roomy={detail === 'full'} />
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

function Tiles({ snapshot, width, net, netProblem, roomy }: { snapshot: Snapshot; width: number | null; net: NetSnapshot; netProblem: string | null; roomy: boolean }) {
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
      <NetworkTile net={net} problem={netProblem} width={width} roomy={roomy} />
    </div>
  )
}

/**
 * The machine's network throughput: ONE chart at every size, download and upload as two series, the
 * current rates in its head line. Narrow, the chart is a sparkline with no axes; wide, it has axes and,
 * with room to spare, the busiest processes under it. It spans both columns.
 */
function NetworkTile({ net, problem, width, roomy }: { net: NetSnapshot; problem: string | null; width: number | null; roomy: boolean }) {
  const layout = networkLayout(width, roomy)
  const data = net.points
  const measured = net.down !== null && net.up !== null
  const sub = problem ?? (net.why || (net.interfaces.length ? `${net.interfaces.join(', ')} · every ${net.every} s` : measured ? 'no interface carrying anything' : 'measuring…'))
  const value = measured ? (
    <span data-testid="tile-network-rates">
      <Rate dataKey="down" arrow="↓" rate={net.down as number} />
      <span className="text-muted-foreground font-normal"> · </span>
      <Rate dataKey="up" arrow="↑" rate={net.up as number} />
    </span>
  ) : (
    '—'
  )
  return (
    <Tile
      layout={layout}
      className="@min-[360px]:col-span-2"
      style={{ '--color-down': NETWORK.down?.color, '--color-up': NETWORK.up?.color } as React.CSSProperties}
      title="Network"
      value={measured ? `↓ ${rateSaid(net.down as number)} · ↑ ${rateSaid(net.up as number)}` : '—'}
      valueNode={value}
      sub={sub}
      subTone={problem || net.why ? 'text-destructive' : undefined}
      testId="tile-network"
    >
      <Plot said={networkChartSaid(net)} count={data.length > 1 ? data.length : 0} kind="line" height={layout.plot} tip={(i) => networkTip(data[i] as (typeof data)[number])} testId="tile-network">
        {(active) => (data.length > 1 ? <RatesPlot data={data} axes={layout.axes} active={active} /> : null)}
      </Plot>
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

/** One rate in the head line, with its series' swatch: the chart's legend. */
function Rate({ dataKey, arrow, rate }: { dataKey: 'down' | 'up'; arrow: string; rate: number }) {
  return (
    <span className="whitespace-nowrap" data-series={dataKey}>
      <span aria-hidden className="mr-1 inline-block size-2 rounded-[2px] align-middle" style={{ background: `var(--color-${dataKey})` }} />
      {arrow} {rateSaid(rate)}
    </span>
  )
}

function RatesPlot({ data, axes, active }: { data: NetSnapshot['points']; axes: boolean; active: number | null }) {
  const top = niceTop(Math.max(...data.map((one) => Math.max(one.down, one.up))))
  const first = data[0]?.at ?? 0
  const last = data.at(-1)?.at ?? 0
  const on = active === null ? null : data[active]
  return (
    <ChartContainer config={NETWORK} className="aspect-auto size-full">
      <AreaChart data={data} margin={axes ? { ...AXES_MARGIN, left: 8 } : MARGIN} accessibilityLayer={false}>
        {axes ? <CartesianGrid vertical={false} stroke="var(--grid)" /> : null}
        {axes ? <YAxis width={56} domain={[0, top]} ticks={[0, top]} tickFormatter={rateSaid} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} /> : <YAxis hide domain={[0, top]} />}
        <XAxis hide={!axes} dataKey="at" type="number" domain={[first, last]} ticks={[first, last]} interval={0} tickLine={false} axisLine={false} height={16} tick={<EdgeTick format={hm} />} />
        {on ? <ReferenceLine x={on.at} stroke="var(--muted-foreground)" strokeDasharray="2 2" /> : null}
        <Area dataKey="down" type="monotone" stroke="var(--color-down)" fill="var(--color-down)" fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
        <Area dataKey="up" type="monotone" stroke="var(--color-up)" fill="var(--color-up)" fillOpacity={0.15} strokeWidth={2} strokeDasharray="4 2" isAnimationActive={false} />
        {on ? <ReferenceDot x={on.at} y={on.down} r={3} fill="var(--color-down)" stroke="var(--background)" /> : null}
        {on ? <ReferenceDot x={on.at} y={on.up} r={3} fill="var(--color-up)" stroke="var(--background)" /> : null}
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
function Tile({ layout, className = '', style, title, value, valueNode, sub, subTone, testId, children }: { layout: TileLayout; className?: string; style?: React.CSSProperties; title: string; value: string; valueNode?: React.ReactNode; sub: string; subTone?: string; testId: string; children: React.ReactNode }) {
  const words = (
    <p className={`min-w-0 truncate text-[11px] ${subTone ?? 'text-muted-foreground'} ${layout.compact ? 'flex-1' : ''}`} style={{ lineHeight: `${layout.compact ? HEAD_HEIGHT : SUB_HEIGHT}px` }} title={sub}>
      {sub}
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
