import { useEffect } from 'react'
import { useHost, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import type { HostEvents } from 'kehikot-module-protocol/client'

import { hideTip } from '@/lib/one-tip'
import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host: the protocol's `useHost`, which has already put the theme on
 * <html>. A plain object, so a screen renders in a test without a host. Monitor is about this
 * computer, not a project, so it reads no project, epic or parts. What it keeps with the host
 * (`kept`, `remember`, `read`, through `useKept`) is what its header's switches chose, for this
 * container.
 */
export type Host = Pick<ProtocolHost, 'where' | 'projectPath' | 'theme' | 'header' | 'request'> &
  Partial<Pick<ProtocolHost, 'kept' | 'remember' | 'footer' | 'drawsFooter'>>

/** The host as the page holds it: a screen's `Host`, and what `useKept` reads and writes. */
export type Live = Host & Pick<ProtocolHost, 'kept' | 'remember' | 'read'>

export function useKehikot(events: HostEvents = {}): Live {
  const host = useHost(ID, events)
  /* Off screen (`kehikot.visible` false): no chart tooltip is left standing for when it comes back. */
  useEffect(() => {
    if (!host.visible) hideTip()
  }, [host.visible])
  return host
}
