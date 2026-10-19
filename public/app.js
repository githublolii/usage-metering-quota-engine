/**
 * Quota Engine Dashboard — frontend logic.
 *
 * CSP-safe: external file, no inline handlers, no eval. All engine calls go
 * through `api()` which attaches the session key (localStorage) as
 * `X-API-Key` and surfaces the `X-Idempotent-Replay` header.
 *
 * Sections:
 *   1. state + transport helpers
 *   2. rendering helpers (bars, chips, messages)
 *   3. workspace loaders (account / plans / users / usage / history)
 *   4. provisioning + key lifecycle
 *   5. consume flow (fresh + idempotent replay)
 *   6. guided tour (the six showcase phases, asserted live)
 *   7. boot & event wiring
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. State + transport
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const KEY_STORE = 'metering.key';

function loadStoredKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
function storeKey(key) {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
}

const state = {
  key: loadStoredKey(),
  currentRequestId: null,
  lastRequestId: null,
  plans: [],
  historyRecords: [],
};

/** Single transport: attaches the session key, returns status + replay header. */
async function api(method, path, body, key = state.key) {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    replay: response.headers.get('x-idempotent-replay'),
    body: data,
  };
}

/** Human-readable text from an RFC 7807 problem+json body. */
function problemText(result) {
  const body = result.body;
  if (!body) return `HTTP ${result.status}`;
  const base = body.detail || body.title || `HTTP ${result.status}`;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return `${base} (${body.errors.map((e) => `${e.path}: ${e.message}`).join('; ')})`;
  }
  return base;
}

const show = (el, on = true) => el.classList.toggle('hidden', !on);
const shortId = (id) => (id && id.length > 12 ? `${id.slice(0, 8)}…` : String(id ?? ''));

// ---------------------------------------------------------------------------
// 2. Rendering helpers
// ---------------------------------------------------------------------------

/** Inline message in a card's #msg-* element. */
function flash(id, text, kind = 'error') {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${kind}`;
  show(el, text !== '');
}

function clearFlash(id) {
  const el = $(id);
  el.textContent = '';
  el.className = 'msg hidden';
}

/**
 * A usage bar: `remaining = GREATEST(0, allowance - consumed)` mirrors the
 * engine's derived budget; colors go ok → warn → danger.
 */
function usageBar({ label, planName, allowance, maxPerRequest, consumed }) {
  const pct = allowance > 0 ? Math.min(100, (consumed / allowance) * 100) : 0;
  const remaining = Math.max(0, allowance - consumed);
  const cls = pct >= 100 ? 'fill danger' : pct >= 75 ? 'fill warn' : 'fill';
  return `
    <div class="usage">
      <div class="usage-head">
        <span class="who">${label} · ${escapeHtml(planName)}</span>
        <span class="nums">${consumed.toLocaleString()} / ${allowance.toLocaleString()} · remaining ${remaining.toLocaleString()}</span>
      </div>
      <div class="bar"><div class="${cls}" style="width: ${pct.toFixed(1)}%"></div></div>
      <div class="usage-sub">max ${maxPerRequest.toLocaleString()} units per request</div>
    </div>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;',
  })[c] ?? c);
}

// ---------------------------------------------------------------------------
// 3. Workspace loaders
// ---------------------------------------------------------------------------

async function refreshAll() {
  await Promise.all([
    loadAccount(),
    loadPlans(),
    loadUsers(),
    loadHistory(),
    loadUsage($('usage-user').value || ''),
  ]);
}

async function loadAccount() {
  const result = await api('GET', '/accounts/me');
  if (result.status !== 200) return sessionInvalid(result);

  const account = result.body.account;
  const body = $('account-body');
  body.innerHTML = `
    <div class="account-head">
      <span class="account-name">${escapeHtml(account.name)}</span>
      <span class="chip">${escapeHtml(account.plan.type)} plan</span>
      <span class="chip">id ${shortId(account.id)}</span>
    </div>
    ${usageBar({
      label: 'Account',
      planName: account.plan.name,
      allowance: account.plan.monthlyAllowance,
      maxPerRequest: account.plan.maxUnitsPerRequest,
      consumed: account.usage.unitsConsumed,
    })}
    <div class="muted small">billing period ${escapeHtml(account.usage.period)} (UTC) · created ${escapeHtml(String(account.createdAt).slice(0, 19).replace('T', ' '))}</div>`;
  $('foot-period').textContent = `· period ${account.usage.period}`;
}

