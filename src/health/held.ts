import { wantsQueued, workWant, type WorkQueue } from 'kehikot-module-protocol'

import type { Outside } from './heavy.ts'

/**
 * Which heavy work started on its own the PROVIDER of heavy work in turn wants handed to it: its descriptor's `wants`, read
 * with the protocol's `workWant` and judged with `wantsQueued`, never by Monitor's own numbers. Pure, held
 * by the sampler.
 *
 * - CPU is tracked over time per run (`Held`), so a rule's `sustainedSeconds` holds: a run is judged by
 *   the least CPU it has used since it last dropped below the rule's `minCpu`, and for how long.
 * - A kind the provider leaves out, a test run that is not the whole suite when it wants whole suites
 *   only, a short spike: none is flagged, so none goes in the Inbox, on screen or to the session.
 * - With no provider, nothing is flagged: there is nothing to hand work to.
 */

/** How long a run's samples are kept, and at most how many. */
export const HELD_MS = 60 * 60_000
export const HELD_MAX = 720

interface Sample {
  at: number
  pcpu: number
}

/** The least CPU a run has held, and for how long, in seconds. */
export interface Streak {
  cpu: number
  seconds: number
}

export class Held {
  private readonly runs = new Map<number, { word: string; samples: Sample[] }>()

  /** One look's heavy processes: a sample for each; a run that ended, or whose pid is now another program, is forgotten. */
  see(found: readonly Pick<Outside, 'pid' | 'word' | 'pcpu'>[], now: number): void {
    const live = new Set<number>()
    for (const one of found) {
      live.add(one.pid)
      let run = this.runs.get(one.pid)
      if (!run || run.word !== one.word) {
        run = { word: one.word, samples: [] }
        this.runs.set(one.pid, run)
      }
      run.samples.push({ at: now, pcpu: one.pcpu })
      while (run.samples.length > HELD_MAX || (run.samples[0] && now - run.samples[0].at > HELD_MS)) run.samples.shift()
    }
    for (const pid of [...this.runs.keys()]) if (!live.has(pid)) this.runs.delete(pid)
  }

  /** How long the run has held at least `minCpu`, back from its newest sample, and the least it used in that time. */
  streak(pid: number, minCpu: number): Streak {
    const samples = this.runs.get(pid)?.samples ?? []
    const newest = samples[samples.length - 1]
    if (!newest) return { cpu: 0, seconds: 0 }
    if (newest.pcpu < minCpu) return { cpu: newest.pcpu, seconds: 0 }
    let cpu = newest.pcpu
    let since = newest.at
    for (let at = samples.length - 1; at >= 0; at--) {
      const sample = samples[at]!
      if (sample.pcpu < minCpu) break
      cpu = Math.min(cpu, sample.pcpu)
      since = sample.at
    }
    return { cpu, seconds: (newest.at - since) / 1000 }
  }
}

/**
 * The runs the provider wants handed to it, from one look: `commands` holds each process's command line as
 * `ps` said it (read only to tell a whole suite from a targeted run, then dropped). None without a provider.
 */
export function wanted<T extends Pick<Outside, 'pid' | 'kind'>>(found: readonly T[], provider: WorkQueue | null, held: Held, commands: ReadonlyMap<number, string>): T[] {
  if (!provider) return []
  return found.filter((one) => {
    const want = workWant(provider, one.kind)
    if (!want) return false
    const { cpu, seconds } = held.streak(one.pid, want.minCpu)
    return wantsQueued(provider, { kind: one.kind, command: commands.get(one.pid) ?? '', cpu, seconds })
  })
}
