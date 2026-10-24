#!/usr/bin/env bun
import { run } from 'kehikot-module-protocol/run'

import { BUILD, MANIFEST, TICKET, answer, ours, servingAt } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'

/**
 * This module over its BUILT page (`bun run build`), on the same doors and the same port rules as
 * the dev server. `run.sh` starts this when `dist/` carries a stamp of the commit checked out, and
 * Vite otherwise.
 *
 * Nothing this module says is decided here: the doors are `answer` in `doors.ts`, mounted by the
 * protocol's `run` exactly as `doors()` mounts them on Vite. A build that is not this checkout's is
 * never served: `run` answers the page with a 503 saying which commit each is, and what to run.
 */
const running = await run({ id: ID, prefer: PREFERRED_PORT, dir: import.meta.dirname, manifest: MANIFEST, answer, build: BUILD, ticket: TICKET, ours })

/* The skills name the origin really bound. */
servingAt(running.origin)
