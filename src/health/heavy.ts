import { LIMITS, workQueueSaid, type WorkKind, type WorkQueue } from 'kehikot-module-protocol'

/**
 * Heavy work an agent session started on its own: a typecheck, a test suite, a browser test run, a
 * build or a big install running in a process tree under an agent CLI, and not under a run of the
 * module that provides heavy work in turn (the protocol's heavy-work service, found through the host;
 * its `marks` say how its runs are known). Pure, shared by the sampler, the page and the `health` tool.
 * Monitor names no such module: what it says about one is its descriptor's words.
 *
 * How it is told, cheaply (only while Monitor is watched, every `HEAVY_MS`):
 *
 * - One `ps -A -o pid=,ppid=,pcpu=,args=`. A process's command line is read here to CLASSIFY it into one
 *   word of `HEAVY` ("tsc", "vitest", …). It is never kept, drawn or said on screen: what is shown is the
 *   word, the CPU, and the session. The one place it goes is the notice to the session that started it
 *   (`noticeBody`), shortened (`shortCommand`), so that session can hand the same command to the provider.
 * - Its ancestors, from the same list: a line holding a provider's mark means it is in turn, and is not
 *   flagged; the nearest agent CLI (`AGENT`) is the session that started it. A heavy process with no agent
 *   CLI above it is a person's own, and is not flagged either.
 * - The session's id, once per flagged process: `ps -E` of that process, from which only the agent
 *   CLI's session variable (`SESSION_VARS`) is taken; the rest is dropped at once.
 */

export interface ProcLine {
  pid: number
  ppid: number
  /** CPU, in percent of one core, as `ps` says it. */
  pcpu: number
  args: string
}

/** The kinds of heavy work, each one word: what is said of it. */
export const HEAVY = ['playwright', 'tsc', 'vitest', 'jest', 'bun test', 'vite build', 'next build', 'webpack', 'bun install', 'npm ci', 'pnpm install'] as const
export type HeavyWord = (typeof HEAVY)[number]

/** The kind of work each word is, in the protocol's words (`WORK_KINDS`): what a provider says it takes. */
export const KIND_OF: Record<HeavyWord, WorkKind> = {
  playwright: 'test',
  tsc: 'typecheck',
  vitest: 'test',
  jest: 'test',
  'bun test': 'test',
  'vite build': 'build',
  'next build': 'build',
  webpack: 'build',
  'bun install': 'install',
  'npm ci': 'install',
  'pnpm install': 'install',
}

/** Runners whose script is the program: `node …/typescript/bin/tsc`, `npx vitest`. */
const RUNNERS = new Set(['node', 'deno', 'npx', 'bunx', 'pnpx'])
const base = (word: string) => (word.split('/').pop() ?? '').replace(/\.(m?js|cjs|ts)$/, '')

/**
 * The word of `HEAVY` a command line is, by its PROGRAM (the first word, or the script a runner
 * runs) and that program's first argument; null when it is none. A shell's line is never one: the
 * program it starts is looked at instead, so `grep tsc` or a script that names a tool is not.
 */
export function heavyWord(args: string): HeavyWord | null {
  const words = args.trim().split(/\s+/)
  let at = 0
  let program = base(words[0] ?? '')
  if (RUNNERS.has(program) || (program === 'bun' && (words[1] ?? '').includes('/'))) {
    at = 1
    while ((words[at] ?? '').startsWith('-')) at++
    program = base(words[at] ?? '')
  }
  const sub = words.slice(at + 1).find((word) => !word.startsWith('-')) ?? ''
  if (program === 'tsc' || program === 'vue-tsc' || program === 'tsgo') return 'tsc'
  if (program === 'vitest') return 'vitest'
  if (program === 'jest') return 'jest'
  if ((program === 'playwright' || (program === 'cli' && (words[at] ?? '').includes('playwright'))) && sub === 'test') return 'playwright'
  if (program === 'bun' && sub === 'test') return 'bun test'
  if (program === 'bun' && (sub === 'install' || sub === 'i')) return 'bun install'
  if (program === 'vite' && sub === 'build') return 'vite build'
  if (program === 'next' && sub === 'build') return 'next build'
  if (program === 'webpack' || program === 'webpack-cli') return 'webpack'
  if (program === 'npm' && (sub === 'ci' || sub === 'install')) return 'npm ci'
  if (program === 'pnpm' && (sub === 'install' || sub === 'i')) return 'pnpm install'
  return null
}

/** An agent CLI's own process, by its executable's name. */
export const AGENT = /^(?:\S*\/)?(claude|codex|gemini|opencode|vibe)(\s|$)/

/** The environment variables an agent CLI names its session by, in its children's environment. */
export const SESSION_VARS = ['KEHIKOT_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'] as const

/** One piece of heavy work an agent session started on its own. */
export interface Outside {
  pid: number
  /** What it is, in one word of `HEAVY`. */
  word: HeavyWord
  /** The kind of work it is (`KIND_OF`). */
  kind: WorkKind
  /** CPU of it and its children, in percent of one core. */
  pcpu: number
  /** The agent CLI's process, and its executable's name. */
  sessionPid: number
  agent: string
  /** The session's id, when its environment said it; null when it could not be read. */
  session: string | null
}

