import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backupSlot, claimSlot, completeSlot, createReceipts, hasStarted, pingHealth, primarySlot, runScanner, saveEvidence,
} from '../scripts/orion-watch-slot.mjs';

const slot = '2026-11-22T12:15:00.000Z';
const at = (value) => Date.parse(value);
const primary = { runId: '101', attempt: '1' };
const backup = { runId: '102', attempt: '1' };
const ownerLogin = 'jiwoo4292-png';
const issues = { slot: '10', state: '11' };

function memoryJournal() {
  const entries = new Map([
    [issues.slot, { schema: 'orion-watch-slots/1', slots: {} }],
    [issues.state, { schema: 'orion-watch-state/1', cursor: null }],
  ]);
  const comments = [];
  return {
    comments,
    read: async (number) => structuredClone(entries.get(number)),
    update: async (number, expected, next) => {
      assert.deepEqual(entries.get(number), expected);
      entries.set(number, structuredClone(next));
    },
    comment: async (number, value) => {
      assert.equal(number, issues.state);
      comments.push(value);
      return comments.length;
    },
  };
}

function claim(journal, owner, ran = async () => false) {
  return claimSlot({ journal, issue: issues.slot, slot, owner, ran });
}

test('primary and a queue-delayed backup correlate to the same slot across boundaries', () => {
  assert.equal(primarySlot(slot, at('2026-11-22T12:17:00Z')), slot);
  assert.equal(backupSlot('22 * * * *', '2026-11-22T12:40:08Z', at('2026-11-22T12:41:00Z')), slot);
  const midnight = backupSlot('52 * * * *', '2026-11-23T00:02:01Z', at('2026-11-23T00:03:00Z'));
  assert.equal(midnight, '2026-11-22T23:45:00.000Z');
  assert.throws(() => backupSlot('22 * * * *', '2026-11-22T12:23:00Z', at('2026-11-22T12:46:00Z')), /SLOT_OUTSIDE_WINDOW/);
  assert.throws(() => primarySlot('2026-02-30T12:15:00.000Z', at('2026-11-22T12:17:00Z')), /INVALID_SLOT/);
});

test('backup can take a slot if the primary never started the watcher', async () => {
  const journal = memoryJournal();
  assert.equal(await claim(journal, primary), 'run');
  const noStart = async (prior) => {
    assert.deepEqual(prior, { ...primary, status: 'claimed' });
    return false;
  };
  assert.equal(await claim(journal, backup, noStart), 'run');
  await assert.rejects(completeSlot({ journal, issue: issues.slot, slot, owner: primary, evidenceComment: 1 }),
    /SLOT_OWNER_CHANGED/);
});

test('backup is the sole watcher when the Cloudflare dispatcher never arrived', async () => {
  const journal = memoryJournal();
  assert.equal(await claim(journal, backup), 'run');
  const result = { status: 'success', state: {}, evidence: { examined: 0 } };
  const evidenceComment = await saveEvidence({ journal, issue: issues.state, slot, owner: backup, result });
  await completeSlot({ journal, issue: issues.slot, slot, owner: backup, evidenceComment });
  assert.equal(await claim(journal, primary), 'duplicate');
  assert.equal(journal.comments.length, 1);
});

test('a later alarm cannot repeat successful or started-but-incomplete watcher work', async () => {
  const journal = memoryJournal();
  assert.equal(await claim(journal, primary), 'run');
  assert.equal(await claim(journal, backup, async () => true), 'already-started');
  const result = { status: 'success', state: { checked: 1 }, evidence: { audits: [1] } };
  const evidenceComment = await saveEvidence({ journal, issue: issues.state, slot, owner: primary, result });
  await completeSlot({ journal, issue: issues.slot, slot, owner: primary, evidenceComment });
  assert.equal(await claim(journal, backup, async () => assert.fail('already complete')), 'duplicate');
  assert.equal(journal.comments.length, 1);
});

test('a failed scan retains private evidence without completing the slot', async () => {
  const journal = memoryJournal();
  await claim(journal, primary);
  const result = { status: 'failure', state: null, evidence: { reason: 'test-only' } };
  const evidenceComment = await saveEvidence({ journal, issue: issues.state, slot, owner: primary, result });
  assert.equal(evidenceComment, 1);
  assert.equal(journal.comments[0].status, 'failure');
  assert.equal((await journal.read(issues.state)).cursor, null);
  assert.equal((await journal.read(issues.slot)).slots[slot].status, 'claimed');
});

