# Monitor — a Kehikot module

See what Kehikot and its modules are calling on your computer, live: who made
each call, what kind, to where, and for what reason — and which calls are made
again and again, so redundant polling stands out.

- **A live timeline.** Calls per second over the last 5, 15 or 60 minutes,
  stacked by caller. Free calls — answered from a cache, a 304, or held back by
  the GitHub budget — are hatched, so they read apart without colour.
- **Repeats.** The same caller asking the same thing five or more times in two
  minutes, in a sentence: "Kanban asks Kehikot /host/call (tracker.get) every
  2 s — 30 times, getting the same answer each time".
- **Callers.** Each caller's calls a minute, bytes, share of free calls and
  calls that came with no reason, and the GitHub limits: your account's, Kehikot's share of it, and any pause.
- **Every call.** Newest first, filtered by caller and by words; a row opens
  to show who, why, where, the answer and whether it was free.
- **Connections nobody reported.** What Kehikot sees open on its own processes
  and each module's, marked "no reason given".
- **Header.** Range, Paused and Caller in View; Clear in Run (yours only).
- **Agents ask, you watch.** The `traffic` tool answers "what is polling too
  much" from the same record; it reads only.

Everything stays on this computer. Kehikot keeps the record in its own memory
(the last 5,000 calls): addresses and reasons, never what a call carried — no
bodies, headers, tokens or query values.

## Skills

- **`/monitor`**: an agent reads what repeats and who calls the most, and tells
  you in a few lines. Offered in Kehikot's Settings › Skills like any module's.

## Data

None. Monitor keeps nothing in a project and writes no file: it reads
Kehikot's record of traffic (`traffic.read`, protocol 2.20.0).

## Try it

1. `bun install`, then `bun run stub`: the module, framed the way Kehikot frames
   it, with made-up traffic.
2. In Kehikot: the modules list › **Install from repository…** ›
   `Jalez/kehikko-monitor`. It needs a Kehikot on protocol 2.20.0 or later.

## Development

```
bun test               # the model, the doors, the header, reading the record, the page, the storage boundary
bun run typecheck
bun run stub           # look at it, framed, without Kehikot
```

How it is built and released, and the rules a change keeps: [CLAUDE.md](CLAUDE.md).
The whole guide: [Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md).
