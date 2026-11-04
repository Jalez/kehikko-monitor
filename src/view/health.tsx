import { useRef } from 'react'
import { Area, AreaChart, Bar, BarChart, Cell, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import {
  agoSaid,
  average,
  cpuSaid,
  detailOf,
  diskLevel,
  diskSaid,
  latencySaid,
  memorySaid,
  msSaid,
  nameOf,
  percent,
  restartsSaid,
  sizeSaid,
  totals,
  totalsOver,
  worktreesOf,
  type CallerLatency,
  type Judged,
  type Level,
  type Snapshot,
} from '@/health/model'
import { useBox } from '@/view/use-box'

/**
 * The Health view: how heavy and how well Kehikot and its modules are running on this computer, at
 * a glance. Five tiles — CPU, memory, calls, restarts and disk — each with its number in words and
 * a small chart that is an image of the same sentence; then, as the container grows, the modules
 * worth a look and a table of every running module. The page measures its own box (`useBox`), as
 * Test runs does, because a container on a canvas is sized by the person, not by the window.
 *
 * Never colour alone: a level is a word (`warning`, `critical`) beside its colour.
 */

const CPU: ChartConfig = { cpu: { label: 'CPU (cores)', color: 'var(--series-1)' } }
const MEMORY: ChartConfig = { gb: { label: 'Memory (GB)', color: 'var(--series-3)' } }
const CALLS: ChartConfig = { p95: { label: 'p95 (ms)', color: 'var(--series-2)' } }
const STARTS: ChartConfig = { starts: { label: 'Starts today', color: 'var(--series-7)' } }
const DISK: ChartConfig = { gb: { label: 'Size (GB)', color: 'var(--series-4)' } }

const LEVEL_TONE: Record<Level, string> = { normal: 'text-muted-foreground', warn: 'text-amber-700 dark:text-amber-400', critical: 'text-destructive' }
const LEVEL_SAID: Record<Level, string> = { normal: '', warn: 'warning', critical: 'critical' }

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function HealthView({ snapshot, judged, latencies, problem, now }: { snapshot: Snapshot; judged: readonly Judged[]; latencies: readonly CallerLatency[]; problem: string | null; now: number }) {
  const box = useRef<HTMLDivElement>(null)
  const detail = detailOf(useBox(box))
  return (
    /* One box, measured from the first render: what is inside changes, the box does not. */
    <div ref={box} className="@container flex min-h-0 flex-1 flex-col gap-3" data-testid="health" data-detail={detail}>
      {!snapshot.at ? (
        <p className="text-muted-foreground rounded-md border p-3 text-xs" role="status">
          {problem ?? (snapshot.why || 'Looking at the processes… the first figures come in a few seconds.')}
        </p>
      ) : (
        <Shown snapshot={snapshot} judged={judged} latencies={latencies} problem={problem} now={now} detail={detail} />
      )}
    </div>
  )
}

function Shown({ snapshot, judged, latencies, problem, now, detail }: { snapshot: Snapshot; judged: readonly Judged[]; latencies: readonly CallerLatency[]; problem: string | null; now: number; detail: ReturnType<typeof detailOf> }) {
  const flagged = judged.filter((one) => one.level !== 'normal')
  const running = snapshot.modules.filter((m) => m.running)
  return (
    <>
      {problem || snapshot.why ? (
        <p className="text-destructive text-xs" role="status">
          {problem ?? snapshot.why}
        </p>
      ) : null}
      <Tiles snapshot={snapshot} latencies={latencies} />
      {detail !== 'glance' ? (
        <section aria-labelledby="flagged-title" className="flex min-w-0 flex-col gap-1">
          <h2 id="flagged-title" className="text-sm font-medium">
            {flagged.length ? 'Worth a look' : 'Nothing is slow or heavy'}
          </h2>
          <ul className="flex flex-col gap-0.5 text-xs" data-testid="flagged">
            {(flagged.length ? flagged : judged.filter((one) => running.some((m) => m.id === one.id)).slice(0, 3)).map((one) => (
              <li key={one.id} className="flex gap-1.5">
                <span className="font-medium">{one.name}</span>
                <span className={LEVEL_TONE[one.level]}>
                  {one.said}
                  {one.level !== 'normal' ? ` (${LEVEL_SAID[one.level]})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {detail === 'full' ? <Modules snapshot={snapshot} judged={judged} latencies={latencies} now={now} /> : null}
      {detail === 'full' ? <DiskList snapshot={snapshot} now={now} /> : null}
      {detail === 'full' && snapshot.self ? (
        <p className="text-muted-foreground text-xs" data-testid="self">
          Monitor itself: {percent(snapshot.self.cpu)} CPU, {sizeSaid(snapshot.self.rss)}. It samples every {snapshot.every} s only while this page or an agent is looking.
        </p>
      ) : null}
    </>
  )
}

function Tiles({ snapshot, latencies }: { snapshot: Snapshot; latencies: readonly CallerLatency[] }) {
  const sum = totals(snapshot)
  const over = totalsOver(snapshot).map((one) => ({ at: one.at, cpu: Math.round(one.cpu * 100) / 100, gb: Math.round((one.rss / 1e9) * 100) / 100 }))
  const slow = latencies.filter((one) => one.p95 !== null).slice(0, 8).map((one) => ({ name: nameOf(one.by), p95: one.p95 as number }))
  const errors = latencies.reduce((n, one) => n + one.errors, 0)
  const calls = latencies.reduce((n, one) => n + one.calls, 0)
  const restarted = [...snapshot.modules].filter((m) => m.starts).sort((a, b) => b.starts - a.starts).slice(0, 8).map((m) => ({ name: nameOf(m.id), starts: m.starts, crashed: m.crashes > 0 }))
  const starts = snapshot.modules.reduce((n, m) => n + m.starts, 0)
  const crashes = snapshot.modules.reduce((n, m) => n + m.crashes, 0)
  const uses = snapshot.disk.uses.filter((use) => use.bytes > 0).slice(0, 6).map((use) => ({ name: use.label, gb: Math.round((use.bytes / 1e9) * 10) / 10 }))
  const worktrees = worktreesOf(snapshot.disk)
  const disk = diskLevel(snapshot.disk)
  return (
    <div className="grid shrink-0 grid-cols-1 gap-2 @min-[360px]:grid-cols-3 @min-[640px]:grid-cols-5" data-testid="tiles">
      <Tile title="CPU" value={percent(sum.cpu)} sub={`${sum.running} running · ${snapshot.cores} cores`} said={cpuSaid(snapshot)} testId="tile-cpu">
        {over.length > 1 ? (
          <ChartContainer config={CPU} className="aspect-auto size-full">
            <AreaChart data={over} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <YAxis hide domain={[0, (max: number) => Math.max(max, 0.1)]} />
              <XAxis hide dataKey="at" />
              <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => (payload[0]?.payload ? clock(Number(payload[0].payload.at)) : '')} />} />
              <Area dataKey="cpu" type="monotone" stroke="var(--color-cpu)" fill="var(--color-cpu)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        ) : null}
      </Tile>
      <Tile title="Memory" value={sizeSaid(sum.rss)} sub={snapshot.memory ? `of ${sizeSaid(snapshot.memory)}` : 'resident'} said={memorySaid(snapshot)} testId="tile-memory">
        {over.length > 1 ? (
          <ChartContainer config={MEMORY} className="aspect-auto size-full">
            <AreaChart data={over} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <YAxis hide domain={[0, 'auto']} />
              <XAxis hide dataKey="at" />
              <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => (payload[0]?.payload ? clock(Number(payload[0].payload.at)) : '')} />} />
              <Area dataKey="gb" type="monotone" stroke="var(--color-gb)" fill="var(--color-gb)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        ) : null}
      </Tile>
      <Tile
        title="Calls"
        value={slow[0] ? `${msSaid(slow[0].p95)} p95` : 'none timed'}
        sub={calls ? `${errors} of ${calls} failed` : 'last 5 minutes'}
        subTone={calls && errors / calls >= 0.2 ? 'text-destructive' : undefined}
        said={latencySaid(latencies)}
        testId="tile-calls"
      >
        {slow.length ? <Bars data={slow} dataKey="p95" config={CALLS} unit={(v) => msSaid(v)} /> : null}
      </Tile>
      <Tile
        title="Restarts"
        value={`${starts} today`}
        sub={crashes ? `${crashes} after a crash` : 'no crash'}
        subTone={crashes ? 'text-destructive' : undefined}
        said={restartsSaid(snapshot)}
        testId="tile-restarts"
      >
        {restarted.length ? <Bars data={restarted} dataKey="starts" config={STARTS} unit={(v) => `${v} starts`} fill={(one) => (one.crashed ? 'var(--destructive)' : 'var(--color-starts)')} /> : null}
      </Tile>
      <Tile
        title="Disk"
        value={snapshot.disk.free === null ? '—' : `${sizeSaid(snapshot.disk.free)} free`}
        sub={worktrees.count ? `${worktrees.count} worktrees, ${worktrees.withModules} with node_modules` : snapshot.disk.total ? `of ${sizeSaid(snapshot.disk.total)}` : 'measuring'}
        subTone={disk !== 'normal' ? 'text-destructive' : undefined}
        said={diskSaid(snapshot.disk)}
        testId="tile-disk"
      >
        {uses.length ? <Bars data={uses} dataKey="gb" config={DISK} unit={(v) => `${v} GB`} /> : null}
      </Tile>
    </div>
  )
}

function Bars<T extends { name: string }>({ data, dataKey, config, unit, fill }: { data: T[]; dataKey: keyof T & string; config: ChartConfig; unit: (value: number) => string; fill?: (one: T) => string }) {
  return (
    <ChartContainer config={config} className="aspect-auto size-full">
      <BarChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1} accessibilityLayer={false}>
        <YAxis hide domain={[0, (max: number) => Math.max(max, 1)]} />
        <XAxis hide dataKey="name" />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => (payload[0]?.payload ? `${String(payload[0].payload.name)}: ${unit(Number(payload[0].payload[dataKey]))}` : '')} />}
        />
        <Bar dataKey={dataKey} radius={[2, 2, 0, 0]} minPointSize={3} isAnimationActive={false} fill={`var(--color-${dataKey})`}>
          {fill ? data.map((one) => <Cell key={one.name} fill={fill(one)} />) : null}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function Tile({ title, value, sub, subTone, said, testId, children }: { title: string; value: string; sub: string; subTone?: string; said: string; testId: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="bg-card flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 @min-[360px]:flex-col @min-[360px]:items-stretch" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <h2 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">{title}</h2>
        <p className="truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`}>
          {value}
        </p>
        <p className={`truncate text-xs ${subTone ?? 'text-muted-foreground'}`}>{sub}</p>
      </div>
      {/* The chart is a picture of what the sentence says; the sentence is what a screen reader reads. */}
      <div role="img" aria-label={said} title={said} className="h-9 w-16 shrink-0 @min-[360px]:h-10 @min-[360px]:w-full">
        {children}
      </div>
    </section>
  )
}

function Modules({ snapshot, judged, latencies, now }: { snapshot: Snapshot; judged: readonly Judged[]; latencies: readonly CallerLatency[]; now: number }) {
  const lat = new Map(latencies.map((one) => [one.by, one]))
  const byId = new Map(snapshot.modules.map((m) => [m.id, m]))
  const rows = judged.filter((one) => byId.get(one.id)?.running || one.level !== 'normal' || (byId.get(one.id)?.starts ?? 0) > 0)
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
              <th className="py-1 pr-2 text-right font-normal" title="95% of its calls in the last 5 minutes took at most this long">p95</th>
              <th className="hidden py-1 pr-2 text-right font-normal @md:table-cell">Failed</th>
              <th className="hidden py-1 pr-2 text-right font-normal @md:table-cell">Starts</th>
              <th className="hidden py-1 pr-2 text-right font-normal @lg:table-cell">Started</th>
              <th className="py-1 font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((one) => {
              const m = byId.get(one.id)
              if (!m) return null
              const l = lat.get(one.id)
              const p95 = Math.max(l?.p95 ?? -1, l?.answered?.p95 ?? -1)
              const failed = (l?.errors ?? 0) + (l?.answered?.errors ?? 0)
              return (
                <tr key={one.id} className="border-t">
                  <td className="py-1 pr-2">{one.name}</td>
                  <td className="py-1 pr-2 text-right">{m.running ? percent(average(m.points.slice(-6))) : '—'}</td>
                  <td className="py-1 pr-2 text-right">{m.running && m.now ? sizeSaid(m.now.rss) : '—'}</td>
                  <td className="py-1 pr-2 text-right">{p95 >= 0 ? msSaid(p95) : '—'}</td>
                  <td className="hidden py-1 pr-2 text-right @md:table-cell">{l ? failed : '—'}</td>
                  <td className="hidden py-1 pr-2 text-right @md:table-cell">
                    {m.starts}
                    {m.crashes ? ` (${m.crashes} crash${m.crashes === 1 ? '' : 'es'})` : ''}
                  </td>
                  <td className="hidden py-1 pr-2 text-right @lg:table-cell">{m.startedAt ? agoSaid(m.startedAt, now) : '—'}</td>
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
  return (
    <section aria-labelledby="disk-title" className="flex min-w-0 flex-col gap-1">
      <h2 id="disk-title" className="text-sm font-medium">
        What takes the most disk
      </h2>
      <p className="text-muted-foreground text-xs">
        {diskSaid(disk)}
        {disk.at !== null ? ` Measured ${agoSaid(disk.at, now)}; sizes only.` : ''}
        {disk.why ? ` ${disk.why}` : ''}
      </p>
      <ul className="flex flex-col gap-0.5 text-xs tabular-nums" data-testid="disk">
        {disk.uses.slice(0, 10).map((use) => (
          <li key={use.label} className="flex min-w-0 gap-2">
            <span className="w-16 shrink-0 text-right">{use.bytes ? sizeSaid(use.bytes) : 'measuring'}</span>
            <span className="truncate" title={use.label}>
              {use.label}
              {use.count !== undefined ? ` — ${use.count} worktrees, ${use.withModules} with node_modules` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
