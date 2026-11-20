import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const PUBLIC_REPO = 'jiwoo4292-png/orion-daily-proof';
const PRIVATE_REPO = 'jiwoo4292-png/orion-snapshots';
const OWNER = 'jiwoo4292-png';
const API = 'https://api.github.com';
const SLOT_MS = 15 * 60_000;
const MAX_AGE_MS = 2 * SLOT_MS;
const MAX_RETAINED_SLOTS = 192;
const MAX_JSON_BYTES = 4_000_000;
const MAX_ENVELOPE_BYTES = 50_000;
const LEDGER_SCHEMA = 'orion-watch-slots/1';
const STATE_SCHEMA = 'orion-watch-state/1';
const RUN_SCHEMA = 'orion-watch-run/1';
const WORK_STEP = 'Run ORION watcher';
const NUMBER = /^[1-9][0-9]*$/;
const UTC_SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45):00\.000Z$/;

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value) {
  return NUMBER.test(String(value)) && Number.isSafeInteger(Number(value));
}

function parseSlot(value) {
  ensure(typeof value === 'string' && UTC_SLOT.test(value), 'INVALID_SLOT');
  const instant = Date.parse(value);
  ensure(Number.isFinite(instant) && new Date(instant).toISOString() === value, 'INVALID_SLOT');
  return instant;
}

export function primarySlot(input, nowMs) {
  const instant = parseSlot(input);
  ensure(instant <= nowMs && nowMs - instant <= MAX_AGE_MS, 'SLOT_OUTSIDE_WINDOW');
  return input;
}

export function backupSlot(schedule, createdAt, nowMs) {
  const minute = /^(7|22|37|52) \* \* \* \*$/.exec(schedule)?.[1];
  const createdMs = Date.parse(createdAt);
  ensure(minute && Number.isFinite(createdMs) && createdMs <= nowMs, 'INVALID_BACKUP_CLOCK');
  const scheduledThisHour = Math.floor(createdMs / 3_600_000) * 3_600_000 + Number(minute) * 60_000;
  const scheduledAt = scheduledThisHour > createdMs ? scheduledThisHour - 3_600_000 : scheduledThisHour;
  return primarySlot(new Date(scheduledAt - 7 * 60_000).toISOString(), nowMs);
}

