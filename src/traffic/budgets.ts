import type { TrafficAccount, TrafficAllowance, TrafficBudget, TrafficLimits } from 'kehikot-module-protocol'

/**
 * The budgets Kehikot spends for the person, as lines a person reads: their GitHub account's real
 * limits, Kehikot's share of them, the budget without an account only when it was used, and a pause
 * said in words. Pure, and shared by the page (`Summary`) and the door's `traffic` tool, so both say
 * the same. Against a Kehikot before protocol 2.24.0 (no `limits`), the old `budgets` list as it was.
 */

/** One line: its words, and a meter when it is an amount used of a limit. */
export interface BudgetLine {
  key: string
  text: string
  meter?: { used: number; limit: number; label: string }
  /** A pause: held calls, said in words (never colour alone). */
  paused?: boolean
}

const count = (n: number): string => n.toLocaleString('en-US')

/** A time of day, as the person reads it: "11:00". */
export const timeSaid = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function accountLines(forge: 'GitHub' | 'GitLab', account: TrafficAccount, key: string): BudgetLine[] {
  const who = account.login ? `${forge} as ${account.login}` : `Your ${forge} account`
  const lines: BudgetLine[] = []
  const one = (limit: TrafficAllowance | null, kind: 'core' | 'graphql') => {
    if (!limit) return
    const unit = kind === 'graphql' ? ' points' : ''
    const head = kind === 'graphql' ? `${who}, GraphQL` : who
    const resets = limit.resets ? ` · resets ${timeSaid(limit.resets)}` : ''
    lines.push({ key: `${key}.${kind}`, text: `${head}: ${count(limit.remaining)} of ${count(limit.limit)}${unit} left this hour${resets}` })
    if (limit.share) {
      lines.push({
        key: `${key}.${kind}.share`,
        text: `Kehikot's share: ${count(limit.share.used)} of ${count(limit.share.limit)}${unit} used`,
        meter: { used: limit.share.used, limit: limit.share.limit, label: `Kehikot's share of ${head}${unit}: ${count(limit.share.used)} of ${count(limit.share.limit)} used` },
      })
    }
  }
  one(account.core, 'core')
  one(account.graphql, 'graphql')
  if (account.paused) {
    const why = account.why ? `${account.why.replace(/[.\s]+$/, '')}.` : `Kehikot is holding its ${forge} reads for now.`
    lines.push({ key: `${key}.paused`, text: `Paused: ${why}`, paused: true })
  }
  return lines
}

/** The budget without an account, under its own plain name. */
function anonymousLine(budget: TrafficBudget): BudgetLine {
  return {
    key: 'github.anonymous',
    text: `Without an account: ${count(budget.used)} of ${count(budget.limit)} used (when gh isn't signed in)`,
    meter: { used: budget.used, limit: budget.limit, label: `GitHub without an account: ${count(budget.used)} of ${count(budget.limit)} used` },
  }
}

/** The old list, as Monitor 0.1.0 said it: for a Kehikot that does not say `limits`. */
function oldLines(budgets: readonly TrafficBudget[]): BudgetLine[] {
  return budgets.map((budget, i) => ({
    key: `budget.${i}`,
    text: `${budget.name}: ${count(budget.used)} used, ${count(budget.left)} left of ${count(budget.limit)} an hour${budget.note ? `. ${budget.note.replace(/[.\s]+$/, '')}.` : ''}`,
    meter: { used: budget.used, limit: budget.limit, label: `${budget.name}: ${budget.used} of ${budget.limit} used` },
  }))
}

/** Every line, in order: GitHub's account, the budget without one when used, GitLab's account. */
export function budgetLines(limits: TrafficLimits | null | undefined, budgets: readonly TrafficBudget[]): BudgetLine[] {
  if (!limits) return oldLines(budgets)
  const lines: BudgetLine[] = []
  const github = limits.github
  if (github?.account) lines.push(...accountLines('GitHub', github.account, 'github.account'))
  if (github?.anonymous && github.anonymous.used > 0) lines.push(anonymousLine(github.anonymous))
  if (limits.gitlab?.account) lines.push(...accountLines('GitLab', limits.gitlab.account, 'gitlab.account'))
  if (!lines.length && github) lines.push({ key: 'github.none', text: 'GitHub: nothing counted against a limit yet.' })
  return lines
}
