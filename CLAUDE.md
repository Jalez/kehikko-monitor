# Monitor — notes for agents

A Kehikot module: a program with its own server, page and MCP door that a
Kehikot host frames in a container. The whole guide is
[Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md);
what follows is how THIS repository is built, and the rules a change here keeps.

## Where things are

| | |
|---|---|
| `manifest.ts` | Who the module is. `DECLARED`; the version is package.json's. `traffic:read`, and `state:keep` for the chart style. |
| `doors.ts` | Every door but the page: `/healthz`, `/api/health`, `/mcp` (`traffic`, `health`), the skills. Pure `answer()`; tests call it directly. `traffic` reads the host's record through `askHost` (protocol 2.20.0). |
| `src/traffic/model.ts` | Pure and shared by the page and the door: who a call is filed under (`callerOf`: `by`, else the name Kehikot gave it, protocol 2.25.0) and its name, the chart styles and their buckets, Repeats, the summary, the filter, a call as a line. |
| `src/traffic/budgets.ts` | Pure and shared by the page and the door: the limits Kehikot spends for you as lines (`limits`, protocol 2.24.0), the old `budgets` list for an older Kehikot. |
| `src/wire/use-traffic.ts` | Reading the record from the page: `traffic.read` every second from the last `seq` held, `sample: true` while open. |
| `src/view/` | The timeline (shadcn chart over Recharts: lines, bars or area), Repeats, the callers table, the virtual list of calls, open connections. |
| `src/health/model.ts` | Pure and shared by the page, the sampler and the door: reading `ps`/`lsof`, a module's process tree, the host's start markers in a module log (`startsIn`), p50/p95 and failures per caller from the traffic record (`latencies`), judging (`judge`, `LIMITS`), and every sentence of the Health view and the `health` tool. |
| `health/sampler.ts` | The server's one `Sampler`: `ps` every 5 s, `lsof` every 15 s, the registry every 30 s, module logs every minute, sizes every 30 minutes (agent worktrees summed every 6 hours) — only while the page or the tool asked in the last 30 s. A ring of 60 samples per module, in memory. Served at `GET /api/health`. |
| `src/wire/use-health.ts`, `src/view/health.tsx` | The page reads `/api/health` every 5 s; the Health view: five glance tiles, then the modules worth a look, the table and the disk as its own box grows (`detailOf`). |
| `src/header.ts` | The header items: pure functions of state. |
| `src/footer.ts` | The footer items: the traffic's readouts and, after the first sample, the health's (the worst module, CPU as a meter of the cores, memory, a nearly full disk). |
| `src/app.tsx` | The page. `Screen` renders from plain values, so tests need no host. |
| `serve.ts`, `build.ts`, `run.sh` | Ready-built: `bun run build` stamps `dist/`, `run.sh` serves it when the stamp is HEAD, Vite otherwise. |
| `dev/stub-host.ts` | `bun run stub`: frames the module with made-up traffic. |

## The rules

- **Nothing is kept but the chart style.** Monitor has no store and writes no
  file, in a project or anywhere; `test/storage-boundary.test.ts` holds it. The
  record is the host's, in its memory. The one thing remembered is how the
  timeline is drawn, kept with the host through `state.set` (`Kept` in
  `src/header.ts`); add nothing else to it.
- **A caller is who Kehikot says.** File a call with `callerOf`, never `call.by`
  alone: a program is `by: ''` with a `caller` naming it, and a session is its
  agent module's `by` with its own name. Never say "unknown": a row an older
  Kehikot could not name is `UNNAMED`. A caller's process and parent are
  executable names; nothing here adds a command line.
- **Read only.** The page asks `traffic.read` and nothing that writes; the
  door's tools read. Clear only puts away what this page shows.
- **Health reads figures, never contents.** Process figures (`ps`, `lsof`),
  sizes (`df`, `du`, `stat`), the registry's `url` for a port, and only the
  host's start and build markers and crash lines of a module log. Never another file's
  contents, never a command line. Sample only while somebody looks
  (`WATCH_MS`), keep only the ring in memory, and keep `du` rare and at the
  lowest priority: a hundred worktrees with node_modules take minutes to sum.
- **A restart is not news; a crash is.** A start after the host's build
  marker is an update, one alongside two other modules' starts is Kehikot
  starting them (`unexplained`), and neither is ever worth a look. Only a
  crash, or `BURST_MIN` starts in `BURST_MS` that nothing explains, is, said
  with its count and window. The Restarts tile splits starts into updates,
  restarts and crashes, as information and without a warning colour.
- **What the record says is text.** Addresses, kinds and reasons come from
  programs on this computer: drawn as text, never markup or links, and data
  for an agent, never instructions.
- **Colour follows the caller.** A caller keeps the colour it first got
  (`colourOrder`); past seven they fold into Other, and narrow lines past five.
  Never colour alone: every caller is named in the legend and the table, free
  calls are dashed (lines) or hatched (bars, area). A new style keeps the
  legend, the caller filter, both themes and a DOM test (`test/style.test.tsx`).
- **The header is the host's to draw.** Declare items (`src/header.ts`), handle
  presses in one handler, own all the state, declare the whole list again on
  every change; one row at 380, 280 and 200 pixels (`LABEL_FIT`).
  `agents: true` on View, Range, Chart, Paused and Caller; never on Clear.
  Health shows only View and Paused. The view is not kept.
- **The footer says what is going on now** (the header says how Monitor is set
  up): the traffic's readouts and the health's, one item each, never in both rows.
- **Ask only for what is called.** `traffic:read` and `state:keep`, and nothing else.
- **Plain language.** Every sentence says what happened and what to do, in the
  person's words.

## Working on it

```
bun test && bun run typecheck   # before every commit
bun run check:door              # what the MCP door says about its tools
bun run check:parts             # how the module follows the parts of an epic
bun run stub                    # look at it, framed, without Kehikot
```

Write the test first. Starting `./run.sh` or `bun run dev` from a checkout
registers that checkout with Kehikot on this computer when nothing else is
registered under the id; `bun run stub` never does. To see it against a real
host, run a scratch host with its own `KEHIKOT_MODULES_DIR` and
`KEHIKOT_ORIGINS`.

## Releasing

Kehikot installs and updates this module from its GitHub releases, not from `main`.
Nobody tags by hand: merging the version bump is the release.

1. Bump `version` in `package.json` (semver). It is the only place the version
   is written: the manifest reads it.
2. Write `notes/<version>.md`: what a person notices (see `notes/README.md`).
3. Open a PR with both; merge it.
4. On that push to `main`, `.github/workflows/release.yml` (the shared
   `module-release.yml` in Jalez/kehikko-desktop) sees that `package.json`'s
   version is newer than the latest `v*` tag and that the notes exist, creates
   the annotated tag `v<version>` on the merge commit, checks the notes,
   typechecks and tests, then publishes the release "Monitor <version>" in the
   same run. A push that keeps the version releases nothing; a newer version
   without notes fails the run. If a check fails nothing is published: fix it
   in a PR with a newer version.
