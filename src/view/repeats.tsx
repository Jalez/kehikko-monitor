import { Repeat as RepeatIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { REPEAT_MIN, REPEAT_WINDOW_MS, spoken, type Repeat } from '../traffic/model.ts'

/**
 * Repeats: the same caller asking the same thing again and again — the redundant-call finder, so
 * it stands first after the timeline. Each is a sentence ("Kanban asks Kehikot /host/call
 * (tracker.get) every 2 s"), with how many times and whether the answers were the same.
 */
export function Repeats({ repeats, onShow }: { repeats: readonly Repeat[]; onShow: (repeat: Repeat) => void }) {
  return (
    <section aria-labelledby="repeats-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="repeats-title" className="flex items-center gap-2 text-sm font-medium">
        <RepeatIcon className="size-4" aria-hidden />
        Repeats
        <Badge variant={repeats.length ? 'default' : 'secondary'}>{repeats.length}</Badge>
      </h2>
      <p className="text-muted-foreground text-xs">
        The same call made {REPEAT_MIN} or more times in the last {spoken(REPEAT_WINDOW_MS)}. A call that gets the same answer every time may not need making that often.
      </p>
      {repeats.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">Nothing is repeating right now.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {repeats.slice(0, 12).map((repeat) => (
            <li key={repeat.key} className="bg-card flex min-w-0 flex-col items-start gap-1.5 rounded-md border p-2 @lg:flex-row @lg:items-center @lg:justify-between">
              <span className="min-w-0 flex-1 text-xs break-words">{repeat.said}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {repeat.same >= repeat.count - 1 ? <Badge variant="outline">same answer</Badge> : null}
                {repeat.free ? <Badge variant="outline">{repeat.free} free</Badge> : null}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onShow(repeat)} aria-label={`Show these calls: ${repeat.said}`}>
                  Show calls
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
