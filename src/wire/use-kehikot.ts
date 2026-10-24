import { useHost, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import type { HostEvents } from 'kehikot-module-protocol/client'

import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host: the protocol's `useHost`, which has already put the theme on
 * <html>. A plain object, so a screen renders in a test without a host. Monitor is about this
 * computer, not a project, so it reads no project, epic or parts.
 */
export type Host = Pick<ProtocolHost, 'where' | 'projectPath' | 'theme' | 'header' | 'request'>

export function useKehikot(events: HostEvents = {}): Host {
  return useHost(ID, events)
}
