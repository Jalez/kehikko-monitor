import { useRef } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'

import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { outsideSaid } from '@/health/heavy'
import {
  agoSaid,
  average,
  cpuSaid,
  crashesSaid,
  detailOf,
  diskLevel,
  diskSaid,
  memorySaid,
  percent,
  sizeSaid,
  totals,
  totalsOver,
  worktreesOf,
  type Judged,
  type Level,
  type Box,
  type Snapshot,
} from '@/health/model'
import { Plot } from '@/view/plot'
import {
  centreLabel,
  cpuTip,
  diskSegments,
  diskWords,
  HEAD_HEIGHT,
  HOLE,
  LEGEND_ROW,
  memoryTip,
  niceTop,
  PAD_X,
  PAD_Y,
  ringRow,
  ROW_GAP,
  SUB_HEIGHT,
  segmentSaid,
  segmentsSaid,
  segmentTip,
  tileLayout,
  type Segment,
  type TileLayout,
  type SegmentKey,
} from '@/view/tiles'
import { useBox } from '@/view/use-box'

/**
 * The Health view: how heavy and how well Kehikot and its modules are running on this computer, at
 * a glance. Three tiles — CPU, memory and disk — each with its number in words and
 * a small chart that is an image of the same sentence; then, as the container grows, one line when a module
 * crashed in the last hour and a table of every running module. The page measures its own box (`useBox`), as
 * Test runs does, because a container on a canvas is sized by the person, not by the window.
 *
 * Never colour alone: a level is a word (`warning`, `critical`) beside its colour.
 */

const CPU: ChartConfig = { cpu: { label: 'CPU (cores)', color: 'var(--series-1)' } }
const MEMORY: ChartConfig = { gb: { label: 'Memory (GB)', color: 'var(--series-3)' } }
/* One colour per consumer of the disk, never by order: a segment keeps its colour as sizes change. */
const DISK: Record<SegmentKey, string> = { worktrees: 'var(--series-4)', modules: 'var(--series-1)', frame: 'var(--series-3)', logs: 'var(--series-5)', other: 'var(--series-other)' }

const LEVEL_TONE: Record<Level, string> = { normal: 'text-muted-foreground', warn: 'text-amber-700 dark:text-amber-400', critical: 'text-destructive' }
const LEVEL_SAID: Record<Level, string> = { normal: '', warn: 'warning', critical: 'critical' }

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function HealthView({ snapshot, judged, problem, now, box: given }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; box?: Box }) {
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
        <Shown snapshot={snapshot} judged={judged} problem={problem} now={now} detail={detail} width={size?.width ?? null} />
      )}
    </div>
  )
}

function Shown({ snapshot, judged, problem, now, detail, width }: { snapshot: Snapshot; judged: readonly Judged[]; problem: string | null; now: number; detail: ReturnType<typeof detailOf>; width: number | null }) {
  const crashed = crashesSaid(snapshot, now)
  const outside = outsideSaid(snapshot.outside ?? [])
  return (
    <>
      {problem || snapshot.why ? (
        <p className="text-destructive text-xs" role="status">
          {problem ?? snapshot.why}
        </p>
      ) : null}
      <Tiles snapshot={snapshot} width={width} />
      {/* Only a crash in the last hour is said, as one quiet line; otherwise nothing. */}
      {detail !== 'glance' && crashed ? (
        <p className="text-muted-foreground text-xs" data-testid="flagged">
          {crashed}.
        </p>
      ) : null}
      {/* Heavy work an agent session started outside the Queue: one line, in words (a kind, a session), never a command line. */}
      {outside ? (
        <p className="text-amber-700 dark:text-amber-400 text-xs" role="status" data-testid="outside">
          {outside}.
        </p>
      ) : null}
            {detail === 'full' ? <Modules snapshot={snapshot} judged={judged} /> : null}
      {detail === 'full' ? <DiskList snapshot={snapshot} now={now} /> : null}
      {detail === 'full' && snapshot.self ? (
        <p className="text-muted-foreground text-xs" data-testid="self">
          Monitor itself: {percent(snapshot.self.cpu)} CPU, {sizeSaid(snapshot.self.rss)}. It samples every {snapshot.every} s only while this page or an agent is looking.
        </p>
      ) : null}
    </>
  )
}