/** `ps -A -o pid=,ppid=,pcpu=,args=`: one process a line. Lines that do not read are skipped. */
export function parseProcLines(text: string): ProcLine[] {
  const out: ProcLine[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
    if (!match) continue
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), pcpu: Number(match[3]), args: match[4] ?? '' })
  }
  return out
}

/**
 * The heavy work agent sessions started on their own, from one process list: the topmost heavy process
 * of each tree (its own children are summed into it), under an agent CLI, and not under a line holding
 * one of `marks` (a provider's runs). `self` is Monitor's own pid, never flagged. The session ids are
 * filled in later (`sessionFrom`).
 */
export function heavyOutside(procs: readonly ProcLine[], self = 0, marks: readonly string[] = []): Outside[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  const children = new Map<number, number[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  const out: Outside[] = []
  for (const proc of procs) {
    if (proc.pid === self) continue
    const word = heavyWord(proc.args)
    if (!word) continue
    let agent: ProcLine | null = null
    let skip = false
    let at = byPid.get(proc.ppid)
    for (let step = 0; at && step < 32; step++, at = byPid.get(at.ppid)) {
      if (marks.some((mark) => at!.args.includes(mark))) {
        skip = true
        break
      }
      /* A heavy process above it is the one said: its children are part of it. */
      if (heavyWord(at.args)) {
        skip = true
        break
      }
      if (AGENT.test(at.args)) {
        agent = at
        break
      }
      if (at.ppid === at.pid || at.ppid <= 1) break
    }
    if (skip || !agent) continue
    let pcpu = 0
    const stack = [proc.pid]
    const seen = new Set<number>()
    while (stack.length && seen.size < 200) {
      const pid = stack.pop() as number
      if (seen.has(pid)) continue
      seen.add(pid)
      pcpu += byPid.get(pid)?.pcpu ?? 0
      stack.push(...(children.get(pid) ?? []))
    }
    out.push({ pid: proc.pid, word, kind: KIND_OF[word], pcpu: Math.round(pcpu), sessionPid: agent.pid, agent: AGENT.exec(agent.args)?.[1] ?? 'agent', session: null })
  }
  return out.sort((a, b) => b.pcpu - a.pcpu)
}

/** The session id from one process's `ps -E` line: only a session variable's value is taken. */
export function sessionFrom(text: string): string | null {
  for (const name of SESSION_VARS) {
    const match = new RegExp(`(?:^|\\s)${name}=([\\w.:-]{1,128})(?:\\s|$)`).exec(text)
    if (match) return match[1] ?? null
  }
  return null
}

/** Who started it, in a few words: "claude session 9186314e", or "claude session (pid 43715)". */
export const sessionSaid = (one: Pick<Outside, 'agent' | 'session' | 'sessionPid'>): string => (one.session ? `${one.agent} session ${one.session.slice(0, 8)}` : `${one.agent} session (pid ${one.sessionPid})`)

/** The one line said for heavy work agent sessions started on their own; '' when there is none. `provider` is the provider of heavy work in turn's own name, when one is here. */
export function outsideSaid(list: readonly Outside[], provider: string | null = null): string {
  if (!list.length) return ''
  const each = list.slice(0, 4).map((one) => `${one.word} from ${sessionSaid(one)} (${one.pcpu}% CPU)`)
  return `${provider ? `Heavy work running outside ${provider}` : 'Heavy work agent sessions started'}: ${each.join('; ')}${list.length > 4 ? `; and ${list.length - 4} more` : ''}`
}

/** How long a command line may be in a notice. */
export const COMMAND_MAX = 160

/**
 * A command line as a session is told it: each program's folder dropped (`/w/node_modules/.bin/vitest`
 * is `vitest`), what looks like a secret's value hidden, one line, at most `COMMAND_MAX` characters.
 */
export function shortCommand(args: string): string {
  const words = args.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().split(/\s+/)
  const out = words.map((word, at) => {
    if (/(token|secret|password|passwd|key|auth)[^=]*=/i.test(word)) return word.replace(/=.*$/, '=…')
    /* The program, and a runner's script: their names, not where they are installed. */
    if (word.startsWith('/') && (at === 0 || /\/(node_modules|\.bin|bin)\//.test(word))) return base(word) || word
    return word
  })
  const line = out.join(' ')
  return line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX - 1)}…` : line
}

/**
 * The notice to the session that started heavy work on its own, from the provider of heavy work in turn's descriptor: "vitest
 * is running outside Turns (95% CPU): `vitest run`. Run it through Turns: `… -- vitest run` from the same
 * folder, or with the turns_run tool." Null when the provider does not take that kind of work.
 */
export function noticeBody(one: Pick<Outside, 'word' | 'kind' | 'pcpu'>, provider: WorkQueue, command: string): string | null {
  const how = workQueueSaid(provider, one.kind, command)
  if (!how) return null
  const body = `${one.word} is running outside ${provider.name} (${one.pcpu}% CPU): \`${command}\`. ${how}`
  return body.length > LIMITS.MESSAGE_BODY ? `${body.slice(0, LIMITS.MESSAGE_BODY - 1)}…` : body
}
