import type { WorkQueue } from 'kehikot-module-protocol'

import { noticeBody, shortCommand, type Outside } from './heavy.ts'

/**
 * Telling an agent session that it started heavy work on its own, and how to hand it to the provider of heavy work in turn
 * here instead. Pure: the sampler holds one `Told`, asks it what is due after each look, sends each
 * (`messages.notifySession`) and marks it.
 *
 * - Only with a provider of heavy work in turn here (`services.find`) that takes that kind of work: the words are its
 *   descriptor's. With none, nothing is told; the screen still says it.
 * - Only for a session Monitor attributed with confidence: an agent CLI above the process and its session
 *   id read from its environment. A person's own terminal is never flagged, so never told.
 * - Once per run (by pid), and at most once per session and kind of work (`word`) in `TELL_AGAIN_MS`.
 * - Never while the person turned "Tell agents" off; the host declines it while they muted Monitor.
 */

/** How long after telling a session about one kind of work it is not told about it again. */
export const TELL_AGAIN_MS = 10 * 60_000

export interface Due {
  pid: number
  session: string
  word: string
  body: string
}

export class Told {
  private readonly pids = new Set<number>()
  private readonly last = new Map<string, number>()

  /**
   * What is due now, from one look: `commands` holds each flagged pid's command line as `ps` said it,
   * which goes, shortened, only into the body for that pid's own session.
   */
  due(list: readonly Outside[], provider: WorkQueue | null, commands: ReadonlyMap<number, string>, now: number): Due[] {
    if (!provider) return []
    const out: Due[] = []
    for (const one of list) {
      if (!one.session || this.pids.has(one.pid)) continue
      const command = commands.get(one.pid)
      if (!command) continue
      const body = noticeBody(one, provider, shortCommand(command))
      if (!body) continue
      const at = this.last.get(key(one.session, one.word))
      if (at !== undefined && now - at < TELL_AGAIN_MS) {
        /* Told about this kind of work a moment ago: not this run either, however long it lasts. */
        this.pids.add(one.pid)
        continue
      }
      out.push({ pid: one.pid, session: one.session, word: one.word, body })
    }
    return out
  }

  /** It was sent, or the host would not take it: either way, not again for this run. */
  mark(due: Pick<Due, 'pid' | 'session' | 'word'>, now: number): void {
    this.pids.add(due.pid)
    this.last.set(key(due.session, due.word), now)
  }

  /** Forget the runs that ended and the windows that passed, so nothing grows. */
  forget(live: ReadonlySet<number>, now: number): void {
    for (const pid of this.pids) if (!live.has(pid)) this.pids.delete(pid)
    for (const [one, at] of this.last) if (now - at >= TELL_AGAIN_MS) this.last.delete(one)
  }
}

const key = (session: string, word: string) => `${session}\n${word}`