/** Populate the plan switcher (ACCOUNT plans) + registration select (USER plans). */
async function loadPlans() {
  const result = await api('GET', '/plans');
  if (result.status !== 200) return sessionInvalid(result);
  state.plans = result.body.plans;

  const accountPlans = state.plans.filter((p) => p.type === 'ACCOUNT');
  const userPlans = state.plans.filter((p) => p.type === 'USER');

  const option = (p) =>
    `<option value="${p.id}">${escapeHtml(p.name)} — ${p.monthlyAllowance.toLocaleString()}/mo, max ${p.maxUnitsPerRequest}/request${p.isPredefined ? '' : ' (custom)'}</option>`;

  $('plan-switch').innerHTML = accountPlans.map(option).join('');
  $('new-user-plan').innerHTML = userPlans.map(option).join('');
}

async function loadUsers() {
  const result = await api('GET', '/users');
  if (result.status !== 200) return sessionInvalid(result);
  const users = result.body.users;

  const list = $('users-list');
  list.innerHTML = users.length === 0
    ? '<li class="muted">No users yet — register one below.</li>'
    : users.map((u) => `
        <li>
          <span class="uid">${escapeHtml(u.userId)}</span>
          <span class="plan">${escapeHtml(u.plan.name)} · ${u.plan.monthlyAllowance.toLocaleString()}/mo · max ${u.plan.maxUnitsPerRequest}/request</span>
        </li>`).join('');

  const userOptions = users
    .map((u) => `<option value="${escapeHtml(u.userId)}">${escapeHtml(u.userId)}</option>`)
    .join('');

  const consumeSelect = $('consume-user');
  const previousConsume = consumeSelect.value;
  consumeSelect.innerHTML = userOptions;
  if (users.some((u) => u.userId === previousConsume)) consumeSelect.value = previousConsume;
  $('consume-btn').disabled = users.length === 0;
  $('replay-btn').disabled = users.length === 0 || state.lastRequestId === null;

  const usageSelect = $('usage-user');
  const previousUsage = usageSelect.value;
  usageSelect.innerHTML =
    '<option value="">— account only —</option>' + userOptions;
  if (previousUsage !== '' || users.some((u) => u.userId === previousUsage)) {
    usageSelect.value = previousUsage;
  }
}

async function loadUsage(userId) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const result = await api('GET', `/metering/usage${query}`);
  if (result.status !== 200) return sessionInvalid(result);

  const body = result.body;
  const html = [usageBar({
    label: 'Account',
    planName: body.account.planName,
    allowance: body.account.monthlyAllowance,
    maxPerRequest: body.account.maxUnitsPerRequest,
    consumed: body.account.unitsConsumed,
  })];

  if (body.user) {
    html.push(usageBar({
      label: `User ${userId}`,
      planName: body.user.planName,
      allowance: body.user.monthlyAllowance,
      maxPerRequest: body.user.maxUnitsPerRequest,
      consumed: body.user.unitsConsumed,
    }));
  }
  $('usage-body').innerHTML = html.join('');
}

async function loadHistory() {
  const filter = $('history-filter').value;
  const params = new URLSearchParams({ limit: '25' });
  if (filter !== '') params.set('accepted', filter);
  const result = await api('GET', `/metering/history?${params}`);
  if (result.status !== 200) return sessionInvalid(result);

  const { records, total } = result.body;
  state.historyRecords = records;
  $('history-count').textContent = `${total} record${total === 1 ? '' : 's'}`;
  $('history-rows').innerHTML = records.length === 0
    ? '<tr><td colspan="6" class="muted">No decisions recorded yet.</td></tr>'
    : records.map((r) => {
        const chip = r.accepted
          ? '<span class="chip ok">accepted</span>'
          : '<span class="chip bad">rejected</span>';
        const rule = r.accepted
          ? '<span class="muted">—</span>'
          : `${escapeHtml(r.rejectionSource ?? '')} · ${escapeHtml(r.rejectionRule ?? '')}`;
        return `
          <tr>
            <td class="mono">${escapeHtml(String(r.createdAt).slice(11, 19))}</td>
            <td class="mono">${escapeHtml(r.userId)}</td>
            <td class="mono">${r.unitsRequested.toLocaleString()}</td>
            <td>${chip}</td>
            <td>${rule}</td>
            <td class="mono" title="${escapeHtml(r.requestId)}">${escapeHtml(shortId(r.requestId))}</td>
          </tr>`;
      }).join('');
  drawChart();
}