function apiFor(repository, token, fetchImpl) {
  ensure(typeof token === 'string' && token.length > 0, 'MISSING_CREDENTIAL');
  return async (method, suffix, body) => {
    const response = await fetchImpl(`${API}/repos/${repository}${suffix}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ORION hello@orionbiotechai.com',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    ensure(response.ok, 'GITHUB_REQUEST_FAILED');
    return response.json();
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pack(value) {
  ensure(object(value), 'INVALID_PAYLOAD');
  const bytes = Buffer.from(JSON.stringify(value));
  ensure(bytes.length <= MAX_JSON_BYTES, 'PAYLOAD_TOO_LARGE');
  return {
    codec: 'gzip+base64',
    sha256: digest(bytes),
    data: gzipSync(bytes).toString('base64'),
  };
}

function unpack(value) {
  ensure(value?.codec === 'gzip+base64' && /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.data === 'string' && value.data.length <= MAX_ENVELOPE_BYTES &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.data), 'INVALID_ENCODING');
  const packed = Buffer.from(value.data, 'base64');
  ensure(packed.toString('base64') === value.data, 'INVALID_ENCODING');
  const bytes = gunzipSync(packed, { maxOutputLength: MAX_JSON_BYTES });
  ensure(digest(bytes) === value.sha256, 'PAYLOAD_DIGEST_FAILED');
  const parsed = JSON.parse(bytes.toString('utf8'));
  ensure(object(parsed), 'INVALID_PAYLOAD');
  return parsed;
}

function encode(value) {
  const body = JSON.stringify(value);
  ensure(Buffer.byteLength(body) <= MAX_ENVELOPE_BYTES, 'ISSUE_BODY_TOO_LARGE');
  return body;
}

function decode(body, schema) {
  ensure(typeof body === 'string' && Buffer.byteLength(body) <= MAX_ENVELOPE_BYTES, 'INVALID_ISSUE_BODY');
  const value = JSON.parse(body);
  ensure(object(value) && value.schema === schema, 'INVALID_ISSUE_SCHEMA');
  return value;
}

export function createReceipts(token, fetchImpl = fetch) {
  const request = apiFor(PRIVATE_REPO, token, fetchImpl);
  let verified = false;

  async function verifyRepository() {
    if (verified) return;
    const repository = await request('GET', '');
    ensure(repository.full_name === PRIVATE_REPO && repository.owner?.login === OWNER &&
      repository.private === true && repository.has_issues === true, 'PRIVATE_JOURNAL_REQUIRED');
    verified = true;
  }

  function ownerIssue(issue, number) {
    ensure(issue.number === Number(number) && issue.user?.login === OWNER &&
      !issue.pull_request && issue.state === 'open', 'INVALID_PRIVATE_ISSUE');
  }

  async function read(number, schema) {
    ensure(numeric(number), 'INVALID_PRIVATE_ISSUE');
    await verifyRepository();
    const issue = await request('GET', `/issues/${number}`);
    ownerIssue(issue, number);
    return decode(issue.body, schema);
  }

  async function update(number, expected, next) {
    // The single default-branch workflow serializes all modifications. Other
    // tools and manual edits must leave the two machine-managed issues alone.
    const current = await read(number, expected.schema);
    ensure(JSON.stringify(current) === JSON.stringify(expected), 'PRIVATE_JOURNAL_CONFLICT');
    const body = encode(next);
    const issue = await request('PATCH', `/issues/${number}`, { body });
    ownerIssue(issue, number);
    ensure(issue.body === body, 'PRIVATE_JOURNAL_WRITE_FAILED');
  }

  async function comment(number, value) {
    await verifyRepository();
    ensure(numeric(number), 'INVALID_PRIVATE_ISSUE');
    const body = encode(value);
    const posted = await request('POST', `/issues/${number}/comments`, { body });
    ensure(numeric(posted.id) && posted.user?.login === OWNER && posted.body === body, 'EVIDENCE_WRITE_FAILED');
    return posted.id;
  }

  return { read, update, comment };
}

function sameOwner(left, right) {
  return left.runId === right.runId && left.attempt === right.attempt;
}

function slotRecords(ledger) {
  ensure(object(ledger.slots) && Object.keys(ledger.slots).length <= MAX_RETAINED_SLOTS, 'INVALID_SLOT_LEDGER');
  for (const [slot, record] of Object.entries(ledger.slots)) {
    parseSlot(slot);
    ensure(object(record) && numeric(record.runId) && numeric(record.attempt) &&
      ['claimed', 'completed'].includes(record.status) &&
      (record.status !== 'completed' || numeric(record.evidenceComment)), 'INVALID_SLOT_LEDGER');
  }
  return ledger.slots;
}

export async function hasStarted(request, owner) {
  const run = await request('GET', `/actions/runs/${owner.runId}/attempts/${owner.attempt}/jobs?per_page=50`);
  const jobs = (run.jobs ?? []).filter((job) => job.name === 'watch');
  ensure(jobs.length === 1 && jobs[0].status === 'completed' && Array.isArray(jobs[0].steps),
    'PREVIOUS_RUN_NOT_CONFIRMED');
  const step = jobs[0].steps.find((value) => value.name === WORK_STEP);
  return Boolean(step?.started_at && step.conclusion !== 'skipped');
}

export async function claimSlot({ journal, issue, slot, owner, ran }) {
  parseSlot(slot);
  ensure(numeric(owner.runId) && numeric(owner.attempt), 'INVALID_OWNER');
  const ledger = await journal.read(issue, LEDGER_SCHEMA);
  const priorSlots = slotRecords(ledger);
  const prior = priorSlots[slot];
  if (prior?.status === 'completed') return 'duplicate';
  if (prior && await ran(prior)) return 'already-started';
  const slots = { ...priorSlots, [slot]: { ...owner, status: 'claimed' } };
  const retained = Object.keys(slots).sort().slice(-MAX_RETAINED_SLOTS);
  ensure(retained.includes(slot), 'SLOT_TOO_OLD');
  await journal.update(issue, ledger, {
    schema: LEDGER_SCHEMA,
    slots: Object.fromEntries(retained.map((key) => [key, slots[key]])),
  });
  return 'run';
}

export async function saveEvidence({ journal, issue, slot, owner, result }) {
  const state = await journal.read(issue, STATE_SCHEMA);
  ensure(state.cursor === null || object(state.cursor), 'INVALID_STATE_RECEIPT');
  if (state.slot) ensure(parseSlot(state.slot) <= parseSlot(slot), 'WATCH_STATE_NEWER_THAN_SLOT');
  const next = result.state === null ? state.cursor : pack(result.state);
  const evidence = {
    schema: RUN_SCHEMA,
    slot,
    ...owner,
    status: result.status,
    evidence: pack(result.evidence),
    cursorSha256: next?.sha256 ?? null,
  };
  // Validate both API payload sizes before either write. Failure evidence
  // remains available if the final state acknowledgement fails.
  encode(evidence);
  encode({ schema: STATE_SCHEMA, cursor: next, slot, evidenceComment: Number.MAX_SAFE_INTEGER });
  const evidenceComment = await journal.comment(issue, evidence);
  await journal.update(issue, state, { schema: STATE_SCHEMA, cursor: next, slot, evidenceComment });
  return evidenceComment;
}

export async function completeSlot({ journal, issue, slot, owner, evidenceComment }) {
  const ledger = await journal.read(issue, LEDGER_SCHEMA);
  const claim = slotRecords(ledger)[slot];
  ensure(claim?.status === 'claimed' && sameOwner(claim, owner) && numeric(evidenceComment), 'SLOT_OWNER_CHANGED');
  await journal.update(issue, ledger, {
    schema: LEDGER_SCHEMA,
    slots: { ...ledger.slots, [slot]: { ...claim, status: 'completed', evidenceComment } },
  });
}

export async function pingHealth(url, fetchImpl = fetch) {
  ensure(typeof url === 'string' && /^https:\/\/hc-ping\.com\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url),
    'HEALTHCHECK_URL_REQUIRED');
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000) });
  ensure(response.ok, 'HEALTHCHECK_FAILED');
  await response.body?.cancel();
}

function context(env) {
  ensure(env.GITHUB_REPOSITORY === PUBLIC_REPO && env.GITHUB_REF === 'refs/heads/main' &&
    ['workflow_dispatch', 'schedule'].includes(env.GITHUB_EVENT_NAME) &&
    env.ORION_WATCH_ENABLED === 'true' && env.ORION_WATCH_SLOTS_ENABLED === 'true', 'EXECUTION_NOT_ENABLED');
  const owner = { runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
  ensure(numeric(owner.runId) && numeric(owner.attempt), 'INVALID_OWNER');
  return owner;
}

function readFileJson(file) {
  ensure(statSync(file).size <= MAX_JSON_BYTES, 'LOCAL_RESULT_TOO_LARGE');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function validResult(value) {
  return object(value) && ['success', 'failure'].includes(value.status) && object(value.evidence) &&
    (object(value.state) || value.status === 'failure' && value.state === null);
}

export function runScanner({ env, slot, stateFile, resultFile }) {
  const gitDirectory = path.join(env.GITHUB_WORKSPACE, 'private-watch');
  const result = spawnSync(process.execPath, ['scripts/monitor/source-watch/cli.js'], {
    cwd: gitDirectory,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      ORION_WATCH_SLOT: slot,
      ORION_WATCH_STATE_FILE: stateFile,
      ORION_WATCH_RESULT_FILE: resultFile,
    },
    stdio: 'ignore',
    timeout: 150_000,
  });
  let value;
  try {
    if (existsSync(resultFile)) value = readFileJson(resultFile);
  } catch {
    // The scanner may have been interrupted writing its result.
  }
  if (!validResult(value)) {
    value = { status: 'failure', state: null, evidence: { reason: 'scanner_execution_failed' } };
  }
  if (result.status !== 0 && value.status === 'success') {
    value = { status: 'failure', state: null, evidence: { reason: 'scanner_exit_failed' } };
  }
  writeFileSync(resultFile, JSON.stringify(value), { mode: 0o600 });
}

async function main(command, env = process.env) {
  const owner = context(env);
  const output = (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  if (command === 'identify') {
    const nowMs = Date.now();
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      ensure(env.WATCH_SCOPE === 'pilot', 'SLOTTED_SCOPE_REQUIRED');
      output('slot', primarySlot(env.WATCH_REQUEST_SLOT, nowMs));
    } else {
      const request = apiFor(PUBLIC_REPO, env.WATCH_ACTIONS_TOKEN, fetch);
      const run = await request('GET', `/actions/runs/${owner.runId}`);
      ensure(String(run.id) === owner.runId && run.event === 'schedule', 'BACKUP_RUN_IDENTITY_FAILED');
      output('slot', backupSlot(env.WATCH_BACKUP_SCHEDULE, run.created_at, nowMs));
    }
    return;
  }

  const slot = env.ORION_WATCH_SLOT;
  parseSlot(slot);
  if (command === 'health') {
    await pingHealth(env.ORION_WATCH_HEALTHCHECK_URL);
    return;
  }

  const local = path.join(env.RUNNER_TEMP, `orion-watch-${owner.runId}-${owner.attempt}`);
  const stateFile = path.join(local, 'state.json');
  const resultFile = path.join(local, 'result.json');
  if (command === 'run') {
    runScanner({ env, slot, stateFile, resultFile });
    return;
  }

  const journal = createReceipts(env.ORION_WATCH_SNAPSHOTS_TOKEN);
  const issue = env.ORION_WATCH_SLOT_LEDGER_ISSUE;
  const stateIssue = env.ORION_WATCH_STATE_ISSUE;
  ensure(numeric(issue) && numeric(stateIssue) && issue !== stateIssue, 'DISTINCT_ISSUES_REQUIRED');
  if (command === 'claim') {
    const request = apiFor(PUBLIC_REPO, env.WATCH_ACTIONS_TOKEN, fetch);
    const decision = await claimSlot({ journal, issue, slot, owner, ran: (prior) => hasStarted(request, prior) });
    if (decision === 'already-started') throw new Error('PREVIOUS_RUN_INCOMPLETE');
    output('decision', decision);
  } else if (command === 'prepare') {
    const state = await journal.read(stateIssue, STATE_SCHEMA);
    if (state.slot) ensure(parseSlot(state.slot) <= parseSlot(slot), 'WATCH_STATE_NEWER_THAN_SLOT');
    const cursor = state.cursor === null ? {} : unpack(state.cursor);
    mkdirSync(local, { mode: 0o700 });
    writeFileSync(stateFile, JSON.stringify(cursor), { mode: 0o600 });
  } else if (command === 'persist') {
    const result = readFileJson(resultFile);
    ensure(validResult(result), 'INVALID_SCANNER_OUTCOME');
    const evidenceComment = await saveEvidence({ journal, issue: stateIssue, slot, owner, result });
    ensure(result.status === 'success', 'SCANNER_REPORTED_FAILURE');
    await completeSlot({ journal, issue, slot, owner, evidenceComment });
  } else {
    throw new Error('UNKNOWN_COMMAND');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => {
    // Private response contents, subprocess output and locations stay off
    // the public workflow. The named step identifies the failure boundary.
    process.stdout.write('{"status":"failure"}\n');
    process.exitCode = 1;
  });
}
