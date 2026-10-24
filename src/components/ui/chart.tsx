import * as React from 'react'
import * as RechartsPrimitive from 'recharts'

import { cn } from '@/lib/utils'

/*
 * shadcn/ui's chart (new-york), around Recharts 2. Colours come from a config by series key and
 * reach the marks as `--color-<key>` CSS variables, so a light and a dark value swap in one place.
 */

const THEMES = { light: '', dark: '.dark' } as const

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> })
}

type ChartContextProps = { config: ChartConfig }

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) throw new Error('useChart must be used within a <ChartContainer />')
  return context
}

/** CSS-variable-safe: a series key may hold characters a custom property name cannot. */
export const cssKey = (key: string) => key.replace(/[^a-zA-Z0-9_-]/g, '_')

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, one]) => one.theme || one.color)
  if (!colorConfig.length) return null
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
    return color ? `  --color-${cssKey(key)}: ${color};` : null
  })
  .join('\n')}
}
`,
          )
          .join('\n'),
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipPayload = { dataKey?: string | number; name?: string | number; value?: number | string; color?: string; payload?: Record<string, unknown> }

function ChartTooltipContent({
  active,
  payload,
  className,
  label,
  labelFormatter,
  formatter,
  hideZero = true,
}: {
  active?: boolean
  payload?: TooltipPayload[]
  className?: string
  label?: unknown
  labelFormatter?: (label: unknown, payload: TooltipPayload[]) => React.ReactNode
  formatter?: (value: number, key: string) => React.ReactNode
  hideZero?: boolean
}) {
  const { config } = useChart()
  if (!active || !payload?.length) return null
  const rows = payload.filter((item) => !hideZero || Number(item.value) > 0)
  return (
    <div className={cn('border-border/50 bg-background grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl', className)}>
      <div className="font-medium">{labelFormatter ? labelFormatter(label, payload) : String(label ?? '')}</div>
      {rows.length === 0 ? <div className="text-muted-foreground">No calls</div> : null}
      <div className="grid gap-1">
        {rows.map((item) => {
          const key = String(item.dataKey ?? item.name ?? 'value')
          const itemConfig = config[key]
          return (
            <div key={key} className="flex w-full items-center gap-2">
              <div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: `var(--color-${cssKey(key)})` }} />
              <span className="text-muted-foreground flex-1">{itemConfig?.label ?? key}</span>
              <span className="text-foreground font-mono font-medium tabular-nums">{formatter ? formatter(Number(item.value), key) : String(item.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartStyle, useChart }