// ---------------------------------------------------------------------------
// 4. Session + provisioning
// ---------------------------------------------------------------------------

function showWorkspace(on) {
  show($('workspace'), on);
  show($('provision-card'), !on);
}

function sessionInvalid(result) {
  storeKey('');
  state.key = '';
  showWorkspace(false);
  flash('msg-provision', `Session rejected (HTTP ${result.status}): ${problemText(result)} — connect with a valid key or provision below.`);
}

async function connectWithKey(key) {
  state.key = key;
  storeKey(key);
  clearFlash('msg-provision');
  showWorkspace(true);
  await refreshAll();
}

async function provisionAccount() {
  const name = $('acct-name').value.trim() || `web-${new Date().toISOString().slice(0, 10)}`;
  const planName = $('acct-plan').value;
  const result = await api('POST', '/accounts', { name, planName }, null);

  if (result.status !== 201) {
    flash('msg-provision', `Provisioning failed (HTTP ${result.status}): ${problemText(result)}`);
    return;
  }

  clearFlash('msg-provision');
  show($('key-banner'));
  $('key-value').textContent = result.body.apiKey;
}

async function rotateKey() {
  const result = await api('POST', '/accounts/rotate-key', {});
  if (result.status !== 200) {
    flash('msg-account', `Rotation failed (HTTP ${result.status}): ${problemText(result)}`);
    return;
  }
  state.key = result.body.apiKey;
  storeKey(state.key);
  $('key-value').textContent = state.key;
  show($('key-banner'));
  show($('provision-card'), false);
  flash('msg-account', 'API key rotated — the old key is dead atomically. Copy the new one from the banner above.', 'good');
}

// ---------------------------------------------------------------------------
// 5. Consume flow
// ---------------------------------------------------------------------------

function newRequestId() {
  state.currentRequestId = crypto.randomUUID();
  $('consume-rid').textContent = state.currentRequestId;
  $('consume-rid').title = state.currentRequestId;
}

async function consume(replay = false) {
  const requestId = replay ? state.lastRequestId : state.currentRequestId;
  if (!requestId) {
    flash('msg-users', 'No request to replay yet — send a consume request first.');
    return;
  }
  const userId = $('consume-user').value;
  const units = Number($('consume-units').value);

  const result = await api('POST', '/metering/consume', { userId, units, requestId });
  renderConsumeResult(result, replay);

  state.lastRequestId = requestId;
  $('replay-btn').disabled = false;
  if (!replay) newRequestId();
  await refreshAll();
}

