import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { HeaderItem, PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useKept, useServerStanding } from 'kehikot-module-protocol/client/react'

import { HeaderMenus } from '@/components/header-menus'
import { footerItems } from '@/footer'
import { VIEWS, headerItems, pressed, type HeaderState, type View } from '@/header'
import { emptySnapshot, judged as judge } from '@/health/model'
import { budgetLines } from '@/traffic/budgets'
import { RANGES, STYLES, callerOf, colourOrder, repeats, summary, type Caller, type Filter, type Range, type Repeat, type Style } from '@/traffic/model'
import { useKehikot, type Host } from '@/wire/use-kehikot'
import { useTraffic, type Traffic } from '@/wire/use-traffic'
import { useHealth, type Health } from '@/wire/use-health'
import { useOnScreen } from '@/wire/use-on-screen'

import { HealthView } from '@/view/health'

import { Calls } from '@/view/calls'
import { Connections } from '@/view/connections'
import { Repeats } from '@/view/repeats'
import { Summary } from '@/view/summary'
import { Timeline } from '@/view/timeline'

type Press = { item: string; value?: PressValue }

const among = (list: readonly unknown[]) => (value: unknown) => list.includes(value)
const isCaller = (value: unknown) => value === null || typeof value === 'string'

/**
 * The page. It owns its state — the range, the pause, the caller shown, what was cleared — and
 * reads the host's record of traffic every second while it is on screen and not paused.
 *
 * What the header's switches chose — the view, the range, the chart, the caller — is kept with the
 * host for this container (`useKept`), so each Monitor on each kehikko opens as it was left, after a
 * restart too. The pause is not: a Monitor that came back paused would look broken.
 */
export function App() {
  const pressing = useRef<(press: Press) => unknown>(() => undefined)
  const host = useKehikot({ onPress: (press) => pressing.current(press) as never })
  const [view, setView] = useKept<View>(host, 'view', 'traffic', among(VIEWS))
  const [range, setRange] = useKept<Range>(host, 'range', 5, among(RANGES))
  const [style, setStyle] = useKept<Style>(host, 'style', 'lines', among(STYLES))
  const [caller, setCaller] = useKept<Caller | null>(host, 'caller', null, isCaller)
  const [paused, setPaused] = useState(false)
  const [clearedAt, setClearedAt] = useState(0)
  const [filter, setFilter] = useState<Filter>(() => ({ by: caller, text: '' }))
  const [order, setOrder] = useState<Caller[]>([])
  const callers = useRef<Caller[]>([])

  /* One handler for a press from the host's menus and from this page's own copy of them. A sentence is "not taken, and why". */
  const press = useCallback(({ item, value }: Press) => {
    const said = pressed(item, value, callers.current)
    if (typeof said === 'string') return said
    if ('view' in said) setView(said.view)
    else if ('range' in said) setRange(said.range)
    else if ('style' in said) setStyle(said.style)
    else if ('paused' in said) setPaused(said.paused)
    else if ('caller' in said) {
      setCaller(said.caller)
      setFilter((was) => ({ ...was, by: said.caller }))
    } else setClearedAt(Date.now())
  }, [setView, setRange, setStyle, setCaller])
  pressing.current = press
  /* Off screen (kept hidden on another kehikko, or the window hidden): nothing is read (`useOnScreen`). */
  const shown = useOnScreen(host.visible)
  const resting = paused || !shown
  const traffic = useTraffic(host.where === 'hosted' ? host.request : null, resting, clearedAt)
  /* Read whatever the view: the footer says the health in both. */
  const health = useHealth(host.where === 'hosted', resting)

  /* A colour follows its caller from the moment it first called, whatever the filter or the ranks. */
  useEffect(() => {
    setOrder((was) => {
      const next = colourOrder(was, traffic.calls)
      return next.length === was.length ? was : next
    })
  }, [traffic.calls])
  const seen = useMemo(() => {
    const out: Caller[] = [...order]
    for (const call of traffic.calls) {
      const who = callerOf(call)
      if (!out.includes(who)) out.push(who)
    }
    return out
  }, [order, traffic.calls])
  callers.current = seen

  const footed = host.where === 'hosted' && host.drawsFooter === true
  const state: HeaderState = { view, range, style, paused, caller, callers: seen, footed }
  const items = useMemo(() => headerItems(state), [view, range, style, paused, caller, seen, footed]) // eslint-disable-line react-hooks/exhaustive-deps
  const { header } = host
  useEffect(() => header(items), [header, items])

  return (
    <Screen
      host={host}
      traffic={traffic}
      health={health}
      items={items}
      state={state}
      order={order}
      filter={filter}
      onFilter={setFilter}
      onPress={press}
      onShow={(repeat) => setFilter({ by: repeat.by, text: repeat.reason ? `${repeat.where} ${repeat.reason}` : repeat.where })}
    />
  )
}

