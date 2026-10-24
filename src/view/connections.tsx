import type { TrafficProcesses } from 'kehikot-module-protocol'

import { bytesSaid, callerName } from '../traffic/model.ts'

/**
 * Connections nobody reported: what is open on Kehikot's processes and each module's, as Kehikot
 * last looked. No reason is known for any of them — that is the point of listing them.
 */
export function Connections({ processes }: { processes: TrafficProcesses | null }) {
  const outside = processes?.connections.filter((one) => !one.local) ?? []
  const inside = processes?.connections.filter((one) => one.local) ?? []
  return (
    <section aria-labelledby="connections-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="connections-title" className="text-sm font-medium">
        Open connections <span className="text-muted-foreground font-normal">(no reason given)</span>
      </h2>
      {!processes ? (
        <p className="text-muted-foreground text-xs">Kehikot has not looked at its processes yet.</p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {outside.length} to the outside, {inside.length} on this computer.
            {processes.why ? ` ${processes.why}` : ''} A connection that opens and closes between two looks is not seen.
          </p>
          {outside.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="text-muted-foreground text-left">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Caller</th>
                    <th className="py-1 pr-2 font-normal">Process</th>
                    <th className="py-1 pr-2 font-normal">To</th>
                    {processes.bytes ? <th className="py-1 text-right font-normal">In / out</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {outside.map((one) => (
                    <tr key={`${one.pid}:${one.remote}:${one.port}:${one.since}`} className="border-t">
                      <td className="py-1 pr-2">{callerName(one.by)}</td>
                      <td className="py-1 pr-2">{one.process}</td>
                      <td className="max-w-48 truncate py-1 pr-2 font-mono" title={`${one.remote}:${one.port}`}>
                        {one.remote || 'unknown'}
                        {one.port ? `:${one.port}` : ''} <span className="text-muted-foreground">{one.proto}</span>
                      </td>
                      {processes.bytes ? (
                        <td className="py-1 text-right">
                          {bytesSaid(one.bytesIn ?? 0)} / {bytesSaid(one.bytesOut ?? 0)}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