function renderConsumeResult(result, replay) {
  const panel = $('consume-result');
  const body = result.body;

  if (result.status === 401) return sessionInvalid(result);

  // Raw JSON inspector — show the exact payload for every outcome, so the
  // wire format is always one click away (defense-ready).
  updateJsonViewer(body === null ? `HTTP ${result.status} (non-JSON response)` : JSON.stringify(body, null, 2));

  if (body && body.accepted === true) {
    panel.className = 'result accepted';
    const replayNote = result.replay === 'true'
      ? '<div class="result-meta">♻️ idempotent replay — this requestId was already processed; <strong>no units were re-charged</strong>.</div>'
      : '';
    panel.innerHTML = `
      <div class="result-title"><span class="chip ok">accepted</span> HTTP ${result.status} · consumed ${body.unitsConsumed.toLocaleString()} units</div>
      <div class="result-meta">period ${escapeHtml(body.period)} · requestId ${escapeHtml(shortId(body.requestId))}</div>
      ${replayNote}
      ${usageBar({
        label: 'Account', planName: body.usage.account.planName,
        allowance: body.usage.account.monthlyAllowance,
        maxPerRequest: body.usage.account.maxUnitsPerRequest,
        consumed: body.usage.account.unitsConsumed,
      })}
      ${usageBar({
        label: 'User', planName: body.usage.user.planName,
        allowance: body.usage.user.monthlyAllowance,
        maxPerRequest: body.usage.user.maxUnitsPerRequest,
        consumed: body.usage.user.unitsConsumed,
      })}`;
    return;
  }

  if (body && body.accepted === false) {
    const v = body.violation;
    panel.className = 'result rejected';
    panel.innerHTML = `
      <div class="result-title"><span class="chip bad">rejected</span> HTTP ${result.status} · 0 units consumed</div>
      <div class="result-meta">period ${escapeHtml(body.period)} · requestId ${escapeHtml(shortId(body.requestId))}${result.replay === 'true' ? ' · ♻️ idempotent replay of a rejected decision' : ''}</div>
      <div><strong>${escapeHtml(body.reason)}</strong></div>
      <div class="violation">
        <div class="cell"><div class="k">source</div><div class="v">${escapeHtml(v.source)}</div></div>
        <div class="cell"><div class="k">rule</div><div class="v">${escapeHtml(v.rule)}</div></div>
        <div class="cell"><div class="k">limit</div><div class="v">${v.limit.toLocaleString()}</div></div>
        <div class="cell"><div class="k">requested</div><div class="v">${v.requestedUnits.toLocaleString()}</div></div>
        <div class="cell"><div class="k">current usage</div><div class="v">${v.currentUsage.toLocaleString()}</div></div>
      </div>`;
    return;
  }

  // Transport-level / validation problem (400, 404, 500…)
  panel.className = 'result rejected';
  panel.innerHTML = `
    <div class="result-title"><span class="chip bad">error</span> HTTP ${result.status}</div>
    <div>${escapeHtml(problemText(result))}</div>`;
}

/** Raw JSON response inspector — fed from every consume outcome. */
function updateJsonViewer(text) {
  const details = $('json-details');
  const pre = $('json-pre');
  show(details, true);
  pre.textContent = text; // textContent, never innerHTML — untrusted data
}

/**
 * Copy-as-cURL: emit the exact terminal command for the currently composed
 * consume request, embedding the session key, so any dashboard action can
 * be reproduced in a shell against the real API.
 */
function buildCurlCommand() {
  const userId = $('consume-user').value;
  const units = Number($('consume-units').value);
  const requestId = state.currentRequestId;
  const payload = JSON.stringify({ userId, units, requestId });
  return [
    `curl -i -X POST '${location.origin}/metering/consume'`,
    `  -H 'content-type: application/json'`,
    `  -H 'x-api-key: ${state.key}'`,
    `  -d '${payload}'`,
  ].join(' \\\n');
}

async function registerUser() {
  const userId = $('new-user').value.trim();
  if (userId === '') {
    flash('msg-users', 'Enter a userId first.');
    return;
  }
  const planId = $('new-user-plan').value;
  const result = await api('POST', '/users', { userId, planId });

  if (result.status !== 201) {
    flash('msg-users', `Registration failed (HTTP ${result.status}): ${problemText(result)}`);
    return;
  }
  clearFlash('msg-users');
  flash('msg-users', `User "${userId}" registered on ${result.body.user.plan.name}.`, 'good');
  $('new-user').value = '';
  await Promise.all([loadUsers(), loadUsage($('usage-user').value || '')]);
}

async function applyPlanChange() {
  const planId = $('plan-switch').value;
  const plan = state.plans.find((p) => p.id === planId);
  const result = await api('PATCH', '/accounts/plan', { planId });

  if (result.status !== 200) {
    flash('msg-account', `Plan change failed (HTTP ${result.status}): ${problemText(result)}`);
    return;
  }
  flash('msg-account', `Plan re-bound to "${plan?.name ?? planId}" — usage counters untouched.`, 'good');
  await refreshAll();
}

// ---------------------------------------------------------------------------
// 6. Consumption timeline chart (dependency-free canvas)
//    Bars   → per-request units (green accepted / red rejected, left axis)
//    Line   → cumulative accepted units (indigo, right axis)
// ---------------------------------------------------------------------------

