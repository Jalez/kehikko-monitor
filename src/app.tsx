import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { HeaderItem, PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'

import { HeaderMenus } from '@/components/header-menus'
import { headerItems, keptStyle, pressed, type HeaderState } from '@/header'
import { callerOf, colourOrder, repeats, summary, type Caller, type Filter, type Range, type Repeat, type Style } from '@/traffic/model'
import { useKehikot, type Host } from '@/wire/use-kehikot'
import { useTraffic, type Traffic } from '@/wire/use-traffic'

import { Calls } from '@/view/calls'
import { Connections } from '@/view/connections'
import { Repeats } from '@/view/repeats'
import { Summary } from '@/view/summary'
import { Timeline } from '@/view/timeline'

type Press = { item: string; value?: PressValue }

/**
 * The page. It owns its state — the range, the pause, the caller shown, what was cleared — and
 * reads the host's record of traffic every second while it is open and not paused.
 */
export function App() {
  const [range, setRange] = useState<Range>(5)
  const [paused, setPaused] = useState(false)
  const [caller, setCaller] = useState<Caller | null>(null)
  const [clearedAt, setClearedAt] = useState(0)
  const [filter, setFilter] = useState<Filter>({ by: null, text: '' })
  const [order, setOrder] = useState<Caller[]>([])
  const callers = useRef<Caller[]>([])

  /* One handler for a press from the host's menus and from this page's own copy of them. A sentence is "not taken, and why". */
  const press = useCallback(({ item, value }: Press) => {
    const said = pressed(item, value, callers.current)
    if (typeof said === 'string') return said
    if ('range' in said) setRange(said.range)
    else if ('style' in said) setStyle(said.style)
    else if ('paused' in said) setPaused(said.paused)
    else if ('caller' in said) {
      setCaller(said.caller)
      setFilter((was) => ({ ...was, by: said.caller }))
    } else setClearedAt(Date.now())
  }, [])
  const host = useKehikot({ onPress: press })
  /* How the chart is drawn: kept with the host, so the choice is there on the next open; Lines until one is made. */
  const [chosen, setStyle] = useState<Style | null>(null)
  const style = chosen ?? keptStyle(host.kept)
  const remember = host.remember
  useEffect(() => {
    if (chosen !== null) remember?.({ style: chosen })
  }, [chosen, remember])
  const traffic = useTraffic(host.where === 'hosted' ? host.request : null, paused, clearedAt)

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

  const state: HeaderState = { range, style, paused, caller, callers: seen }
  const items = useMemo(() => headerItems(state), [range, style, paused, caller, seen]) // eslint-disable-line react-hooks/exhaustive-deps
  const { header } = host
  useEffect(() => header(items), [header, items])

  return (
    <Screen
      host={host}
      traffic={traffic}
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

  return (
    <div className="flex h-screen min-w-0 flex-col text-sm">
      {host.where === 'unhosted' ? (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="text-xs font-medium">Monitor</span>
          <HeaderMenus items={items} onPress={onPress} />
        </header>
      ) : null}
      <main key={again} className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        {cover ? (
          <Cover state={cover} name="Monitor" onRetry={() => setAgain((n) => n + 1)} />
        ) : traffic.problem && !traffic.calls.length ? (
          <p className="text-muted-foreground rounded-md border p-3 text-xs" role="status">
            {traffic.problem}
          </p>
        ) : (
          <>
            <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs" role="status" aria-live="polite">
              <span>{state.paused ? 'Paused: the picture stands still. Turn Paused off to go on.' : 'Live: read every second, on this computer only.'}</span>
              {traffic.gap ? <span>Some calls were made faster than Monitor read them and are not shown.</span> : null}
              {traffic.problem ? <span>{traffic.problem}</span> : null}
            </p>
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