test('prior run confirmation ignores synthetic started_at on skipped work', async () => {
  const checked = (step) => async (method, url) => {
    assert.equal(method, 'GET');
    assert.equal(url, '/actions/runs/101/attempts/1/jobs?per_page=50');
    return { jobs: [{ name: 'watch', status: 'completed', steps: [{ name: 'Run ORION watcher', ...step }] }] };
  };
  assert.equal(await hasStarted(checked({ started_at: slot, conclusion: 'skipped' }), primary), false);
  assert.equal(await hasStarted(checked({ started_at: slot, conclusion: 'failure' }), primary), true);
  await assert.rejects(hasStarted(async () => ({ jobs: [] }), primary), /PREVIOUS_RUN_NOT_CONFIRMED/);
});

test('receipt writes verify the target is the private snapshots repo and the issue is owner-created', async () => {
  const requestLog = [];
  const api = (privateRepository, issueOwner) => async (url, options) => {
    const parsed = new URL(url);
    requestLog.push([parsed.pathname, options.method]);
    if (parsed.pathname.endsWith('/orion-snapshots')) {
      return Response.json({ private: privateRepository, owner: { login: ownerLogin },
        full_name: 'jiwoo4292-png/orion-snapshots', has_issues: true });
    }
    return Response.json({ number: 10, user: { login: issueOwner }, state: 'open',
      body: '{"schema":"orion-watch-slots/1","slots":{}}' });
  };
  await assert.rejects(createReceipts('fixture-token', api(false, ownerLogin))
    .read(issues.slot, 'orion-watch-slots/1'), /PRIVATE_JOURNAL_REQUIRED/);
  await assert.rejects(createReceipts('fixture-token', api(true, 'different-owner'))
    .read(issues.slot, 'orion-watch-slots/1'), /INVALID_PRIVATE_ISSUE/);
  assert.ok(requestLog.every(([, method]) => method === 'GET'));
});

test('heartbeat accepts only a success endpoint and sends no body or authorization', async () => {
  const base = 'https://hc-ping.com/b2ae173d-2c42-4508-9f24-2ecf48592a6b';
  let calls = 0;
  const fetchMock = async (url, options) => {
    assert.equal(url, base);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    assert.equal(options.body, undefined);
    calls += 1;
    return new Response('OK');
  };
  await assert.rejects(pingHealth(base + '/start', fetchMock), /HEALTHCHECK_URL_REQUIRED/);
  await assert.rejects(pingHealth('https://example.net/ping', fetchMock), /HEALTHCHECK_URL_REQUIRED/);
  await pingHealth(base, fetchMock);
  assert.equal(calls, 1);
});

test('private scanner subprocess receives only its state contract and retains failure evidence', (t) => {
  const tempRoot = path.resolve(tmpdir());
  const base = mkdtempSync(path.join(tempRoot, 'orion-watch-slot-test-'));
  assert.match(path.relative(tempRoot, base), /^orion-watch-slot-test-[a-z0-9]+$/i);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'private-watch', 'scripts', 'monitor', 'source-watch');
  mkdirSync(directory, { recursive: true });
  const scanner = path.join(directory, 'cli.js');
  const stateFile = path.join(base, 'state.json');
  const resultFile = path.join(base, 'result.json');
  writeFileSync(stateFile, '{"prior":2}');
  writeFileSync(scanner, `
    const { readFileSync, writeFileSync } = require('node:fs');
    const state = JSON.parse(readFileSync(process.env.ORION_WATCH_STATE_FILE, 'utf8'));
    const sawSecret = ['ORION_WATCH_SNAPSHOTS_TOKEN', 'ORION_WATCH_HEALTHCHECK_URL']
      .some(key => process.env[key] !== undefined);
    writeFileSync(process.env.ORION_WATCH_RESULT_FILE, JSON.stringify({
      status:'failure', state, evidence:{ slot:process.env.ORION_WATCH_SLOT, sawSecret }
    }));
    console.log('untrusted fixture output');
    process.exitCode = 1;
  `);
  const env = {
    ...process.env, GITHUB_WORKSPACE: base,
    ORION_WATCH_SNAPSHOTS_TOKEN: 'fixture-secret', ORION_WATCH_HEALTHCHECK_URL: 'fixture-secret',
  };
  runScanner({ env, slot, stateFile, resultFile });
  assert.deepEqual(JSON.parse(readFileSync(resultFile)), {
    status: 'failure', state: { prior: 2 }, evidence: { slot, sawSecret: false },
  });
});
