import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const SHA = '9603a88e0a0fe775ca5b58afc3f48663291b93b7';
const ORIGINAL_EXPERIMENT = 'c597a30210cd97cf050ed4cd5004c02522b6dcec';
const EXPERIMENT_REF = 'refs/heads/experiment/catalog-resilience-hosted';
const REPOSITORY = 'Tran-Nhat-Duy1206/BookStore';
const HOST = '127.0.0.1';
const APP_PORT = 3001;
const RELAY_PORT = 55432;
const DB_PORT = 55433;
const SMOKE_PORT = 3101;
const DOCUMENT_LIMIT = 20_000;
const RENDER_LIMIT = 8_000;
const DELAY = 1500;
const DATABASE = 'bookstore_catalog_ci';
const USER = 'bookstore_catalog';
const IMAGE = 'postgres:18.3-alpine';
const ORIGIN = `http://${HOST}:${APP_PORT}`;
const RECOVERY = 'Tạm thời chưa thể tải trang';
const GUIDANCE = 'Nhà sách đang gặp sự cố khi tải dữ liệu. Bạn có thể thử tải lại trang.';
const FILTER = { q: 'Lam Khê', category: 'light-novel', sort: 'title' };
const QUERY = new URLSearchParams(FILTER).toString();
const CATALOG = `/catalog?${QUERY}`;
const MARKER = 'RESILIENCE-SYNTHETIC';
const SLUGS = ['nguoi-giu-nhung-vi-sao', 'tiem-tra-cuoi-chan-troi'];
const TITLES = [`Người giữ những vì sao ${MARKER}`, 'Tiệm trà cuối chân trời'];
const LINKS = SLUGS.map((slug) => `/products/${slug}?${QUERY}`);
const UNKNOWN_PRODUCT = '/products/unknown-catalog-resilience-product';
const UNKNOWN_SERIES = '/series/unknown-catalog-resilience-series';
const APP = await realpath(process.cwd());
const requireApp = createRequire(join(APP, 'package.json'));
const key = randomBytes(12).toString('hex');
const containerName = `bookstore-catalog-resilience-${key}`;
const ownerLabel = 'bookstore.catalog-resilience.run';
const sanitized = { baseline: SHA, experiment: null, environment: {}, methodology: { normalSamples: 5, delayedSamples: 5, warmups: 1, cycles: 3, delayMs: DELAY, documentLimitMs: DOCUMENT_LIMIT, renderLimitMs: RENDER_LIMIT, setupCommandLimitMs: 120000, cleanupLimits: { browserCloseMs: 6000, childTermMs: 4000, childKillMs: 4000, relayCloseMs: 5000, containerRemoveMs: 12000, perPortCheckMs: 3000 }, viewport: { width: 320, height: 750 }, scope: 'transport delay only; browser-observed timing; no SQL or production latency claim' }, expected: { url: CATALOG, controls: FILTER, titles: TITLES, links: LINKS, productReturn: CATALOG }, preflight: {}, modes: [], samples: { normal: [], delayed: [], extra: [] }, cycles: [], decisions: {}, failures: [], cleanup: {} };
let evidenceDir, browser, relay, app, identity, childrenAtOutage, secret, directUrl, relayUrl, containerId;
let containerCreationAttempted = false;
let closing = false;
let phase = 'preflight';
const active = new Set();
const interrupted = new AbortController();
const now = () => new Date().toISOString();
class CheckError extends Error {}
function check(condition, code) { if (!condition) throw new CheckError(code); }
function safeFailure(error) { return error instanceof CheckError ? error.message : /^TimeoutError$/.test(error?.name) ? 'operation-timeout' : 'unexpected-operation-error'; }
function recordFailure(step, error) { sanitized.failures.push({ step, code: safeFailure(error), time: now() }); }
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new CheckError(code)), ms); })]).finally(() => clearTimeout(timer));
}
function isWithin(path, root) { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'CI', 'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'TMPDIR', 'RUNNER_TEMP'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
Object.assign(childEnv, { DATA_SOURCE: 'fixture', NEXT_TELEMETRY_DISABLED: '1' });
function launch(bin, args, extra = {}, capture = false) {
  check(closing || !interrupted.signal.aborted, 'run-interrupted');
  const child = spawn(bin, args, { cwd: APP, env: { ...childEnv, ...extra }, detached: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
  let stdout = '', overflow = false;
  child.stdout?.on('data', (chunk) => { if (stdout.length + chunk.length > 262144) overflow = true; else if (!overflow) stdout += chunk.toString('utf8'); });
  const done = new Promise((done) => {
    child.once('error', () => done({ code: null, stdout: '', overflow }));
    child.once('close', (code) => done({ code, stdout, overflow }));
  });
  const owned = { child, done };
  active.add(owned);
  void done.then(() => active.delete(owned));
  return owned;
}
async function stop(owned) {
  if (!owned?.child.pid || !active.has(owned)) return;
  try { process.kill(-owned.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  try { await bounded(owned.done, 4000, 'owned-process-term-timeout'); } catch {
    try { process.kill(-owned.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await bounded(owned.done, 4000, 'owned-process-kill-timeout');
  }
}
async function exec(bin, args, code, { env, ms = 120000, capture = false } = {}) {
  const owned = launch(bin, args, env, capture);
  try {
    const result = await bounded(owned.done, ms, `${code}-timeout`);
    check(result.code === 0 && !result.overflow, code);
    return result.stdout.trim();
  } finally { if (active.has(owned)) await stop(owned); }
}
const docker = (args, code, options) => exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args], code, options);
const git = (args) => exec('git', args, 'git-inspection-failed', { capture: true, ms: 4000 });
async function verifyTree() {
  check(await git(['rev-parse', 'HEAD']) === SHA, 'application-sha-mismatch');
  check(await git(['status', '--porcelain', '--untracked-files=normal']) === '', 'application-checkout-not-clean');
  for (const sha of ['aefabf65f1b66d1ece5c7e5729e98a4c617c2669', 'c6739f9dfeca14ef0e90461fca6188a4aa431263']) await git(['merge-base', '--is-ancestor', sha, SHA]);
}
function assertFree(port) {
  return bounded(new Promise((res, rej) => {
    const listener = createServer();
    listener.once('error', () => rej(new CheckError(`port-${port}-unavailable`)));
    listener.listen(port, HOST, () => listener.close((error) => error ? rej(new CheckError(`port-${port}-probe-failed`)) : res()));
  }), 3000, 'port-probe-timeout');
}
function verifyOwnership(runtime = true) {
  const binding = runtime ? '.NetworkSettings.Ports' : '.HostConfig.PortBindings';
  return docker(['inspect', '--type', 'container', '--format', `{{.Id}}|{{index .Config.Labels "${ownerLabel}"}}|{{.Config.Image}}|{{.Name}}|{{json ${binding}}}`, containerId ?? containerName], 'docker-ownership-inspection-failed', { capture: true, ms: 5000 }).then((text) => {
    const [id, label, image, name, bindings] = text.split('|');
    check(/^[a-f0-9]{64}$/.test(id) && (!containerId || id === containerId) && label === key && image === IMAGE && name === `/${containerName}`, 'docker-ownership-mismatch');
    containerId = id;
    const port = JSON.parse(bindings)?.['5432/tcp'];
    check(Array.isArray(port) && port.length === 1 && port[0].HostIp === HOST && port[0].HostPort === String(DB_PORT), 'docker-port-binding-mismatch');
  });
}
function makeRelay() {
  let mode = 'normal', ticket, notifyTrigger, sequence = 0, accepted = 0, rejected = 0, upstreamBytes = 0, downstreamEvents = 0;
  const pairs = new Set();
  const snapshot = () => ({ active: pairs.size, accepted, rejected, upstreamBytes, downstreamEvents });
  const server = createServer((client) => {
    client.on('error', () => client.destroy());
    if (mode === 'outage') { rejected++; client.destroy(); return; }
    accepted++;
    const db = createConnection({ host: HOST, port: DB_PORT });
    const pair = { client, db, timer: undefined };
    pairs.add(pair);
    function closePair() { clearTimeout(pair.timer); pairs.delete(pair); db.destroy(); client.destroy(); }
    client.on('error', closePair); client.on('close', closePair);
    db.on('error', closePair); db.on('close', closePair);
    client.pipe(db);
    client.on('data', (chunk) => { upstreamBytes += chunk.length; });
    function forward(chunk) { if (!client.write(chunk)) client.once('drain', () => { if (!db.destroyed) db.resume(); }); else if (!db.destroyed) db.resume(); }
    db.on('data', (chunk) => {
      downstreamEvents++;
      db.pause();
      if (mode !== 'delayed' || !ticket || ticket.triggered !== undefined) { forward(chunk); return; }
      const armed = ticket;
      armed.triggered = performance.now();
      armed.triggeredAt = now();
      pair.timer = setTimeout(() => {
        if (client.destroyed || db.destroyed) return;
        armed.releasedMonotonic = performance.now();
        armed.observedMs = armed.releasedMonotonic - armed.triggered;
        armed.releasedAt = now();
        forward(chunk);
      }, DELAY);
      notifyTrigger();
    });
  });
  // A listening relay error is not allowed to disappear as a valid sample.
  server.on('error', () => { if (server.listening) recordFailure('relay', new CheckError('relay-listener-error')); });
  return {
    snapshot,
    async listen() {
      await bounded(new Promise((res, rej) => { server.once('error', () => rej(new CheckError('relay-bind-failed'))); server.listen(RELAY_PORT, HOST, res); }), 3000, 'relay-bind-timeout');
      sanitized.modes.push({ mode, at: now(), ...snapshot() });
    },
    set(next) {
      const before = snapshot();
      mode = next;
      ticket = next === 'delayed' ? { id: ++sequence, armedAt: now() } : undefined;
      notifyTrigger = undefined;
      if (ticket) {
        // These synchronization fields are intentionally not part of the original evidence schema.
        const whenTriggered = new Promise((resolve) => { notifyTrigger = resolve; });
        Object.defineProperties(ticket, { whenTriggered: { value: whenTriggered }, releasedMonotonic: { writable: true } });
      }
      if (next === 'outage') for (const pair of pairs) { clearTimeout(pair.timer); pair.client.destroy(); pair.db.destroy(); }
      sanitized.modes.push({ mode, at: now(), before, after: snapshot(), ...(ticket ? { ticket } : {}) });
      return ticket;
    },
    async close() {
      for (const pair of pairs) { clearTimeout(pair.timer); pair.client.destroy(); pair.db.destroy(); }
      if (server.listening) await bounded(new Promise((res, rej) => server.close((error) => error ? rej(new CheckError('relay-close-failed')) : res())), 5000, 'relay-close-timeout');
    },
  };
}
async function processIdentity() {
  check(app?.child.pid && active.has(app), 'application-process-not-running');
  const pid = app.child.pid;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => { throw new CheckError('application-process-identity-unavailable'); });
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  check(fields[0] !== 'Z' && /^\d+$/.test(fields[19]), 'application-process-start-ticks-unavailable');
  return { pid, linuxStartTicks: fields[19] };
}
async function sameProcess(item) {
  const current = await processIdentity();
  check(current.pid === identity.pid && current.linuxStartTicks === identity.linuxStartTicks, 'application-process-identity-changed');
  item.applicationProcess = current;
}
async function dbReady() {
  const { Client } = requireApp('pg');
  const client = new Client({ connectionString: relayUrl, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT current_database() AS db, pg_postmaster_start_time()::text AS started, (SELECT "merchandisingTitle" FROM "Product" WHERE slug = $1) AS title`, [SLUGS[0]]);
    check(rows.length === 1 && rows[0].db === DATABASE && rows[0].title === TITLES[0], 'independent-relay-database-identity-mismatch');
    check(typeof rows[0].started === 'string' && /^[0-9:.+ -]+$/.test(rows[0].started), 'invalid-database-start-time');
    return rows[0].started;
  } finally { await bounded(client.end().catch(() => {}), 3000, 'independent-database-close-timeout'); }
}
const isDoc = (response, path) => response.url() === ORIGIN + path && response.request().isNavigationRequest() && response.request().resourceType() === 'document';
const countText = `2 sách minh họa cho “${FILTER.q}”`;
function noPublicLeaks(text) {
  check(typeof text === 'string', 'public-response-missing');
  check(![secret, directUrl, relayUrl, 'postgresql://', 'PrismaClientKnownRequestError', 'PrismaClientInitializationError', DATABASE, 'ECONNREFUSED', 'P1001'].some((value) => value && text.includes(value)), 'public-response-sensitive-detail');
}
function noSubstitution(text) {
  check(![MARKER, 'Khu vườn sau cơn mưa', 'Dạo quanh kệ sách', '12 sách minh họa', countText, ...SLUGS].some((value) => text.includes(value)), 'catalog-content-present-during-outage');
}
async function waitGone(locator) { await locator.waitFor({ state: 'hidden', timeout: RENDER_LIMIT }); }
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: RENDER_LIMIT }); }
async function catalog(page, item) {
  check(page.url() === ORIGIN + CATALOG, 'catalog-url-mismatch');
  await visible(page.getByRole('heading', { name: 'Dạo quanh kệ sách', exact: true }));
  const cards = page.locator('.catalog-grid .book-card h3 a');
  await visible(cards.first());
  const links = await cards.evaluateAll((nodes) => nodes.map((node) => [node.textContent?.trim(), node.getAttribute('href')]));
  const controls = {};
  for (const name of Object.keys(FILTER)) controls[name] = await page.locator(`form.filter-bar [name="${name}"]`).inputValue({ timeout: RENDER_LIMIT });
  item.catalog = { exactBooks: JSON.stringify(links) === JSON.stringify(TITLES.map((title, i) => [title, LINKS[i]])), exactControls: JSON.stringify(controls) === JSON.stringify(FILTER) };
  check(item.catalog.exactBooks && item.catalog.exactControls, 'catalog-identities-order-links-or-controls-mismatch');
  await visible(page.getByText(countText, { exact: true }));
  await waitGone(page.getByRole('heading', { name: RECOVERY, exact: true }));
  item.catalog.titles = TITLES;
  item.catalog.links = LINKS;
  item.catalog.controls = FILTER;
}
async function productReturn(page, item) {
  const resp = await page.goto(ORIGIN + LINKS[0], { waitUntil: 'commit', timeout: DOCUMENT_LIMIT });
  item.productStatus = resp?.status();
  check(item.productStatus === 200, 'filtered-product-document-status-not-200');
  await visible(page.getByRole('heading', { name: TITLES[0], exact: true }));
  const link = page.locator('.breadcrumb').getByRole('link', { name: 'Trở lại kết quả', exact: true });
  await visible(link);
  check(await link.getAttribute('href', { timeout: RENDER_LIMIT }) === CATALOG, 'product-return-link-mismatch');
  item.productReturn = CATALOG;
  return link;
}
async function context(options = {}) { return browser.newContext({ viewport: sanitized.methodology.viewport, serviceWorkers: 'block', ...options }); }
async function pageIn(options, fn) {
  const ctx = await context(options);
  try { return await fn(await ctx.newPage()); } finally { await bounded(ctx.close(), 4000, 'browser-context-close-timeout'); }
}
async function tagSnapshot(page) {
  return page.evaluate((heading) => {
    const present = (node) => Boolean(node?.getClientRects().length);
    return { headingsVisible: [...document.querySelectorAll('h1')].filter(present).length, focusableVisible: [...document.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(present).length, activeTag: ['A', 'BUTTON', 'BODY', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName) ? document.activeElement.tagName : 'other', catalogVisible: [...document.querySelectorAll('h1')].some((x) => present(x) && x.textContent?.trim() === 'Dạo quanh kệ sách'), recoveryVisible: [...document.querySelectorAll('h1')].some((x) => present(x) && x.textContent?.trim() === heading) };
  }, RECOVERY);
}
async function observeWait(page, ticket, item, markResponse) {
  if (!ticket) return;
  const until = performance.now() + 1800;
  while (ticket.triggered === undefined && !markResponse() && performance.now() < until) await sleep(20);
  if (ticket.triggered === undefined || markResponse()) return;
  await sleep(150);
  if (ticket.observedMs !== undefined || markResponse()) return;
  if (page.url() === 'about:blank' && !markResponse()) {
    item.duringWait = { observation: 'uncommitted-about-blank', headingsVisible: 0, focusableVisible: 0, beforeResponse: true };
    return;
  }
  item.duringWait = await bounded(tagSnapshot(page), 500, 'wait-view-snapshot-timeout').catch(() => ({ observation: 'document-transition-unavailable' }));
  item.duringWait.beforeResponse = !markResponse() && Number.isInteger(item.duringWait.headingsVisible) && Number.isInteger(item.duringWait.focusableVisible);
}
async function timed(page, item, { path = CATALOG, status = 200, delayed = false, action, clientNavigation = false } = {}) {
  check(!interrupted.signal.aborted, 'run-interrupted');
  item.path = path; item.navigation = clientNavigation ? 'hydrated-link' : action ? 'native-get' : 'document';
  const before = relay.snapshot();
  const ticket = delayed ? relay.set('delayed') : undefined;
  let gotResponse = false;
  const t = performance.now();
  const response = page.waitForResponse((candidate) => {
    if (!clientNavigation) return isDoc(candidate, path);
    const url = new URL(candidate.url());
    return url.origin === ORIGIN && url.pathname === '/catalog' && [...new URLSearchParams(QUERY)].every(([k, v]) => url.searchParams.get(k) === v) && (candidate.request().headers().rsc === '1' || url.searchParams.has('_rsc'));
  }, { timeout: DOCUMENT_LIMIT }).then((r) => { gotResponse = true; item.responseMs = performance.now() - t; item.status = r.status(); return r; });
  const observe = observeWait(page, ticket, item, () => gotResponse);
  let navDocs = 0;
  const doc = (req) => { if (req.isNavigationRequest() && req.resourceType() === 'document') navDocs++; };
  page.on('request', doc);
  try {
    const navigate = action ? action() : page.goto(ORIGIN + path, { waitUntil: 'commit', timeout: DOCUMENT_LIMIT });
    const [resp] = await Promise.all([response, navigate, observe]);
    check(item.status === status, 'unexpected-measured-response-status');
    if (path === CATALOG) {
      await page.waitForURL(ORIGIN + CATALOG, { timeout: RENDER_LIMIT });
      await catalog(page, item);
    } else await visible(page.getByRole('heading', { name: 'Có lẽ bạn vừa rẽ sang một lối nhỏ', exact: true }));
    item.usefulMs = performance.now() - t;
    if (!clientNavigation) {
      const body = await bounded(resp.text(), RENDER_LIMIT, 'document-body-timeout');
      noPublicLeaks(body);
      if (path === CATALOG) check(body.includes(MARKER), 'marker-missing-in-raw-document');
    }
    item.navigationDocumentCount = navDocs;
    if (clientNavigation) check(navDocs === 0 && (await page.evaluate(() => window.__catalogResilienceDocument === true)), 'client-navigation-replaced-document');
    check(relay.snapshot().upstreamBytes > before.upstreamBytes, 'measured-request-did-not-use-relay');
    if (ticket) {
      item.delayMs = ticket.observedMs;
      check(ticket.triggeredAt && ticket.observedMs >= DELAY - 2 && ticket.observedMs < DELAY + 500, 'designated-delay-not-triggered-or-out-of-range');
      check(item.duringWait?.beforeResponse && Number.isInteger(item.duringWait.headingsVisible) && Number.isInteger(item.duringWait.focusableVisible), 'no-credible-observation-during-delay');
      check(item.responseMs >= DELAY - 2, 'response-committed-before-delayed-source');
    }
    item.pass = true;
  } finally {
    page.off('request', doc);
    if (ticket) relay.set('normal');
  }
}
async function protectedCase(label, item, fn) {
  try { await fn(); } catch (error) { item.pass = false; item.failure = safeFailure(error); recordFailure(label, error); }
}
async function health404(page, item) {
  for (const [key, path] of [['unknownProduct', UNKNOWN_PRODUCT], ['unknownSeries', UNKNOWN_SERIES]]) {
    const resp = await page.goto(ORIGIN + path, { waitUntil: 'commit', timeout: DOCUMENT_LIMIT });
    item[key] = { path, status: resp?.status() };
    check(resp?.status() === 404, `${key}-document-status-not-404`);
    const body = await bounded(resp.text(), RENDER_LIMIT, 'not-found-document-body-timeout');
    noPublicLeaks(body);
    check(!body.includes(RECOVERY), 'healthy-not-found-showed-source-error');
  }
}
async function recovery(page, resp, item, js) {
  item.status = resp?.status();
  check(item.status === 500 && page.url() === ORIGIN + CATALOG, 'outage-document-status-or-url-mismatch');
  const raw = await bounded(resp.text(), RENDER_LIMIT, 'outage-document-body-timeout');
  noPublicLeaks(raw); noSubstitution(raw);
  item.rawRedacted = true; item.rawNoSubstitution = true; item.rawContainsRecovery = raw.includes(RECOVERY);
  const h = page.getByRole('heading', { name: RECOVERY, exact: true });
  if (js) {
    await visible(h);
    await visible(page.getByRole('main').getByText('Cá Tỏ BookStore', { exact: true }));
    await visible(page.getByText(GUIDANCE, { exact: true }));
  } else await page.waitForLoadState('domcontentloaded', { timeout: RENDER_LIMIT });
  item.visibleRecovery = await h.isVisible();
  const visibleText = await page.locator('body').innerText({ timeout: RENDER_LIMIT });
  noPublicLeaks(visibleText); noSubstitution(visibleText);
  item.renderedRedacted = true; item.renderedNoSubstitution = true;
}
async function retry(page, item) {
  const link = page.getByRole('link', { name: 'Thử lại', exact: true });
  await visible(link);
  // The recovery document offers only one link; use actual keyboard traversal.
  await page.keyboard.press('Tab');
  check(await link.evaluate((a) => document.activeElement === a && a.matches(':focus-visible') && getComputedStyle(a).outlineStyle === 'solid'), 'recovery-retry-focus-not-visible');
  item.visibleFocus = true;
  let documents = 0;
  const seen = (request) => { if (request.isNavigationRequest() && request.resourceType() === 'document') documents++; };
  page.on('request', seen);
  try {
    const t = performance.now();
    const [r] = await Promise.all([page.waitForResponse((x) => isDoc(x, CATALOG), { timeout: DOCUMENT_LIMIT }), page.keyboard.press('Enter')]);
    item.status = r.status(); item.responseMs = performance.now() - t;
    await page.waitForLoadState('domcontentloaded', { timeout: RENDER_LIMIT });
    return { r, verify: async () => { await sleep(350); item.documentRequests = documents; check(documents === 1, 'retry-did-not-issue-exactly-one-document'); }, close: () => { item.documentRequests ??= documents; page.off('request', seen); } };
  } catch (error) { page.off('request', seen); throw error; }
}
async function prepareEvidence() {
  const target = process.env.EVIDENCE_DIR;
  check(target && isAbsolute(target) && !isWithin(resolve(target), APP), 'evidence-directory-is-not-external-absolute');
  const parent = await realpath(dirname(target));
  const intended = join(parent, relative(dirname(target), target));
  check(!isWithin(intended, APP), 'evidence-directory-parent-inside-checkout');
  await mkdir(intended, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const found = await realpath(intended);
  check(found === intended && (await readdir(found)).length === 0, 'evidence-directory-already-used-or-linked');
  evidenceDir = found;
}
function selectRunMode(event, experiment) {
  check(event?.repository?.full_name === REPOSITORY && event.ref === EXPERIMENT_REF && event.after === experiment && event.deleted === false, 'push-event-identity-mismatch');
  if (event.created === true) return 'original-full-protocol';
  check(event.created === false && event.forced === false && event.before === ORIGINAL_EXPERIMENT && experiment !== ORIGINAL_EXPERIMENT, 'push-event-not-approved-followup');
  return 'targeted-loading-followup';
}
async function verifyWorkflowGuard(checkout) {
  const workflow = await readFile(join(checkout, '.github', 'workflows', 'catalog-resilience-experiment.yml'), 'utf8');
  const trigger = `on:\n  push:\n    branches: [${EXPERIMENT_REF.slice('refs/heads/'.length)}]\n\npermissions:\n  contents: read\n`;
  check(workflow.includes(trigger), 'workflow-trigger-or-permissions-mismatch');
  const guard = workflow.match(/\n    if: >-\n\s*\$\{\{([\s\S]*?)\}\}\n    runs-on:/)?.[1]?.trim().replace(/\s+/g, ' ');
  const expected = `github.repository == '${REPOSITORY}' && github.event.deleted == false && github.run_attempt == '1' && (github.event.created == true || (github.event.created == false && github.event.forced == false && github.event.before == '${ORIGINAL_EXPERIMENT}'))`;
  check(guard === expected, 'workflow-job-guard-mismatch');
  const evaluate = (repository, ref, run_attempt, event) => ref === EXPERIMENT_REF && runInNewContext(expected.replaceAll(' == ', ' === '), { github: { repository, run_attempt, event } }, { timeout: 100 }) === true;
  const base = { before: ORIGINAL_EXPERIMENT, created: false, deleted: false, forced: false };
  const cases = [
    ['branch-creation', REPOSITORY, EXPERIMENT_REF, '1', { ...base, before: '0'.repeat(40), created: true }, true],
    ['approved-predecessor', REPOSITORY, EXPERIMENT_REF, '1', base, true],
    ['different-predecessor', REPOSITORY, EXPERIMENT_REF, '1', { ...base, before: 'f'.repeat(40) }, false],
    ['different-repository', 'other/BookStore', EXPERIMENT_REF, '1', base, false],
    ['different-branch', REPOSITORY, 'refs/heads/main', '1', base, false],
    ['second-attempt', REPOSITORY, EXPERIMENT_REF, '2', base, false],
    ['branch-deletion', REPOSITORY, EXPERIMENT_REF, '1', { ...base, deleted: true }, false],
    ['forced-update', REPOSITORY, EXPERIMENT_REF, '1', { ...base, forced: true }, false],
  ];
  return Object.fromEntries(cases.map(([name, repo, ref, attempt, event, eligible]) => {
    check(evaluate(repo, ref, attempt, event) === eligible, `inert-workflow-guard-${name}-failed`);
    return [name, eligible ? 'eligible' : 'rejected'];
  }));
}
async function verifiedRunMode() {
  // The runner writes this file under RUNNER_TEMP before starting the job. The
  // existing env -i wrapper intentionally does not pass GITHUB_EVENT_PATH.
  const temp = await realpath(process.env.RUNNER_TEMP);
  const path = join(temp, '_github_workflow', 'event.json');
  const file = await lstat(path).catch(() => null);
  check(file?.isFile() && file.uid === process.getuid() && file.size <= 2 * 1024 * 1024 && await realpath(path) === path, 'runner-push-event-file-unavailable');
  const event = await readFile(path, 'utf8').then(JSON.parse).catch(() => { throw new CheckError('runner-push-event-invalid-json'); });
  const mode = selectRunMode(event, sanitized.experiment);
  if (mode === 'targeted-loading-followup') {
    const experimentCheckout = join(dirname(APP), 'experiment');
    check(await git(['-C', experimentCheckout, 'rev-parse', 'HEAD']) === sanitized.experiment, 'experiment-checkout-mismatch');
    const commitObject = await git(['-C', experimentCheckout, 'cat-file', 'commit', 'HEAD']);
    const parents = commitObject.split('\n\n', 1)[0].split('\n').filter((line) => line.startsWith('parent '));
    check(parents.length === 1 && parents[0] === `parent ${ORIGINAL_EXPERIMENT}`, 'experiment-not-direct-successor');
    sanitized.followup = { mode, event: { repository: REPOSITORY, ref: EXPERIMENT_REF, before: ORIGINAL_EXPERIMENT, after: sanitized.experiment, created: false, forced: false, deleted: false }, excluded: ['full timing matrix', 'outage and restoration cycles', 'configuration-only smoke', 'unrelated regression and security suites'], diagnostic: { native: 'original page evaluation unavailable during document transition', hydrated: 'original observer stopped at RSC headers, before useful content' } };
    sanitized.followup.guardValidation = await verifyWorkflowGuard(experimentCheckout);
    sanitized.methodology = { observations: ['native GET', 'hydrated link'], samplesPerObservation: 1, delayMs: DELAY, documentLimitMs: DOCUMENT_LIMIT, renderLimitMs: RENDER_LIMIT, setupCommandLimitMs: sanitized.methodology.setupCommandLimitMs, cleanupLimits: sanitized.methodology.cleanupLimits, viewport: sanitized.methodology.viewport, scope: 'targeted browser observations; transport delay only, not SQL or production latency' };
  }
  return mode;
}
async function setup() {
  check(process.platform === 'linux' && process.env.RUNNER_OS === 'Linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'not-approved-disposable-hosted-linux');
  check(process.env.APP_SHA === SHA && /^[a-f0-9]{40}$/.test(process.env.EXPERIMENT_SHA ?? ''), 'sha-input-mismatch');
  sanitized.experiment = process.env.EXPERIMENT_SHA;
  const harness = await realpath(fileURLToPath(import.meta.url));
  check(!isWithin(harness, APP), 'harness-inside-application-checkout');
  await verifyTree();
  sanitized.preflight.checkout = 'exact-sha-clean-with-protected-ancestry';
  for (const port of [APP_PORT, RELAY_PORT, DB_PORT, SMOKE_PORT]) await assertFree(port);
  sanitized.preflight.ports = [APP_PORT, RELAY_PORT, DB_PORT, SMOKE_PORT];
  check(await docker(['info', '--format', '{{.OSType}}'], 'docker-info-failed', { capture: true, ms: 12000 }) === 'linux', 'docker-server-not-linux');
  const pnpm = await exec('pnpm', ['--version'], 'pnpm-version-failed', { capture: true, ms: 5000 });
  const next = requireApp('next/package.json').version;
  check(process.version === 'v24.19.0' && pnpm === '11.7.0' && next === '16.4.5', 'runtime-pin-mismatch');
  check((await readFile(join(APP, '.next', 'BUILD_ID'), 'utf8')).trim().length > 0, 'existing-production-build-missing');
  sanitized.environment = { os: 'Linux', runner: 'GitHub-hosted disposable', node: process.version, pnpm, next, postgres: IMAGE };
  const environment = await readFile(join(APP, 'scripts', 'source-failure-smoke.ts'), 'utf8');
  check(environment.includes('const port = 3101;') && environment.includes('await verifyFailure("invalid-source", sentinel);') && environment.includes('await verifyHealthy("fixture", sentinel);'), 'configuration-only-smoke-contract-mismatch');
  const { chromium } = requireApp('@playwright/test');
  browser = await chromium.launch({ timeout: 15000 });
  const chromiumVersion = browser.version();
  check(/^[0-9.]+$/.test(chromiumVersion), 'chromium-version-unavailable');
  sanitized.environment.chromium = chromiumVersion;
  await docker(['pull', IMAGE], 'docker-pinned-image-pull-failed');
  const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE], 'docker-image-inspection-failed', { capture: true, ms: 5000 });
  check(/^sha256:[a-f0-9]{64}$/.test(imageId), 'docker-image-identity-unavailable');
  sanitized.environment.postgresImageId = imageId;
  await assertFree(DB_PORT);
  secret = randomBytes(24).toString('hex');
  directUrl = `postgresql://${USER}:${secret}@${HOST}:${DB_PORT}/${DATABASE}`;
  relayUrl = `postgresql://${USER}:${secret}@${HOST}:${RELAY_PORT}/${DATABASE}`;
  for (const value of [secret, directUrl, relayUrl]) process.stdout.write(`::add-mask::${value}\n`);
  containerCreationAttempted = true;
  const createdId = await docker(['run', '--detach', '--name', containerName, '--label', `${ownerLabel}=${key}`, '--publish', `${HOST}:${DB_PORT}:5432`, '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${USER}`, '-e', `POSTGRES_DB=${DATABASE}`, IMAGE], 'docker-catalog-launch-failed', { env: { POSTGRES_PASSWORD: secret }, capture: true, ms: 30000 });
  check(/^[a-f0-9]{64}$/.test(createdId), 'docker-container-id-invalid');
  containerId = createdId;
  await verifyOwnership();
  sanitized.preflight.databaseOwnership = 'verified-label-image-container-and-loopback-binding';
  const stopAt = performance.now() + 35000;
  let ready = false;
  while (performance.now() < stopAt && !interrupted.signal.aborted) {
    try { await docker(['exec', containerId, 'pg_isready', '-h', HOST, '-p', '5432', '-U', USER, '-d', DATABASE], 'postgres-not-ready', { ms: 3000 }); ready = true; break; } catch { await sleep(250); }
  }
  check(ready, 'postgres-did-not-become-ready');
  const pgVersion = await docker(['exec', containerId, 'psql', '-XAt', '-U', USER, '-d', DATABASE, '-c', 'SHOW server_version'], 'postgres-version-failed', { capture: true, ms: 5000 });
  check(/^18\.3(?:\s|$)/.test(pgVersion), 'postgres-version-pin-mismatch');
  sanitized.environment.postgresServerVersion = '18.3';
  const setupEnv = { DATA_SOURCE: 'database', DATABASE_URL: directUrl };
  await exec('pnpm', ['db:migrate'], 'catalog-migration-failed', { env: setupEnv });
  await exec('pnpm', ['db:seed'], 'catalog-seed-failed', { env: setupEnv });
  sanitized.preflight.migrationAndSeed = 'completed';
  // Assert the real pre-marker row and change exactly one approved public title.
  const affected = await docker(['exec', containerId, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', USER, '-d', DATABASE, '-c', `UPDATE "Product" SET "merchandisingTitle" = "merchandisingTitle" || ' ${MARKER}' WHERE slug = '${SLUGS[0]}' AND "merchandisingTitle" = 'Người giữ những vì sao' AND "isDemo" AND status = 'PUBLISHED' RETURNING slug`], 'catalog-source-marker-write-failed', { capture: true, ms: 5000 });
  check(affected === SLUGS[0], 'source-marker-did-not-affect-exactly-one-expected-row');
  relay = makeRelay();
  await relay.listen();
  sanitized.preflight.databaseStarted = await dbReady();
  await assertFree(APP_PORT);
  app = launch(process.execPath, [join(APP, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', HOST, '--port', String(APP_PORT)], { DATA_SOURCE: 'database', DATABASE_URL: relayUrl, BOOKSTORE_LOCAL_DB_READS: '1' });
  identity = await processIdentity();
  sanitized.preflight.applicationProcess = { ...identity, observedAt: now() };
  // A raw port probe observes listener readiness without warming the catalog pool.
  const deadline = performance.now() + 20000;
  let listening = false;
  while (performance.now() < deadline && !listening && !interrupted.signal.aborted) {
    await sameProcess({});
    listening = await new Promise((res) => { const socket = createConnection({ host: HOST, port: APP_PORT }); socket.setTimeout(700, () => { socket.destroy(); res(false); }); socket.once('error', () => res(false)); socket.once('connect', () => { socket.destroy(); res(true); }); });
    if (!listening) await sleep(100);
  }
  check(listening, 'owned-application-listener-unavailable');
}
async function samples() {
  await pageIn({}, async (page) => { sanitized.healthy = {}; await timed(page, sanitized.healthy); await productReturn(page, sanitized.healthy); await health404(page, sanitized.healthy); });
  // A fresh browser page for each top-level sample; application and database stay warm.
  const groups = [['normal', false], ['delayed', true]];
  for (const [kind, delayed] of groups) for (let i = 1; i <= 5; i++) {
    const item = { sample: i };
    sanitized.samples[kind].push(item);
    await protectedCase(`${kind}-${i}`, item, () => pageIn({}, (page) => timed(page, item, { delayed })));
    check(!interrupted.signal.aborted, 'run-interrupted');
  }
  for (const [label, path] of [['delayed-unknown-product', UNKNOWN_PRODUCT], ['delayed-unknown-series', UNKNOWN_SERIES]]) {
    const item = { label };
    sanitized.samples.extra.push(item);
    await protectedCase(label, item, () => pageIn({}, (page) => timed(page, item, { path, status: 404, delayed: true })));
  }
  const native = { label: 'delayed-native-get' };
  sanitized.samples.extra.push(native);
  await protectedCase(native.label, native, () => pageIn({ javaScriptEnabled: false }, async (page) => {
    const source = await page.goto(ORIGIN + '/catalog', { waitUntil: 'domcontentloaded', timeout: DOCUMENT_LIMIT });
    check(source?.status() === 200, 'native-source-catalog-status-mismatch');
    const form = page.locator('form.filter-bar');
    await form.locator('[name="q"]').fill(FILTER.q);
    for (const name of ['category', 'sort']) await form.locator(`[name="${name}"]`).selectOption(FILTER[name]);
    const submit = form.getByRole('button', { name: 'Tìm & lọc' });
    await submit.click({ trial: true });
    await timed(page, native, { delayed: true, action: () => submit.click({ timeout: RENDER_LIMIT }) });
    check(native.navigationDocumentCount === 1, 'native-get-did-not-use-exactly-one-document');
  }));
  const client = { label: 'delayed-hydrated-link' };
  sanitized.samples.extra.push(client);
  await protectedCase(client.label, client, () => pageIn({}, async (page) => {
    // Block speculative RSC prefetch so only the measured click can consume the ticket.
    await page.route('**/*', (route) => {
      const request = route.request();
      const headers = request.headers();
      if (headers['next-router-prefetch'] !== undefined || headers['next-router-segment-prefetch'] !== undefined || headers.purpose === 'prefetch' || headers['sec-purpose']?.includes('prefetch')) return route.abort();
      return route.continue();
    });
    const back = await productReturn(page, client);
    await page.waitForLoadState('load', { timeout: RENDER_LIMIT });
    await page.evaluate(() => { window.__catalogResilienceDocument = true; });
    await back.click({ trial: true });
    await timed(page, client, { delayed: true, clientNavigation: true, action: () => back.click({ timeout: RENDER_LIMIT }) });
  }));
  sanitized.samples.summary = {};
  for (const [kind] of groups) {
    const complete = sanitized.samples[kind].filter((item) => item.pass);
    const summary = { count: complete.length, incomplete: 5 - complete.length };
    for (const key of ['responseMs', 'usefulMs']) if (complete.length) {
      const a = complete.map((item) => item[key]).sort((a, b) => a - b);
      const mid = Math.floor(a.length / 2);
      summary[key] = { min: a[0], median: a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2, max: a.at(-1) };
    }
    sanitized.samples.summary[kind] = summary;
  }
}
async function targetedObservations() {
  sanitized.followup.observations = [];
  // Six JPEG payloads cost at most 176 KiB once base64-encoded, leaving room in evidence.json.
  const jpegLimit = 22 * 1024;
  for (const [label, hydrated] of [['targeted-native-get', false], ['targeted-hydrated-link', true]]) {
    const item = { label, navigation: hydrated ? 'hydrated-link' : 'native-get', path: CATALOG, frames: {} };
    let isolated = true;
    sanitized.followup.observations.push(item);
    await protectedCase(label, item, async () => {
      const provisionalImages = {};
      await pageIn({ javaScriptEnabled: hydrated }, async (page) => {
        const deadline = performance.now() + DOCUMENT_LIMIT;
        const within = (promise, code) => bounded(promise, Math.max(1, deadline - performance.now()), code);
        page.setDefaultTimeout(RENDER_LIMIT);
        await within(sameProcess({}), 'followup-source-process-timeout');
        check(!interrupted.signal.aborted, 'run-interrupted');
        const cdp = await within(page.context().newCDPSession(page), 'followup-cdp-session-timeout');
        let measured = false, documentCount = 0, targetRequests = 0, competingRequests = 0;
        let requested, responded, actionAt, ticket;
        const isTarget = (request) => {
          if (request.method() !== 'GET') return false;
          if (!hydrated) return request.url() === ORIGIN + CATALOG && request.isNavigationRequest() && request.resourceType() === 'document';
          const url = new URL(request.url());
          if (url.origin !== ORIGIN || url.pathname !== '/catalog' || request.headers().rsc !== '1' || request.isNavigationRequest()) return false;
          url.searchParams.delete('_rsc');
          return url.searchParams.toString() === QUERY;
        };
        // Disable speculative RSC requests (including during source setup). While measuring,
        // reject competing page data requests; ordinary static assets can still render.
        await within(page.route('**/*', (route) => {
          const req = route.request(), headers = req.headers();
          if (headers['next-router-prefetch'] !== undefined || headers['next-router-segment-prefetch'] !== undefined || headers.purpose === 'prefetch' || headers['sec-purpose']?.includes('prefetch')) return route.abort();
          if (measured && isTarget(req)) {
            targetRequests++;
            requested ??= performance.now(); // The origin cannot see this request before continue().
          } else if (measured && ['document', 'fetch', 'xhr'].includes(req.resourceType())) {
            competingRequests++;
            return route.abort();
          }
          return route.continue();
        }), 'followup-route-setup-timeout');
        const seeRequest = (req) => { if (measured && req.resourceType() === 'document' && req.isNavigationRequest()) documentCount++; };
        const seeResponse = (res) => { if (measured && isTarget(res.request())) responded ??= performance.now(); };
        const send = (method, params) => within(cdp.send(method, params), 'followup-cdp-timeout');
        const screenState = async () => {
          const result = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
            const links = [...document.querySelectorAll('.catalog-grid .book-card h3 a')];
            const first = links[0];
            const expectedControls = ${JSON.stringify(Object.entries(FILTER))};
            const expectedBooks = ${JSON.stringify(TITLES.map((title, i) => [title, LINKS[i]]))};
            const catalogHeading = document.querySelector('main h1')?.textContent?.trim() === 'Dạo quanh kệ sách';
            const rect = first?.getBoundingClientRect();
            const x = rect && Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
            const y = rect && Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
            return {
              activeWindow: document.hasFocus() && document.visibilityState === 'visible',
              catalogHeading,
              usefulDestinationDom: catalogHeading && location.href === ${JSON.stringify(ORIGIN + CATALOG)} &&
                expectedControls.every(([key, value]) => document.querySelector('form.filter-bar [name=' + key + ']')?.value === value) &&
                JSON.stringify(links.map((link) => [link.textContent?.trim(), link.getAttribute('href')])) === JSON.stringify(expectedBooks) &&
                document.querySelector('.result-line span')?.textContent?.trim() === ${JSON.stringify(countText)},
              productHeading: document.querySelector('main h1')?.textContent?.trim() === ${JSON.stringify(TITLES[0])},
              targetFocused: document.activeElement?.matches(${JSON.stringify(hydrated ? '.breadcrumb a[href=' + JSON.stringify(CATALOG) + ']' : 'form.filter-bar button[type=submit]')}) ?? false,
              firstResultInViewport: first?.textContent?.trim() === ${JSON.stringify(TITLES[0])} && !!rect && rect.width > 0 && rect.height > 0 && first.contains(document.elementFromPoint(x, y)),
              viewport: { width: innerWidth, height: innerHeight }
            };
          })()` });
          check(!result.exceptionDetails && result.result.value, 'followup-cdp-screen-state-unavailable');
          return result.result.value;
        };
        let sourceLoaderId;
        async function frame(stage, inWindow = () => true) {
          const during = stage === 'during';
          check(inWindow(), 'followup-capture-window-already-closed');
          // During a native provisional navigation Runtime.evaluate can be unavailable.
          // Capture first on the foreground target; the bounded DOM probe is supplemental.
          const a = during ? undefined : await screenState();
          if (a) check(a.activeWindow, 'followup-window-not-active-before-frame');
          let data, bytes, quality, captureStarted, captureFinished;
          for (quality of [30, 20, 10]) {
            check(inWindow(), 'followup-capture-window-closed-before-screenshot');
            captureStarted = performance.now();
            ({ data } = await send('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false }));
            captureFinished = performance.now();
            bytes = Buffer.from(data, 'base64');
            if (bytes.length <= jpegLimit) break;
          }
          check(bytes.length >= 4 && bytes.length <= jpegLimit && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'followup-jpeg-invalid-or-over-budget');
          check(captureFinished < deadline && inWindow(), 'followup-frame-not-wholly-in-capture-window');
          provisionalImages[stage] = data;
          const capture = { mime: 'image/jpeg', quality, bytes: bytes.length };
          if (during) {
            const focusStart = performance.now();
            const focus = await bounded(Promise.all([screenState(), send('Page.getFrameTree')]), 200, 'focus-probe-timeout').then(([state, { frameTree }]) => {
              if (!inWindow()) return { category: 'probe-outside-hold' };
              if (frameTree.frame.loaderId !== sourceLoaderId) return { category: 'replacement-document', activeWindow: state.activeWindow, usefulDestinationDom: state.usefulDestinationDom };
              return { category: state.activeWindow ? 'active-window-observed' : 'inactive-window-observed', state };
            }, (error) => ({ category: safeFailure(error) === 'focus-probe-timeout' ? 'probe-timeout' : 'probe-unavailable' }));
            item.frames[stage] = { ...capture, activeTargetBasis: 'foreground-confirmed-before-keypress-single-page-context', focus: { ...focus, separateFromScreenshot: true, startAfterTriggerMs: focusStart - ticket.triggered, endAfterTriggerMs: performance.now() - ticket.triggered }, screenshotStartAfterTriggerMs: captureStarted - ticket.triggered, screenshotEndAfterTriggerMs: captureFinished - ticket.triggered };
            check(focus.category !== 'inactive-window-observed' && focus.activeWindow !== false, 'followup-wait-window-not-active');
          } else {
            const b = await screenState();
            check(performance.now() < deadline && b.activeWindow, 'followup-window-not-active-after-frame');
            check(JSON.stringify(a.viewport) === JSON.stringify(sanitized.methodology.viewport) && JSON.stringify(b.viewport) === JSON.stringify(a.viewport), 'followup-frame-viewport-mismatch');
            if (stage === 'before') check(a.targetFocused && b.targetFocused && (hydrated ? a.productHeading && b.productHeading : a.catalogHeading && b.catalogHeading), 'followup-source-frame-focus-or-heading-mismatch');
            if (stage === 'after') check(a.catalogHeading && b.catalogHeading && a.firstResultInViewport && b.firstResultInViewport, 'followup-destination-result-not-in-frame');
            item.frames[stage] = { ...capture, stateBefore: a, stateAfter: b };
          }
          return { bytes, end: captureFinished };
        }
        if (hydrated) {
          const versions = ['react', 'react-dom', 'next'].map((pkg) => requireApp(`${pkg}/package.json`).version);
          check(versions.join('/') === '19.3.1/19.3.1/16.4.5', 'followup-hydration-private-probe-pin-mismatch');
          await within(productReturn(page, item), 'followup-product-source-timeout');
        } else {
          const source = await within(page.goto(ORIGIN + '/catalog', { waitUntil: 'domcontentloaded', timeout: DOCUMENT_LIMIT }), 'followup-native-source-timeout');
          check(source?.status() === 200 && page.url() === ORIGIN + '/catalog', 'followup-native-source-status-or-url-mismatch');
          noPublicLeaks(await within(source.text(), 'followup-native-source-body-timeout'));
          const form = page.locator('form.filter-bar');
          await within(form.locator('[name="q"]').fill(FILTER.q), 'followup-native-search-setup-timeout');
          for (const name of ['category', 'sort']) await within(form.locator(`[name="${name}"]`).selectOption(FILTER[name]), 'followup-native-select-setup-timeout');
          item.sourceStatus = source.status();
        }
        await within(page.waitForLoadState('load', { timeout: RENDER_LIMIT }), 'followup-source-load-timeout');
        await within(page.bringToFront(), 'followup-activate-window-timeout');
        const selector = hydrated ? '.breadcrumb a[href=' + JSON.stringify(CATALOG) + ']' : 'form.filter-bar button[type=submit]';
        if (hydrated) {
          // A server-rendered Link is not sufficient: require React's attached host node,
          // its Next Link click handler and a committed non-dehydrated HostRoot at pinned versions.
          const ready = await within(page.waitForFunction((sel) => {
            const anchor = document.querySelector(sel);
            if (!anchor?.isConnected) return false;
            const keys = Object.getOwnPropertyNames(anchor);
            const fiber = anchor[keys.find((k) => k.startsWith('__reactFiber$'))];
            const props = anchor[keys.find((k) => k.startsWith('__reactProps$'))];
            if (fiber?.tag !== 5 || fiber.stateNode !== anchor || typeof props?.onClick !== 'function') return false;
            let root = fiber;
            while (root.return) root = root.return;
            return root.tag === 3 && root.stateNode?.current?.memoizedState?.isDehydrated === false;
          }, selector, { timeout: RENDER_LIMIT }), 'followup-hydration-timeout');
          await within(ready.dispose(), 'followup-hydration-handle-timeout');
          await within(page.evaluate(() => { window.__catalogResilienceDocument = true; }), 'followup-source-document-sentinel-timeout');
          item.hydration = { react: '19.3.1', next: '16.4.5', committedHostFiberAndLinkHandler: true };
        }
        noPublicLeaks(await within(page.locator('body').evaluate((body) => body.outerHTML), 'followup-source-redaction-timeout'));
        const { root } = await send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
        check(nodeId, 'followup-cdp-focus-target-not-found');
        await send('DOM.focus', { nodeId });
        ({ frameTree: { frame: { loaderId: sourceLoaderId } } } = await send('Page.getFrameTree'));
        const beforeFrame = await frame('before');
        const before = relay.snapshot();
        check(performance.now() < deadline && !interrupted.signal.aborted, 'followup-action-deadline-or-interruption');
        page.on('request', seeRequest);
        page.on('response', seeResponse);
        try {
          const response = page.waitForResponse((res) => measured && isTarget(res.request()), { timeout: Math.max(1, deadline - performance.now()) });
          void response.catch(() => {});
          ticket = relay.set('delayed');
          actionAt = performance.now();
          measured = true;
          const press = page.keyboard.press('Enter');
          void press.catch(() => {});
          await within(ticket.whenTriggered, 'followup-relay-trigger-timeout');
          const onTrigger = relay.snapshot();
          check(requested >= actionAt && requested <= ticket.triggered && targetRequests === 1 && competingRequests === 0 && onTrigger.upstreamBytes > before.upstreamBytes && onTrigger.downstreamEvents > before.downstreamEvents, 'followup-relay-trigger-not-attributable');
          item.relay = { ticketId: ticket.id, requestMs: requested - actionAt, triggerMs: ticket.triggered - actionAt, upstreamBytesAtTrigger: onTrigger.upstreamBytes - before.upstreamBytes };
          const during = await frame('during', () => ticket.releasedMonotonic === undefined && (hydrated || responded === undefined));
          // RSC headers may arrive before the relay releases its chunk. Treat them as a
          // milestone only; validate the useful destination and completed body independently.
          const [res] = await within(Promise.all([response, press]), 'followup-target-response-timeout');
          if (hydrated) item.rscStatus = res.status();
          else item.documentStatus = res.status();
          item.responseMs = responded - actionAt;
          check(res.status() === 200 && (hydrated ? res.headers()['content-type']?.startsWith('text/x-component') : isDoc(res, CATALOG)), 'followup-target-status-or-transport-mismatch');
          await within(page.waitForURL(ORIGIN + CATALOG, { timeout: RENDER_LIMIT, waitUntil: 'commit' }), 'followup-destination-url-timeout');
          await within(catalog(page, item), 'followup-destination-render-timeout');
          const usefulAt = performance.now();
          // Verification receipt, not first paint or the first appearance of catalog data.
          item.usefulVerifiedMs = usefulAt - actionAt;
          const raw = await within(res.text(), 'followup-target-body-timeout');
          item.relay.holdMs = ticket.observedMs;
          item.relay.releaseMs = ticket.releasedMonotonic - actionAt;
          item.relay.headersBeforeRelease = responded < ticket.releasedMonotonic;
          check(ticket.observedMs >= DELAY - 2 && ticket.observedMs < DELAY + 500 && during.end < ticket.releasedMonotonic && ticket.releasedMonotonic <= usefulAt && (hydrated || ticket.releasedMonotonic <= responded), 'followup-relay-release-frame-or-destination-order');
          noPublicLeaks(raw);
          check(raw.includes(MARKER), 'followup-target-body-source-marker-missing');
          noPublicLeaks(await within(page.locator('body').evaluate((body) => body.outerHTML), 'followup-destination-redaction-timeout'));
          item.redacted = true;
          // Deliberately scroll the validated first result into view for the final evidence frame.
          await within(page.locator('.catalog-grid .book-card h3 a').first().scrollIntoViewIfNeeded(), 'followup-result-scroll-timeout');
          const after = await frame('after');
          item.frameComparison = { basis: 'jpeg-bytes-only-not-a-visual-classifier', duringJpegEqualsBefore: during.bytes.equals(beforeFrame.bytes), duringJpegEqualsAfter: during.bytes.equals(after.bytes), afterScrolledToFirstResult: true };
          if (hydrated) check(await within(page.evaluate(() => window.__catalogResilienceDocument === true), 'followup-document-continuity-timeout'), 'followup-hydrated-document-replaced');
          await within(sameProcess(item), 'followup-destination-process-timeout');
          check(documentCount === (hydrated ? 0 : 1) && targetRequests === 1 && competingRequests === 0, 'followup-navigation-request-count-mismatch');
          check(performance.now() < deadline, 'followup-case-ceiling-exceeded');
          item.withinCeiling = true;
        } finally {
          measured = false;
          item.navigationDocumentCount = documentCount;
          item.targetRequests = targetRequests;
          item.competingRequests = competingRequests;
          page.off('request', seeRequest);
          page.off('response', seeResponse);
          if (ticket) {
            isolated = ticket.releasedMonotonic !== undefined;
            relay.set('normal');
          }
        }
      });
      // Never export provisional pixels from a case that failed validation/redaction.
      for (const [stage, base64] of Object.entries(provisionalImages)) item.frames[stage].base64 = base64;
      item.pass = true;
    });
    if (!isolated) {
      item.followingCaseIsolationUnproved = true;
      break;
    }
  }
}
async function outageCycles() {
  for (let number = 1; number <= 3; number++) {
    const cycle = { number, healthy: {}, outage: {}, persistent: {}, independentRestoration: {}, firstRestored: {}, post404: {} };
    sanitized.cycles.push(cycle);
    await protectedCase(`cycle-${number}`, cycle, () => pageIn({}, async (page) => {
      await timed(page, cycle.healthy);
      await sameProcess(cycle.healthy);
      cycle.healthy.poolConnections = relay.snapshot().active;
      check(cycle.healthy.poolConnections > 0, 'application-pool-not-warm');
      const rejectedBefore = relay.snapshot().rejected;
      relay.set('outage');
      try {
        const r = await page.goto(ORIGIN + CATALOG, { waitUntil: 'commit', timeout: DOCUMENT_LIMIT });
        await recovery(page, r, cycle.outage, true);
        await sameProcess(cycle.outage);
        check(relay.snapshot().rejected > rejectedBefore, 'outage-did-not-affect-application-connection');
        if (number === 1) {
          sanitized.noJavaScript = {};
          await protectedCase('no-javascript-outage', sanitized.noJavaScript, () => pageIn({ javaScriptEnabled: false }, async (noJs) => {
            await recovery(noJs, await noJs.goto(ORIGIN + CATALOG, { waitUntil: 'commit', timeout: DOCUMENT_LIMIT }), sanitized.noJavaScript, false);
            sanitized.noJavaScript.pass = true;
          }));
        }
        const failed = await retry(page, cycle.persistent);
        try {
          await recovery(page, failed.r, cycle.persistent, true);
          await failed.verify();
          await sameProcess(cycle.persistent);
          cycle.persistent.pass = true;
        } finally { failed.close(); }
        if (number === 1) {
          const shot = await page.getByRole('main').screenshot({ timeout: RENDER_LIMIT, animations: 'disabled', type: 'jpeg', quality: 65 }).catch(() => undefined);
          sanitized.recoveryScreenshot = shot && shot.byteLength <= 90000 ? { mime: 'image/jpeg', base64: shot.toString('base64') } : { omitted: 'capture-unavailable-or-over-budget' };
        }
      } finally { relay.set('normal'); }
      const databaseStarted = await dbReady();
      check(databaseStarted === sanitized.preflight.databaseStarted, 'database-process-changed-during-restoration');
      cycle.independentRestoration = { passed: true, databaseStarted, beforeApplicationRetry: true };
      await sameProcess(cycle.independentRestoration);
      const afterProbe = relay.snapshot();
      const restored = await retry(page, cycle.firstRestored);
      try {
        await sameProcess(cycle.firstRestored);
        check(cycle.firstRestored.status === 200, 'first-post-restoration-retry-not-200');
        const raw = await bounded(restored.r.text(), RENDER_LIMIT, 'restored-document-body-timeout');
        noPublicLeaks(raw);
        check(raw.includes(MARKER) && relay.snapshot().upstreamBytes > afterProbe.upstreamBytes, 'first-retry-catalog-source-unproved');
        await catalog(page, cycle.firstRestored);
        await restored.verify();
      } finally { restored.close(); }
      await productReturn(page, cycle.firstRestored);
      cycle.firstRestored.pass = true;
      await health404(page, cycle.post404);
      cycle.pass = true;
    }));
    check(!interrupted.signal.aborted, 'run-interrupted');
    // A changed process is fatal; do not continue by restarting it.
    await sameProcess(cycle);
  }
}
async function cleanup() {
  const captures = sanitized.cleanup;
  const attempt = async (key, fn) => { try { await fn(); captures[key] = 'passed'; } catch (error) { captures[key] = 'failed'; recordFailure(`cleanup-${key}`, error); } };
  closing = true;
  if (browser) await attempt('browser', async () => {
    if (interruptedBrowserClose) check(await bounded(interruptedBrowserClose, 6000, 'browser-close-timeout'), 'browser-close-failed');
    else await bounded(browser.close(), 6000, 'browser-close-timeout');
  });
  if (app) await attempt('application', () => stop(app));
  if (relay) await attempt('relay', () => relay.close());
  if (containerCreationAttempted) await attempt('container', async () => {
    if (!containerId) {
      const matches = await docker(['ps', '-aq', '--filter', `label=${ownerLabel}=${key}`], 'docker-owned-search-failed', { capture: true, ms: 4000 });
      if (!matches) return;
    }
    await verifyOwnership(false);
    await docker(['rm', '-f', '-v', containerId], 'docker-owned-remove-failed', { ms: 12000 });
    const remaining = await docker(['ps', '-aq', '--filter', `label=${ownerLabel}=${key}`], 'docker-owned-recheck-failed', { capture: true, ms: 4000 });
    check(!remaining, 'owned-container-remains');
  });
  for (const [index, processInfo] of [...active].entries()) await attempt(`subprocess-${index + 1}`, () => stop(processInfo));
  if (sanitized.preflight.checkout) await attempt('trackedIntegrity', () => verifyTree());
  if (sanitized.preflight.ports) await attempt('portsReleased', async () => { for (const port of sanitized.preflight.ports) await assertFree(port); });
}
let interruptedBrowserClose;
const onSignal = () => {
  if (closing || interrupted.signal.aborted) return;
  interrupted.abort();
  if (browser) interruptedBrowserClose = browser.close().then(() => true, () => false);
  for (const child of [...active]) void stop(child).catch(() => {});
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
try {
  await prepareEvidence();
  check(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.APP_SHA === SHA && /^[a-f0-9]{40}$/.test(process.env.EXPERIMENT_SHA ?? ''), 'runner-or-sha-input-mismatch');
  sanitized.experiment = process.env.EXPERIMENT_SHA;
  const mode = await verifiedRunMode();
  await setup();
  if (mode === 'targeted-loading-followup') {
    phase = 'targeted-healthy-controls';
    await pageIn({}, async (page) => {
      sanitized.healthy = {};
      await timed(page, sanitized.healthy);
      await productReturn(page, sanitized.healthy);
      await health404(page, sanitized.healthy);
    });
    phase = 'targeted-loading-observations';
    await targetedObservations();
  } else {
    phase = 'healthy-and-delayed-controls';
    await samples();
    phase = 'outage-restoration';
    await outageCycles();
    phase = 'configuration-only-smoke';
    await stop(app);
    await assertFree(SMOKE_PORT);
    // childEnv was populated from an allowlist; no database URL/password is inherited.
    await exec('pnpm', ['exec', 'tsx', 'scripts/source-failure-smoke.ts', '--configuration-only'], 'configuration-only-smoke-failed', { ms: 110000 });
    sanitized.configurationOnly = { pass: true, invalidSource: 500, healthyFixture: 200, missingFixtureProduct: 404, port: SMOKE_PORT };
  }
} catch (error) { recordFailure(phase, error); }
finally {
  await cleanup();
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  const c = sanitized.cycles;
  const qualified = Boolean(sanitized.preflight.databaseStarted && sanitized.healthy?.catalog?.exactBooks && sanitized.healthy?.pass);
  const outcome = (attempted, pass) => attempted ? (pass ? 'PASS' : 'FAIL') : 'NOT RUN';
  sanitized.decisions = {
    environmentAndSourceIdentity: outcome(Boolean(sanitized.preflight.ports), qualified),
    healthyStatusControls: outcome(Boolean(sanitized.healthy), sanitized.healthy?.pass && sanitized.healthy?.productStatus === 200 && sanitized.healthy?.unknownProduct?.status === 404 && sanitized.healthy?.unknownSeries?.status === 404),
    delayedSourceBehavior: outcome(Boolean(sanitized.samples.delayed.length), sanitized.samples.normal.length === 5 && sanitized.samples.delayed.length === 5 && sanitized.samples.extra.length === 4 && [...sanitized.samples.normal, ...sanitized.samples.delayed, ...sanitized.samples.extra].every((x) => x.pass)),
    runtimeSourceLoss: outcome(Boolean(c.length), c.length === 3 && c.every((x) => x.outage.status === 500 && x.outage.visibleRecovery && x.persistent.pass)),
    sameProcessRecovery: outcome(Boolean(c.length), c.length === 3 && c.every((x) => x.pass && x.firstRestored.pass && x.firstRestored.status === 200)),
    redaction: outcome(Boolean(c.length), c.length === 3 && c.every((x) => x.outage.rawRedacted && x.outage.renderedRedacted && x.persistent.rawRedacted && x.persistent.renderedRedacted) && sanitized.noJavaScript?.pass),
    noFixtureSubstitution: outcome(Boolean(c.length), qualified && c.length === 3 && c.every((x) => x.outage.rawNoSubstitution && x.outage.renderedNoSubstitution && x.persistent.rawNoSubstitution && x.persistent.renderedNoSubstitution && x.firstRestored.catalog?.exactBooks) && sanitized.noJavaScript?.pass),
    cleanupAndRepositoryIntegrity: outcome(Boolean(sanitized.preflight.checkout), sanitized.cleanup.trackedIntegrity === 'passed' && Object.values(sanitized.cleanup).every((x) => x === 'passed')),
  };
  if (sanitized.followup) {
    const observations = sanitized.followup.observations ?? [];
    const finished = (index) => observations[index] ? (observations[index].pass ? 'PASS' : 'FAIL') : 'NOT RUN';
    sanitized.decisions = {
      environmentAndSourceIdentity: sanitized.decisions.environmentAndSourceIdentity,
      healthyStatusControls: sanitized.decisions.healthyStatusControls,
      nativeGetLoadingObservation: finished(0),
      hydratedLinkLoadingObservation: finished(1),
      cleanupAndRepositoryIntegrity: sanitized.decisions.cleanupAndRepositoryIntegrity,
    };
    sanitized.result = !sanitized.failures.length && Object.values(sanitized.decisions).every((x) => x === 'PASS') ? 'PASS' : sanitized.healthy ? 'FAIL' : 'BLOCKED';
  } else {
    sanitized.result = !sanitized.failures.length && sanitized.configurationOnly?.pass && Object.values(sanitized.decisions).every((x) => x === 'PASS') ? 'PASS' : sanitized.healthy ? 'FAIL' : 'BLOCKED';
  }
  if (evidenceDir) {
    try { await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); } catch { process.stdout.write('Catalog resilience evidence could not be written.\n'); process.exitCode = 1; }
  }
  process.stdout.write(`Catalog resilience result: ${sanitized.result}\n`);
  if (sanitized.result !== 'PASS') process.exitCode = 1;
}