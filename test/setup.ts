import { GlobalRegistrator } from '@happy-dom/global-registrator'

/* Bun's own networking, kept: a test that serves and fetches over loopback (the speed test's) needs Bun's
   fetch, Response and abort signals, not the DOM's stand-ins, which Bun's server and fetch refuse. */
const NET = ['fetch', 'Request', 'Response', 'Headers', 'AbortController', 'AbortSignal'] as const
const bun = Object.fromEntries(NET.map((name) => [name, globalThis[name]]))

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()

Object.assign(globalThis, bun)