function drawChart() {
  const canvas = $('chart-canvas');
  if (canvas === null) return;

  // Oldest → newest, left → right.
  const records = (state.historyRecords ?? []).slice().reverse();
  const acceptedCount = records.filter((r) => r.accepted).length;
  const rejectedCount = records.length - acceptedCount;
  const totalUnits = records
    .filter((r) => r.accepted)
    .reduce((sum, r) => sum + r.unitsRequested, 0);
  $('chart-totals').textContent = records.length === 0
    ? 'no decisions yet'
    : `${acceptedCount} accepted · ${rejectedCount} rejected · ${totalUnits.toLocaleString()} units`;

  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(220, wrap.clientWidth);
  const cssH = 210;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (records.length === 0) {
    ctx.fillStyle = '#8b93b8';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No decisions yet — consume units or run the guided tour.', 10, cssH / 2);
    return;
  }

  const padL = 36;
  const padR = 48;
  const padT = 14;
  const padB = 18;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const maxUnits = Math.max(...records.map((r) => r.unitsRequested), 1);
  let cumulative = 0;
  const cumulativeSeries = records.map((r) => {
    if (r.accepted) cumulative += r.unitsRequested;
    return cumulative;
  });
  const maxCumulative = Math.max(cumulativeSeries[cumulativeSeries.length - 1] ?? 0, 1);

  // Gridlines + left-axis labels (per-request units).
  ctx.font = '10px ui-monospace, monospace';
  for (let i = 0; i <= 3; i += 1) {
    const y = padT + plotH * (i / 3);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssW - padR, y);
    ctx.stroke();
    ctx.fillStyle = '#8b93b8';
    ctx.fillText(String(Math.round(maxUnits * (1 - i / 3))), 4, y + 3);
  }
  // Right-axis max (cumulative).
  ctx.fillStyle = '#818cf8';
  ctx.fillText(String(maxCumulative), cssW - padR + 8, padT + 3);

  // Bars: one per decision.
  const n = records.length;
  const slot = plotW / n;
  const barW = Math.max(3, Math.min(18, slot - 2));
  records.forEach((record, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = (record.unitsRequested / maxUnits) * plotH;
    ctx.fillStyle = record.accepted
      ? 'rgba(52, 211, 153, 0.85)'
      : 'rgba(248, 113, 113, 0.8)';
    ctx.fillRect(x, padT + plotH - h, barW, h);
  });

  // Cumulative accepted line (right axis).
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  cumulativeSeries.forEach((value, i) => {
    const x = padL + slot * i + slot / 2;
    const y = padT + plotH - (value / maxCumulative) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Baseline.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  ctx.lineTo(cssW - padR, padT + plotH);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// 7. Guided tour — the six showcase phases (fresh account, fully asserted)
// ---------------------------------------------------------------------------

const TOUR_USER_1 = 'tour-user-1';
const TOUR_USER_2 = 'tour-user-2';

class Tour {
  constructor() {
    this.key = null;
    this.accountId = null;
    this.log = $('tour-log');
  }

  line(html, cls = '') {
    const div = document.createElement('div');
    div.className = `log-line ${cls}`;
    div.innerHTML = html;
    this.log.appendChild(div);
    this.log.scrollTop = this.log.scrollHeight;
  }

  phase(n, text) {
    this.line(`◆ <strong>Phase ${n}</strong> — ${text}`, 'phase');
  }

  pass(text) { this.line(`<span class="ok">✔</span> ${text}`); }

  fail(text, result) {
    this.line(`<span class="bad">✘</span> ${text}${result ? ` <span class="dim">— HTTP ${result.status} ${escapeHtml(problemText(result))}</span>` : ''}`, 'err');
  }

  assert(condition, text, result) {
    if (condition) this.pass(text);
    else this.fail(text, result);
    return condition;
  }

  async call(method, path, body) {
    return api(method, path, body, this.key);
  }

  async run() {
    this.log.innerHTML = '';
    show(this.log);

    // Phase 1 — provision ---------------------------------------------------
    this.phase(1, 'provision a fresh account (API key shown exactly once)');
    const name = `tour-${crypto.randomUUID().slice(0, 6)}`;
    const created = await this.call('POST', '/accounts', { name, planName: 'Starter' });
    if (!this.assert(created.status === 201, `account "${name}" created on Starter (100/mo, max 10/request)`, created)) {
      return false;
    }
    this.key = created.body.apiKey;
    this.accountId = created.body.account.id;
    this.pass(`API key issued: <span class="dim">${escapeHtml(this.key)}</span>`);

    // Phase 2 — users -------------------------------------------------------
    this.phase(2, 'register tour-user-1 (Basic) and tour-user-2 (Premium)');
    const u1 = await this.call('POST', '/users', { userId: TOUR_USER_1, planName: 'Basic' });
    const u2 = await this.call('POST', '/users', { userId: TOUR_USER_2, planName: 'Premium' });
    if (!this.assert(u1.status === 201, 'tour-user-1 → Basic (100/mo, max 20/request)', u1)) return false;
    if (!this.assert(u2.status === 201, 'tour-user-2 → Premium (300/mo, max 50/request)', u2)) return false;

    // Phase 3 — accepted consumption ---------------------------------------
    this.phase(3, 'accepted consumption — tour-user-1 requests 10 units');
    const first = await this.call('POST', '/metering/consume', {
      userId: TOUR_USER_1, units: 10, requestId: crypto.randomUUID(),
    });
    if (!this.assert(
      first.status === 200 && first.body?.accepted === true,
      `accepted — account ${first.body?.usage?.account?.unitsConsumed}/100, user-1 ${first.body?.usage?.user?.unitsConsumed}/100`,
      first,
    )) return false;

    // Phase 4 — user rule violation + idempotent replay ----------------------
    this.phase(4, 'USER rule violation — tour-user-1 requests 25 (max 20), then idempotent replay');
    const violationId = crypto.randomUUID();
    const rejected = await this.call('POST', '/metering/consume', {
      userId: TOUR_USER_1, units: 25, requestId: violationId,
    });
    const v = rejected.body?.violation;
    if (!this.assert(
      rejected.status === 422 &&
        v?.source === 'user' && v?.rule === 'max_units_per_request' &&
        v?.limit === 20 && v?.requestedUnits === 25,
      `rejected 422 — violation { source: user, rule: max_units_per_request, limit: 20, requested: 25, currentUsage: ${v?.currentUsage} }`,
      rejected,
    )) return false;

    const replayed = await this.call('POST', '/metering/consume', {
      userId: TOUR_USER_1, units: 25, requestId: violationId,
    });
    if (!this.assert(
      replayed.status === 422 && replayed.replay === 'true',
      'same requestId replays the identical 422 decision — zero units re-charged (X-Idempotent-Replay: true)',
      replayed,
    )) return false;

    // Phase 5 — account exhaustion ------------------------------------------
    this.phase(5, 'account exhaustion — tour-user-2 drains the shared Starter allowance');
    let last = null;
    for (let i = 0; i < 12; i += 1) {
      last = await this.call('POST', '/metering/consume', {
        userId: TOUR_USER_2, units: 10, requestId: crypto.randomUUID(),
      });
      if (last.status !== 200) break;
      this.pass(`accepted — account total ${last.body?.usage?.account?.unitsConsumed}/100${last.body?.usage?.account?.unitsConsumed === 100 ? ' (exact boundary)' : ''}`);
    }
    const av = last?.body?.violation;
    if (!this.assert(
      last?.status === 422 &&
        av?.source === 'account' && av?.rule === 'monthly_allowance' &&
        av?.limit === 100 && av?.currentUsage === 100,
      'pool exhausted — rejected 422 { source: account, rule: monthly_allowance, currentUsage: 100 }',
      last,
    )) return false;

    // Phase 6 — runtime plan mutation ---------------------------------------
    this.phase(6, 'runtime plan mutation — Starter → Pro, no restart, usage preserved');
    const upgraded = await this.call('PATCH', '/accounts/plan', { planName: 'Pro' });
    if (!this.assert(upgraded.status === 200, 'account re-bound to Pro (500/mo, max 50/request)', upgraded)) return false;

    const me = await this.call('GET', '/accounts/me');
    const usage = me.body?.account?.usage;
    if (!this.assert(
      usage?.unitsConsumed === 100 && usage?.remaining === 400,
      `usage preserved — consumed 100, remaining 400 (monotonic counters untouched)`,
      me,
    )) return false;

    const retry = await this.call('POST', '/metering/consume', {
      userId: TOUR_USER_2, units: 10, requestId: crypto.randomUUID(),
    });
    if (!this.assert(
      retry.status === 200 &&
        retry.body?.usage?.account?.unitsConsumed === 110 &&
        retry.body?.usage?.account?.remaining === 390,
      'previously-rejected request now passes — account 110/500, remaining 390',
      retry,
    )) return false;

    this.line('<span class="ok">✔</span> <strong>Tour complete — all six phases passed. Adopting this account into the dashboard…</strong>', 'phase');
    return true;
  }
}

async function runTour() {
  const button = $('tour-run');
  button.disabled = true;
  button.textContent = '⏳ Running…';
  try {
    const tour = new Tour();
    const completed = await tour.run();
    if (completed) {
      await connectWithKey(tour.key);
    }
  } catch (error) {
    // Network-level failure (server down, etc.)
    const tourLog = $('tour-log');
    show(tourLog);
    const div = document.createElement('div');
    div.className = 'log-line err';
    div.textContent = `✘ transport error: ${error instanceof Error ? error.message : String(error)}`;
    tourLog.appendChild(div);
  } finally {
    button.disabled = false;
    button.textContent = '▶ Run guided tour';
  }
}

// ---------------------------------------------------------------------------
// 8. Boot & event wiring
// ---------------------------------------------------------------------------

async function pollHealth() {
  const dot = $('health-dot');
  try {
    const response = await fetch('/health');
    dot.classList.toggle('up', response.ok);
    dot.title = response.ok ? 'API + database healthy' : 'API up, database degraded';
  } catch {
    dot.classList.remove('up');
    dot.title = 'API unreachable';
  }
}

function wire() {
  // session controls
  $('key-save').addEventListener('click', () => {
    const key = $('key-input').value.trim();
    if (key === '') {
      flash('msg-provision', 'Paste an API key (mk_…) or provision an account below.');
      return;
    }
    void connectWithKey(key);
  });
  $('key-clear').addEventListener('click', () => {
    storeKey('');
    state.key = '';
    showWorkspace(false);
    flash('msg-provision', 'Session cleared. Connect with a key or provision a new account.');
  });
  $('key-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('key-save').click();
  });

  // provisioning
  $('provision-btn').addEventListener('click', () => void provisionAccount());
  $('key-copy').addEventListener('click', () => {
    void navigator.clipboard.writeText($('key-value').textContent || '');
    $('key-copy').textContent = 'Copied ✓';
    setTimeout(() => { $('key-copy').textContent = 'Copy key'; }, 1600);
  });
  $('key-use').addEventListener('click', () => {
    void connectWithKey($('key-value').textContent || '');
    show($('key-banner'), false);
  });

  // workspace actions
  $('plan-apply').addEventListener('click', () => void applyPlanChange());
  $('rotate-btn').addEventListener('click', () => void rotateKey());
  $('user-create').addEventListener('click', () => void registerUser());
  $('new-user').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('user-create').click();
  });
  $('usage-user').addEventListener('change', () => void loadUsage($('usage-user').value));
  $('usage-refresh').addEventListener('click', () => void loadUsage($('usage-user').value));

  // consume
  $('consume-btn').addEventListener('click', () => void consume(false));
  $('replay-btn').addEventListener('click', () => void consume(true));
  $('rid-new').addEventListener('click', () => newRequestId());
  $('curl-copy').addEventListener('click', () => {
    const button = $('curl-copy');
    void navigator.clipboard
      .writeText(buildCurlCommand())
      .then(() => {
        button.textContent = 'Copied ✓';
        setTimeout(() => { button.textContent = '⧉ Copy as cURL'; }, 1600);
      })
      .catch(() => flash('msg-users', 'Clipboard unavailable — copy from the JSON viewer instead.'));
  });

  // history
  $('history-refresh').addEventListener('click', () => void loadHistory());
  $('history-filter').addEventListener('change', () => void loadHistory());

  // tour
  $('tour-run').addEventListener('click', () => void runTour());
}

function boot() {
  wire();
  newRequestId();
  void pollHealth();
  setInterval(pollHealth, 10_000);
  drawChart();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 120);
  });

  if (state.key !== '') {
    // Reconnect a stored session; fall back to provisioning if the key died.
    void connectWithKey(state.key);
  } else {
    showWorkspace(false);
  }
}

boot();
