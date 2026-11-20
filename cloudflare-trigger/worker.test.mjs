import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { runAlarm } from './worker.mjs';

const ALARM_TIME = Date.parse('2026-11-22T05:17:00.000Z');
const SLOT = '2026-11-22T05:15:00.000Z';
const WORKFLOW = 'https://api.github.com/repos/jiwoo4292-png/orion-daily-proof/actions/workflows/orion-source-watch.yml';
const ALERT = 'https://private-alert.example/secret-test-path';
const FAKE_TOKEN = 'fake-github-token';
const ENV = {
  ORION_WATCH_ENABLED: 'true',
  GH_DISPATCH_TOKEN: FAKE_TOKEN,
  ORION_WATCH_ALERT_WEBHOOK: ALERT,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function job(stepName, status = 'in_progress', conclusion = null) {
  return json({ jobs: [{ name: 'watch', status, conclusion, steps: [
    { name: stepName, status, conclusion, started_at: SLOT },
  ] }] });
}

function harness(t, handlers) {
  const posts = [];
  const jobs = [];
  const alerts = [];
  const queries = [];
  const invalid = [];
  const waits = [];
  const logs = t.mock.method(console, 'log', () => {});
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    if (url.href === ALERT) {
      alerts.push(options);
      return handlers.alert?.() ?? new Response(null, { status: 204 });
    }
    if (url.href === `${WORKFLOW}/dispatches`) {
      posts.push(options);
      return handlers.dispatch?.(posts.length) ?? json({ workflow_run_id: posts.length });
    }
    if (url.href.startsWith(`${WORKFLOW}/runs?`)) {
      queries.push(url.searchParams);
      return handlers.discover?.(queries.length) ?? json({ workflow_runs: [] });
    }
    const match = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (match) {
      jobs.push(Number(match[1]));
      return handlers.job?.(Number(match[1]), posts.length, jobs.length) ?? json({ jobs: [] });
    }
    invalid.push(url.href);
    return new Response(null, { status: 404 });
  };
  const options = { fetchImpl, sleep: async (ms) => waits.push(ms) };

  function messages() {
    return logs.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  }

  t.after(() => {
    assert.deepEqual(invalid, []);
    const output = JSON.stringify(messages());
    assert.ok(!output.includes(FAKE_TOKEN));
    assert.ok(!output.includes(ALERT));
  });
  return { run: (env = ENV, time = ALARM_TIME) => runAlarm(time, env, options), posts, jobs, alerts, queries, waits, messages };
}

test('confirmed watcher step starts the correct UTC quarter-hour', async (t) => {
  const mock = harness(t, { job: () => job('Run ORION watcher') });
  await mock.run();

  assert.deepEqual(mock.jobs, [1]);
  assert.deepEqual(JSON.parse(mock.posts[0].body), { ref: 'main', inputs: { scope: 'pilot', slot: SLOT } });
  assert.equal(mock.posts[0].headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(mock.posts[0].headers['User-Agent'], 'ORION hello@orionbiotechai.com');
  assert.equal(mock.posts[0].redirect, 'manual');
  assert.ok(mock.posts[0].signal instanceof AbortSignal);
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.alerts.length, 0);
  assert.equal(mock.messages().at(-1).event, 'watcher_started');
});

test('queued dispatch and started unrelated job are not watcher starts, then retry the same slot', async (t) => {
  const mock = harness(t, { job: (id) => id === 1 ? job('Set up Node') : job('Run ORION watcher') });
  await mock.run();
  assert.equal(mock.posts.length, 2);
  assert.equal(mock.posts[0].body, mock.posts[1].body);
  assert.equal(mock.messages().at(-1).runId, 2);
  assert.equal(mock.alerts.length, 0);
});

test('a late start of the first job is still observed after retry', async (t) => {
  const mock = harness(t, { job: (id, attempt) => id === 1 && attempt === 2 ? job('Run ORION watcher') : json({ jobs: [] }) });
  await mock.run();
  assert.equal(mock.posts.length, 2);
  assert.equal(mock.messages().at(-1).runId, 1);
});