function Tiles({ snapshot, width }: { snapshot: Snapshot; width: number | null }) {
  const layout = tileLayout(width)
  const sum = totals(snapshot)
  const over = totalsOver(snapshot).map((one) => ({ at: one.at, cpu: Math.round(one.cpu * 100) / 100, rss: one.rss, gb: Math.round((one.rss / 1e9) * 100) / 100 }))
  const segments = diskSegments(snapshot.disk)
  const disk = diskLevel(snapshot.disk)
  const words = diskWords(snapshot.disk, segments, disk !== 'normal')
  return (
    /* No cards: the grid's 1 px gap shows the border colour between tiles, which stand on the page's own background. */
    <div className="bg-border grid min-w-0 shrink-0 grid-cols-1 gap-px @min-[360px]:grid-cols-2 @min-[640px]:grid-cols-3" data-testid="tiles" data-axes={layout.axes} data-compact={layout.compact}>
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
      <Tile
        layout={layout}
        className="@min-[360px]:col-span-2 @min-[640px]:col-span-1"
        title="Disk"
        value={words.value}
        sub={words.sub}
        subTone={disk !== 'normal' ? 'text-destructive' : undefined}
        testId="tile-disk"
      >
        <Plot
          said={`${diskSaid(snapshot.disk)} ${segmentsSaid(segments)}`}
          count={segments.length}
          kind="ring"
          height={ringRow(layout, segments.length)}
          ring={layout.ring}
          fractions={segments.map((one) => one.fraction)}
          tip={(i) => segmentTip(segments[i] as Segment)}
          testId="tile-disk"
          aside={<Segments segments={segments} shown={layout.legend} />}
        >
          {(active) => (segments.length ? <Doughnut segments={segments} size={layout.ring} active={active} /> : null)}
        </Plot>
      </Tile>
    </div>
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

function Doughnut({ segments, size, active }: { segments: readonly Segment[]; size: number; active: number | null }) {
  const centre = centreLabel(segments, size)
  return (
    <div className="relative size-full">
      <PieChart width={size} height={size} accessibilityLayer={false}>
        <Pie data={segments as Segment[]} dataKey="bytes" nameKey="short" innerRadius={(size / 2) * HOLE} outerRadius={size / 2 - 1} startAngle={90} endAngle={-270} stroke="var(--background)" strokeWidth={1} isAnimationActive={false}>
          {segments.map((one, i) => (
            <Cell key={one.key} fill={DISK[one.key]} fillOpacity={active === null || active === i ? 1 : 0.4} />
          ))}
        </Pie>
      </PieChart>
      {centre ? (
        <span className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] font-medium" data-testid="tile-disk-centre">
          {centre}
        </span>
      ) : null}
    </div>
  )
}

/** The doughnut in words: each consumer and its size. Beside it when the tile has room, for screen readers only when not. */
function Segments({ segments, shown }: { segments: readonly Segment[]; shown: boolean }) {
  return (
    <ul aria-label="What Kehikot uses on the disk" className={shown ? 'flex min-w-0 flex-1 flex-col text-[11px] tabular-nums' : 'sr-only'} data-testid="tile-disk-segments">
      {segments.map((one) => (
        <li key={one.key} className="flex min-w-0 items-center gap-1.5" style={shown ? { height: LEGEND_ROW, lineHeight: `${LEGEND_ROW}px` } : undefined}>
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: DISK[one.key] }} />
          <span className="min-w-0 flex-1 truncate" title={one.label}>
            {one.label}
          </span>
          <span className="text-muted-foreground shrink-0">
            {sizeSaid(one.bytes)} · {percent(one.fraction)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * A glance tile, with no card of its own: tight padding, the page's background, a hairline between
 * it and the next (the grid's gap). In one column (`compact`) its title, line in words and number are
 * one row, the plot directly under it; side by side the words go on a line under the title. Nothing
 * overlays the plot but the tooltip, which sits outside it.
 */
function Tile({ layout, className = '', title, value, sub, subTone, testId, children }: { layout: TileLayout; className?: string; title: string; value: string; sub: string; subTone?: string; testId: string; children: React.ReactNode }) {
  const words = (
    <p className={`min-w-0 truncate text-[11px] ${subTone ?? 'text-muted-foreground'} ${layout.compact ? 'flex-1' : ''}`} style={{ lineHeight: `${layout.compact ? HEAD_HEIGHT : SUB_HEIGHT}px` }} title={sub}>
      {sub}
    </p>
  )
  return (
    <section
      aria-label={title}
      className={`bg-background flex min-w-0 flex-col ${className}`}
      style={{ padding: `${PAD_Y}px ${PAD_X}px`, rowGap: ROW_GAP }}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2" style={{ height: HEAD_HEIGHT, lineHeight: `${HEAD_HEIGHT}px` }} data-testid={`${testId}-head`}>
        <h2 className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">{title}</h2>
        {layout.compact ? words : null}
        <p className="min-w-0 truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`} title={value}>
          {value}
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

function DiskList({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { disk } = snapshot
  const segments = diskSegments(disk)
  const trees = worktreesOf(disk)
  return (
    <section aria-labelledby="disk-title" className="flex min-w-0 flex-col gap-1">
      <h2 id="disk-title" className="text-sm font-medium">
        What Kehikot uses on the disk
      </h2>
      <p className="text-muted-foreground text-xs">
        {diskSaid(disk)}
        {disk.at !== null ? ` Measured ${agoSaid(disk.at, now)}; sizes only.` : ''}
        {disk.why ? ` ${disk.why}` : ''}
      </p>
      <ul className="flex flex-col gap-0.5 text-xs tabular-nums" data-testid="disk">
        {segments.map((one) => (
          <li key={one.key} className="flex min-w-0 gap-2">
            <span className="truncate" title={segmentSaid(one)}>
              {segmentSaid(one)}
            </span>
          </li>
        ))}
      </ul>
      {trees.count ? <p className="text-muted-foreground text-xs">{trees.count} agent worktrees, {trees.withModules} with node_modules.</p> : null}
    </section>
  )
}
