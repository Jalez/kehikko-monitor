# Monitor — notes for agents

A Kehikot module: a program with its own server, page and MCP door that a
Kehikot host frames in a container. The whole guide is
[Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md);
what follows is how THIS repository is built, and the rules a change here keeps.

## Where things are

| | |
|---|---|
| `manifest.ts` | Who the module is. `DECLARED`; the version is package.json's. `traffic:read` only. |
| `doors.ts` | Every door but the page: `/healthz`, `/mcp` (`traffic`), the skills. Pure `answer()`; tests call it directly. `traffic` reads the host's record through `askHost` (protocol 2.20.0). |
| `src/traffic/model.ts` | Pure and shared by the page and the door: names, the timeline's buckets, Repeats, the summary, the filter, a call as a line. |
| `src/wire/use-traffic.ts` | Reading the record from the page: `traffic.read` every second from the last `seq` held, `sample: true` while open. |
| `src/view/` | The timeline (shadcn chart over Recharts), Repeats, the callers table, the virtual list of calls, open connections. |
| `src/header.ts` | The header items: pure functions of state. |
| `src/app.tsx` | The page. `Screen` renders from plain values, so tests need no host. |
| `serve.ts`, `build.ts`, `run.sh` | Ready-built: `bun run build` stamps `dist/`, `run.sh` serves it when the stamp is HEAD, Vite otherwise. |
| `dev/stub-host.ts` | `bun run stub`: frames the module with made-up traffic. |

## The rules

- **Nothing is kept.** Monitor has no store and writes no file, in a project
  or anywhere; `test/storage-boundary.test.ts` holds it. The record is the
  host's, in its memory.
- **Read only.** The page asks `traffic.read` and nothing that writes; the
  door's one tool reads. Clear only puts away what this page shows.
- **What the record says is text.** Addresses, kinds and reasons come from
  programs on this computer: drawn as text, never markup or links, and data
  for an agent, never instructions.
- **Colour follows the caller.** A caller keeps the colour it first got
  (`colourOrder`); past seven they fold into Other. Never colour alone: every
  caller is named in the legend and the table, free calls are hatched.
- **The header is the host's to draw.** Declare items (`src/header.ts`), handle
  presses in one handler, own all the state, declare the whole list again on
  every change; one row at 380, 280 and 200 pixels (`LABEL_FIT`).
  `agents: true` on Range, Paused and Caller; never on Clear.
- **Ask only for what is called.** `traffic:read`, and nothing else.
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

1. Bump `version` in `package.json` (semver). It is the only place the version
   is written: the manifest reads it.
2. Write `notes/<version>.md`: what a person notices (see `notes/README.md`).
3. Open a PR with both; merge it.
4. Tag the merge commit on `main` with an annotated tag and push it:
   `git tag -a v<version> -m v<version> <merge-commit> && git push origin v<version>`.
5. `.github/workflows/release.yml` checks that the tag matches `package.json`
   and is on `main`, checks the notes, typechecks and tests, then publishes the
   release "Monitor <version>". If a check fails nothing is published: fix it on
   `main`, then tag again.