test('successful duplicate-covered marker acknowledges a skipped watcher', async (t) => {
  const mock = harness(t, { job: () => job('Duplicate watcher slot', 'completed', 'success') });
  await mock.run();
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.alerts.length, 0);
  assert.equal(mock.messages().at(-1).event, 'watcher_duplicate_covered');
});

test('no actual work start after two dispatches alerts once and raises a Cron failure', async (t) => {
  const mock = harness(t, { job: () => job('Run ORION watcher', 'completed', 'skipped') });
  await assert.rejects(mock.run(), /start unconfirmed after retry/);
  assert.equal(mock.posts.length, 2);
  assert.equal(mock.alerts.length, 1);
  assert.equal(mock.alerts[0].headers.Authorization, undefined);
  assert.equal(mock.alerts[0].redirect, 'manual');
  assert.match(JSON.parse(mock.alerts[0].body).text, /dispatch 2/);
  assert.deepEqual(mock.messages().at(-1), { event: 'watcher_alert', slot: SLOT, delivered: true, status: 204 });
});

test('a lost response discovers only exact run name in the correct workflow and slot', async (t) => {
  const mock = harness(t, {
    dispatch: () => { throw new Error(`private details containing ${FAKE_TOKEN}`); },
    discover: () => json({ workflow_runs: [
      { id: 9, display_title: 'ORION watcher 2026-11-22T05:00:00.000Z' },
      { id: 10, display_title: `ORION watcher ${SLOT}` },
    ] }),
    job: () => job('Run ORION watcher', 'completed', 'success'),
  });
  await mock.run();
  assert.deepEqual(mock.jobs, [10]);
  assert.equal(mock.queries[0].get('event'), 'workflow_dispatch');
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.alerts.length, 0);
});

test('poll requests stay under the Workers Free subrequest limit', async (t) => {
  const mock = harness(t, {
    dispatch: () => new Response(null, { status: 204 }),
    discover: () => json({ workflow_runs: [1, 2, 3, 4].map((id) => ({ id, display_title: `ORION watcher ${SLOT}` })) }),
  });
  await assert.rejects(mock.run(), /start unconfirmed/);
  assert.equal(mock.posts.length + mock.queries.length + mock.jobs.length + mock.alerts.length, 43);
  assert.equal(mock.waits.reduce((sum, retry) => sum + retry, 0), 170000);
});

test('failed private alert uses sanitized data and never follows a redirect', async (t) => {
  const mock = harness(t, {
    dispatch: () => json({ error: FAKE_TOKEN }, 422),
    alert: () => new Response(null, { status: 302, headers: { location: 'https://should-not-follow.example' } }),
  });
  await assert.rejects(mock.run(), /start unconfirmed/);
  assert.equal(mock.posts.length, 2);
  assert.equal(mock.alerts.length, 1);
  assert.deepEqual(mock.messages().at(-1), { event: 'watcher_alert', slot: SLOT, delivered: false, status: 302 });
});

test('disabled, missing credentials and invalid schedule are distinguishable', async (t) => {
  const mock = harness(t, {});
  await mock.run({ ...ENV, ORION_WATCH_ENABLED: 'false' });
  assert.equal(mock.alerts.length, 0);
  await assert.rejects(mock.run({ ...ENV, GH_DISPATCH_TOKEN: '' }), /dispatch token missing/);
  await assert.rejects(mock.run(ENV, Number.NaN), /scheduled time unavailable/);
  assert.equal(mock.posts.length, 0);
  assert.equal(mock.alerts.length, 1);
});

test('scheduled work is registered with waitUntil and the Worker remains private', async () => {
  const tasks = [];
  worker.scheduled({ scheduledTime: ALARM_TIME }, {}, { waitUntil: (promise) => tasks.push(promise) });
  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.equal(worker.fetch().status, 404);
});