/** Everything drawn, from plain values, so a test draws it with made-up traffic (test/render.test.tsx). */
export function Screen({
  host,
  traffic,
  health = { snapshot: emptySnapshot(), problem: null },
  items,
  state,
  order,
  filter,
  onFilter = () => {},
  onPress = () => {},
  onShow = () => {},
  now: given,
}: {
  host: Host
  traffic: Traffic
  health?: Health
  items: HeaderItem[]
  state: HeaderState
  order: readonly Caller[]
  filter: Filter
  onFilter?: (filter: Filter) => void
  onPress?: (press: Press) => void
  onShow?: (repeat: Repeat) => void
  now?: number
}) {
  const server = useServerStanding()
  const [again, setAgain] = useState(0)
  /* The one screen for every not-ready moment: waiting for a host, no host, a stopped server. No project is needed. */
  const cover = coverFor({ ...host, server }, { host: true, project: false })
  /* Paused, the picture stands still at the last read. */
  const now = given ?? traffic.at ?? Date.now()
  const found = useMemo(() => repeats(traffic.calls, now), [traffic.calls, now])
  const rows = useMemo(() => summary(traffic.calls, now), [traffic.calls, now])
  const ranked = useMemo(() => judge(health.snapshot, now), [health.snapshot, now])

  /*
   * The footer the host draws, when it draws one (2.38.0): live or paused, the rate, repeats, the
   * first limit, what was missed, and Clear beside them. The page then draws no status line above
   * the timeline. An older host draws no footer, and the line stays (Clear stays in the header).
   */
  const footed = host.where === 'hosted' && host.drawsFooter === true
  const footerSaid = footed
    ? JSON.stringify(
        cover
          ? []
          : footerItems({ paused: state.paused, rows, repeating: found.length, budgets: budgetLines(traffic.limits, traffic.budgets), gap: Boolean(traffic.gap), problem: traffic.problem ?? null, health: { snapshot: health.snapshot, judged: ranked } }),
      )
    : null
  const { footer } = host
  useEffect(() => {
    if (footerSaid) footer?.(JSON.parse(footerSaid))
  }, [footer, footerSaid])

  /* The host's cover is held until the page is drawn (protocol 2.70.0): once the first read of the traffic has
     come back or failed, or a cover says why there is nothing to read. */
  const drawn = cover !== null ? cover !== 'waiting' : traffic.at !== null || Boolean(traffic.problem)
  const { ready } = host
  useEffect(() => {
    if (drawn) ready?.()
  }, [drawn, ready])

  return (
    <div className="flex h-screen min-w-0 flex-col text-sm">
      {host.where === 'unhosted' ? (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="text-xs font-medium">Monitor</span>
          <HeaderMenus items={items} onPress={onPress} />
        </header>
      ) : null}
      <main key={again} data-kehikot-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        {cover ? (
          <Cover state={cover} name="Monitor" onRetry={() => setAgain((n) => n + 1)} />
        ) : state.view === 'health' ? (
          <HealthView snapshot={health.snapshot} judged={ranked} problem={health.problem} now={now} />
        ) : traffic.problem && !traffic.calls.length ? (
          <p className="text-muted-foreground rounded-md border p-3 text-xs" role="status">
            {traffic.problem}
          </p>
        ) : (
          <>
            {footed ? null : <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs" role="status" aria-live="polite">
              <span>{state.paused ? 'Paused: the picture stands still. Turn Paused off to go on.' : 'Live: read every second, on this computer only.'}</span>
              {traffic.gap ? <span>Some calls were made faster than Monitor read them and are not shown.</span> : null}
              {traffic.problem ? <span>{traffic.problem}</span> : null}
            </p>}
            <Timeline calls={traffic.calls} range={state.range} style={state.style} order={order} only={state.caller} now={now} />
            <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
              <Repeats repeats={found} onShow={onShow} />
              <Summary rows={rows} order={order} budgets={traffic.budgets} limits={traffic.limits} />
            </div>
            <Calls calls={traffic.calls} order={order} filter={filter} onFilter={onFilter} callers={state.callers} />
            <Connections processes={traffic.processes} />
          </>
        )}
      </main>
    </div>
  )
}
