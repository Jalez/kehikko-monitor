#!/usr/bin/env bun
/**
 * A host that is not a host, for looking at this module the way it is used,
 * before you install it in Kehikot:
 *
 *   bun run stub                       # then open the address it prints
 *   STUB_PROJECT=/path/to/a/project bun run stub
 *   STUB_THEME=dark bun run stub       # the page in the dark theme
 *   STUB_BACKFILL_MS=300000 bun run stub   # with five minutes of made-up traffic already there
 *
 * It starts this module (`vite`, with `KEHIKOT_ORIGINS` naming the stub, so the
 * page lets the stub frame it and the MCP door asks the stub which folders are
 * projects, and with a throwaway registry, so Kehikot never hears of this copy) and serves one page that frames it the way Kehikot does: the
 * greeting with a project, an epic and three parts, the header drawn from what
 * the module declares (press a switch and see it come back), the Inbox items it
 * reports, and every message logged. Pick parts with the buttons.
 *
 * Nothing here is shipped, and nothing in `src/` knows it exists. It is no
 * substitute for the real host: install the module there too (README, "Try it").
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MESSAGE, PROTOCOL } from 'kehikot-module-protocol'
import { originFor } from 'kehikot-module-protocol/serve'

import { PREFERRED_PORT } from '../manifest.ts'

/* Inside this module's ten-port slot, so it never lands on a neighbour. */
const PORT = Number(process.env.STUB_PORT ?? PREFERRED_PORT + 9)
const STUB = originFor(PORT)
const MODULE = originFor(PREFERRED_PORT)
const PROJECT = process.env.STUB_PROJECT ?? process.cwd()

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>stub host</title>
<style>
  body { font: 13px system-ui; margin: 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100vh }
  header { grid-column: 1 / -1; padding: 6px 10px; border-bottom: 1px solid #ccc; display: flex; gap: 8px; flex-wrap: wrap; align-items: center }
  iframe { width: 100%; height: 100%; border: 0 }
  aside { border-left: 1px solid #ccc; overflow: auto; padding: 6px; font: 11px ui-monospace, monospace; white-space: pre-wrap }
  #menus button.on { font-weight: bold }
</style></head>
<body>
  <header>
    <strong>stub host</strong>
    <span id="where"></span>
    <span>parts:</span><span id="parts"></span>
    <span>header:</span><span id="menus">(nothing declared)</span>
    <span>inbox:</span><span id="inbox">(nothing reported)</span>
  </header>
  <iframe id="frame" sandbox="allow-scripts allow-forms allow-same-origin" src="${MODULE}/app"></iframe>
  <aside id="log"></aside>
<script>
(function () {
  var frame = document.getElementById('frame');
  var log = document.getElementById('log');
  var parts = [
    { id: 'design', heading: 'Design', refs: [], picked: false },
    { id: 'build', heading: 'Build', refs: [], picked: false },
    { id: 'ship', heading: 'Ship', refs: [], picked: false }
  ];
  var kept = null;
  var presses = 0;
  function say(line) { log.textContent = line + '\\n' + log.textContent; }
  function context() {
    return { epic: 'try-the-module', project: ${JSON.stringify(PROJECT.split('/').pop())}, projectPath: ${JSON.stringify(PROJECT)},
      theme: ${JSON.stringify(process.env.STUB_THEME === 'dark' ? 'dark' : 'light')}, parts: parts, selection: [] };
  }
  function send(message) { frame.contentWindow.postMessage(message, '${MODULE}'); }
  function tell() { send(Object.assign({ type: '${MESSAGE.CONTEXT}', protocol: ${PROTOCOL} }, context())); }
  document.getElementById('where').textContent = ${JSON.stringify(PROJECT)} + ' › try-the-module';
  function drawParts() {
    var box = document.getElementById('parts');
    box.textContent = '';
    parts.forEach(function (part) {
      var b = document.createElement('button');
      b.textContent = (part.picked ? '✓ ' : '') + part.heading;
      b.onclick = function () { part.picked = !part.picked; drawParts(); tell(); };
      box.appendChild(b);
    });
  }
  drawParts();
  /* The header, drawn from the module's declaration as plain text and buttons: a module's strings are text. */
  function drawMenus(items) {
    var box = document.getElementById('menus');
    box.textContent = '';
    items.forEach(function (item) {
      (item.options || [{ id: null, label: item.label }]).forEach(function (option) {
        var b = document.createElement('button');
        b.textContent = item.label + (option.id ? ': ' + option.label : '');
        if (item.kind === 'switch' && item.value === option.id) b.className = 'on';
        b.onclick = function () {
          var value = item.kind === 'toggle' ? !item.checked : option.id;
          send({ type: '${MESSAGE.PRESS}', protocol: ${PROTOCOL}, id: 'press-' + (++presses), item: item.id, value: value === null ? undefined : value });
        };
        box.appendChild(b);
      });
    });
  }
  /* Made-up traffic, so the page has something to draw: a module polling the host every 2 s, the
     host's page asking now and then, two Claude sessions at the MCP door, curl from a terminal, and
     a release list read with a 304 once a minute. */
  var started = Date.now(), rows = [], seq = 0, made = started - ${Math.max(0, Math.min(3_600_000, Number(process.env.STUB_BACKFILL_MS) || 0))} - 1;
  function row(at, more) { seq++; rows.push(Object.assign({ seq: seq, at: at, ms: 2, reason: null, kind: 'GET', host: '127.0.0.1:4180', path: '/', status: 200, ok: true, by: 'kehikko', via: 'page', side: 'in', reported: 'host' }, more)); }
  function traffic(params) {
    var now = Date.now();
    for (var t = Math.floor(made / 1000) * 1000 + 1000; t <= now; t += 1000) {
      if ((t / 1000) % 2 === 0) row(t, { by: 'kehikot.kanban', kind: 'POST', path: '/host/call', reason: 'tracker.get', bytesOut: 512 });
      if ((t / 1000) % 7 === 0) row(t + 120, { path: '/host/quiet?project=…', reason: 'the page asks whether modules are quiet' });
      if ((t / 1000) % 3 === 0) row(t + 200, { by: 'kehikot.claude', via: 'process', kind: 'POST', path: '/mcp', reason: 'an agent asks Kehikot', caller: { kind: 'session', name: 'Claude session on Wide · methods', how: 'token', place: 'Wide · methods', process: 'claude', parent: 'bun', pid: 4242 } });
      if ((t / 1000) % 5 === 0) row(t + 250, { by: 'kehikot.claude', via: 'process', kind: 'POST', path: '/mcp', reason: 'an agent asks Kehikot', caller: { kind: 'session', name: 'Claude session on Wide · results', how: 'token', place: 'Wide · results', process: 'claude', parent: 'bun', pid: 4243 } });
      if ((t / 1000) % 11 === 0) row(t + 400, { by: '', via: 'process', path: '/host/health', reason: 'is Kehikot up', caller: { kind: 'program', name: 'curl, from your terminal (zsh)', how: 'process', process: 'curl', parent: 'zsh', pid: 9000 + (t / 1000) % 100 } });
      if ((t / 1000) % 60 === 0) row(t + 300, { side: 'out', via: 'server', host: 'api.github.com', path: '/repos/owner/repo/releases', status: 304, cache: 'not-modified', reason: 'GitHub releases: owner/repo', reported: 'host' });
    }
    made = now;
    if (rows.length > 5000) rows = rows.slice(-5000);
    var since = params.since || 0;
    return { calls: rows.filter(function (r) { return r.seq > since; }), newest: seq, oldest: rows.length ? rows[0].seq : 0, gap: false, kept: 5000, started: started,
      budgets: [{ name: 'GitHub without an account', used: 2, limit: 30, left: 28, resets: null, note: 'Made up by the stub host.' }], processes: null,
      limits: { github: {
        account: { login: 'someone', paused: false, why: '', until: null, at: now,
          core: { limit: 5000, used: 188, remaining: 4812, resets: now + 30 * 60000, share: { limit: 1000, used: 312 }, floor: 500 },
          graphql: { limit: 5000, used: 40, remaining: 4960, resets: now + 45 * 60000, share: { limit: 1000, used: 25 }, floor: 500 } },
        anonymous: { name: 'GitHub without an account', used: 2, limit: 30, left: 28, resets: null, note: 'Made up by the stub host.' } } } };
  }
  frame.addEventListener('load', function () {
    send({ type: '${MESSAGE.HELLO}', protocol: ${PROTOCOL}, session: 'stub', context: context(), state: kept,
      answers: ['state.set', 'activity.set', 'traffic.read'], header: true });
  });
  addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var d = event.data;
    if (!d || typeof d.type !== 'string') return;
    say(JSON.stringify(d));
    if (d.type === '${MESSAGE.HEADER}') return drawMenus(d.items || []);
    if (d.type !== '${MESSAGE.REQUEST}') return;
    var answer = function (data) { send({ type: '${MESSAGE.RESPONSE}', id: d.id, ok: true, data: data }); };
    if (d.method === 'state.set') { kept = d.params.state; return answer(null); }
    if (d.method === 'activity.set') {
      var items = d.params.items || [];
      document.getElementById('inbox').textContent = items.length ? items.map(function (i) { return i.state + ': ' + i.label; }).join(' | ') : '(empty)';
      return answer({ outcome: 'taken', taken: items.length, why: '' });
    }
    if (d.method === 'traffic.read') return answer(traffic(d.params || {}));
    send({ type: '${MESSAGE.RESPONSE}', id: d.id, ok: false, reason: 'unknown-method', error: 'the stub host answers state.set, activity.set and traffic.read' });
  });
})();
</script></body></html>`

const json = (body: unknown) => Response.json(body)

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    /* What a module's door asks a host: is this folder a project (2.3.0)? Here, the one project. */
    if (url.pathname === '/host/is-project') {
      const path = url.searchParams.get('path')
      return json(path === PROJECT ? { ok: true, project: true, path } : { ok: true, project: false, why: `${path} is not the stub's project.` })
    }
    /* No conversation has a recorded place here. */
    if (url.pathname === '/host/place') return json({ ok: true, place: null })
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
})

const module = Bun.spawn(['bunx', 'vite'], {
  cwd: `${import.meta.dirname}/..`,
  /* A registry of its own: a module's dev server registers itself, and this one must not land in Kehikot's. */
  env: { ...process.env, KEHIKOT_ORIGINS: STUB, PORT: String(PREFERRED_PORT), KEHIKOT_MODULES_DIR: mkdtempSync(join(tmpdir(), 'kehikot-stub-registry-')) },
  stdout: 'inherit',
  stderr: 'inherit',
})
const stop = () => {
  module.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`stub host: ${STUB}  (framing ${MODULE}/app, project ${PROJECT})`)
