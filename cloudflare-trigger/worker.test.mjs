import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspect } from "node:util";
import worker from "./worker.mjs";

// A synthetic test value. Assertions never include credential-bearing values.
const CANARY = "unit-test-canary";
const DISPATCH_URL =
  "https://api.github.com/repos/jiwoo4292-png/orion-daily-proof/actions/workflows/orion-source-watch.yml/dispatches";

function response(status, onCancel = async () => {}) {
  return {
    status,
    headers: new Headers({ "x-test-private": CANARY }),
    body: { cancel: onCancel },
    async text() {
      throw new Error(CANARY);
    },
    async json() {
      throw new Error(CANARY);
    },
  };
}

function harness(t, respond = async () => response(204)) {
  const requests = [];
  const output = [];

  t.mock.method(globalThis, "fetch", async (...args) => {
    requests.push(args);
    return respond(...args);
  });

  for (const method of [
    "log", "error", "warn", "info", "debug", "dir", "trace", "assert", "table",
  ]) {
    t.mock.method(console, method, (...args) => {
      output.push({ method, args });
    });
  }

  return { requests, output };
}

function schedule(env = { GH_DISPATCH_TOKEN: CANARY }) {
  const pending = [];
  worker.scheduled(
    { cron: "11,41 * * * *", scheduledTime: Date.now() },
    env,
    { waitUntil: (promise) => pending.push(promise) },
  );
  assert.ok(pending.length === 1, "scheduled must register exactly one task");
  assert.ok(
    typeof pending[0]?.then === "function",
    "waitUntil must receive the dispatch promise",
  );
  return pending[0];
}

async function resolvesQuietly(promise) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert.ok(!rejected, "dispatch failures must resolve without leaking exceptions");
}

function assertLogs(output, expectedStatuses) {
  assert.ok(
    output.length === expectedStatuses.length,
    "only one application log per attempted request is allowed",
  );
  assert.ok(
    !inspect(output, { depth: null }).includes(CANARY),
    "application output must not contain synthetic credentials or response/error data",
  );

  for (const [index, entry] of output.entries()) {
    assert.ok(entry.method === "log", "only numeric status logs are allowed");
    assert.ok(
      entry.args.length === 1 && typeof entry.args[0] === "string",
      "each log must be a single JSON string",
    );
    let parsed;
    try {
      parsed = JSON.parse(entry.args[0]);
    } catch {
      parsed = null;
    }
    assert.ok(parsed && typeof parsed === "object", "status log must be valid JSON");
    assert.ok(
      Object.keys(parsed).sort().join(",") === "status,time",
      "status logs must contain exactly status and time",
    );
    assert.ok(
      typeof parsed.status === "number" && parsed.status === expectedStatuses[index],
      "status must be the expected numeric HTTP status or zero",
    );
    assert.ok(
      typeof parsed.time === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.time) &&
        Number.isFinite(Date.parse(parsed.time)),
      "time must be an ISO UTC timestamp",
    );
  }
}

test("HTTP routes never dispatch, including authenticated POST requests", async (t) => {
  const { requests, output } = harness(t);
  let registeredTasks = 0;
  for (const method of ["GET", "POST", "HEAD"]) {
    const result = await worker.fetch(
      new Request("https://trigger.invalid/__scheduled?cron=anything", {
        method,
        headers: { Authorization: `Bearer ${CANARY}` },
      }),
      { GH_DISPATCH_TOKEN: CANARY },
      { waitUntil: () => { registeredTasks += 1; } },
    );
    assert.ok(result.status === 404, "every HTTP request must receive static 404");
  }
  assert.ok(requests.length === 0, "HTTP requests must not call GitHub");
  assert.ok(registeredTasks === 0, "HTTP requests must not register background work");
  assertLogs(output, []);
});

test("waitUntil tracks the still-pending GitHub request", async (t) => {
  let completeRequest;
  const request = new Promise((resolve) => { completeRequest = resolve; });
  const { requests, output } = harness(t, () => request);
  const pending = schedule();
  let completed = false;
  pending.then(() => { completed = true; });

  await Promise.resolve();
  assert.ok(requests.length === 1, "scheduled must start the GitHub request");
  assert.ok(!completed, "waitUntil must keep the actual request alive");
  assertLogs(output, []);

  completeRequest(response(204));
  await resolvesQuietly(pending);
  assert.ok(completed, "registered work must settle after the request settles");
  assertLogs(output, [204]);
});

test("dispatch uses the fixed endpoint, main pilot payload, and required headers", async (t) => {
  const { requests, output } = harness(t, async () => response(200));
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 1, "successful dispatch must not be repeated");

  const [url, options] = requests[0];
  const headers = new Headers(options.headers);
  assert.ok(url === DISPATCH_URL, "dispatch target must remain fixed");
  assert.ok(options.method === "POST", "dispatch must use POST");
  assert.ok(options.redirect === "manual", "redirects must not forward credentials");
  assert.ok(options.signal instanceof AbortSignal, "requests need an abort signal");
  assert.ok(!options.signal.aborted, "the request signal must initially be usable");
  assert.ok(
    headers.get("Authorization") === `Bearer ${CANARY}`,
    "the bound secret must be used only as Bearer authentication",
  );
  assert.ok(
    headers.get("Accept") === "application/vnd.github+json" &&
      headers.get("Content-Type") === "application/json" &&
      headers.get("User-Agent") === "ORION hello@orionbiotechai.com" &&
      headers.get("X-GitHub-Api-Version") === "2026-03-10",
    "GitHub request headers must match the documented contract",
  );
  let body;
  try {
    body = JSON.parse(options.body);
  } catch {
    body = null;
  }
  assert.ok(
    body?.ref === "main" && body?.inputs?.scope === "pilot" &&
      Object.keys(body).sort().join(",") === "inputs,ref" &&
      Object.keys(body.inputs).join(",") === "scope",
    "only the fixed main/pilot dispatch payload is permitted",
  );
  assertLogs(output, [200]);
});

for (const status of [201, 202, 204, 299]) {
  test(`HTTP ${status} is terminal success`, async (t) => {
    const { requests, output } = harness(t, async () => response(status));
    await resolvesQuietly(schedule());
    assert.ok(requests.length === 1, "all 2xx responses must stop retries");
    assertLogs(output, [status]);
  });
}

for (const status of [301, 400, 401, 403, 429, 500, 503]) {
  test(`HTTP ${status} retries once and then stops on success`, async (t) => {
    let attempt = 0;
    const { requests, output } = harness(t, async () => {
      attempt += 1;
      return response(attempt === 1 ? status : 204);
    });
    await resolvesQuietly(schedule());
    assert.ok(requests.length === 2, "a non-2xx response must get exactly one retry");
    assertLogs(output, [status, 204]);
  });
}

test("repeated HTTP failures are bounded to two requests and resolve", async (t) => {
  const { requests, output } = harness(t, async () => response(503));
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 2, "repeated failures must not cause unbounded retries");
  assertLogs(output, [503, 503]);
});

test("network exceptions containing synthetic credentials become status zero", async (t) => {
  const { requests, output } = harness(t, async () => { throw new Error(CANARY); });
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 2, "network errors must get only one retry");
  assertLogs(output, [0, 0]);
});

test("response bodies and headers containing synthetic credentials stay private", async (t) => {
  const { requests, output } = harness(t, async () => new Response(CANARY, {
    status: 200,
    headers: { "x-test-private": CANARY },
  }));
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 1, "a response with private data still stops on success");
  assertLogs(output, [200]);
});

test("a network failure may recover on its single retry", async (t) => {
  let attempt = 0;
  const { requests, output } = harness(t, async () => {
    attempt += 1;
    if (attempt === 1) throw new Error(CANARY);
    return response(200);
  });
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 2, "network recovery must remain bounded");
  assertLogs(output, [0, 200]);
});

test("each attempt has a fresh ten-second timeout and timeout failures resolve", async (t) => {
  const durations = [];
  const signals = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    durations.push(milliseconds);
    const controller = new AbortController();
    signals.push(controller.signal);
    queueMicrotask(() => {
      controller.abort(new DOMException(CANARY, "TimeoutError"));
    });
    return controller.signal;
  });
  const { requests, output } = harness(t, (_url, options) => new Promise((resolve, reject) => {
    const fail = () => reject(options.signal.reason);
    if (options.signal.aborted) fail();
    else options.signal.addEventListener("abort", fail, { once: true });
  }));

  await resolvesQuietly(schedule());
  assert.ok(requests.length === 2, "timeouts must get only one retry");
  assert.ok(
    durations.length === 2 && durations.every((value) => value === 10_000),
    "each attempt must have its own bounded ten-second timeout",
  );
  assert.ok(
    signals[0] instanceof AbortSignal && signals[1] instanceof AbortSignal &&
      signals[0] !== signals[1] && signals.every((signal) => signal.aborted),
    "retry must use a fresh abort signal rather than an already expired one",
  );
  assertLogs(output, [0, 0]);
});

test("missing, invalid, and blank secrets never send a request", async (t) => {
  const { requests, output } = harness(t);
  const environments = [
    undefined, null, {}, { GH_DISPATCH_TOKEN: null },
    { GH_DISPATCH_TOKEN: 123 }, { GH_DISPATCH_TOKEN: "" },
    { GH_DISPATCH_TOKEN: " \t\n " },
  ];
  for (const env of environments) {
    // Pass undefined explicitly without invoking schedule's valid fixture default.
    const pending = [];
    worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
    assert.ok(pending.length === 1, "missing-secret results must still be tracked");
    await resolvesQuietly(pending[0]);
    assertLogs(output, [0]);
    output.length = 0;
  }
  assert.ok(requests.length === 0, "invalid secrets must fail closed before fetch");
});

test("surrounding secret whitespace is removed without logging it", async (t) => {
  const { requests, output } = harness(t);
  await resolvesQuietly(schedule({ GH_DISPATCH_TOKEN: ` \t${CANARY}\n` }));
  assert.ok(requests.length === 1, "a valid trimmed secret permits dispatch");
  assert.ok(
    new Headers(requests[0][1].headers).get("Authorization") === `Bearer ${CANARY}`,
    "only surrounding whitespace should be removed",
  );
  assertLogs(output, [204]);
});

test("discarding a response body cannot leak an error or repeat a success", async (t) => {
  const { requests, output } = harness(t, async () => response(200, async () => {
    throw new Error(CANARY);
  }));
  await resolvesQuietly(schedule());
  assert.ok(requests.length === 1, "body cleanup errors must not retry accepted dispatches");
  assertLogs(output, [200]);
});

test("deployment config declares the requested cron without plaintext secrets", async () => {
  const config = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");
  // Inspect the relevant JSONC fields without assuming comments are invalid JSON.
  assert.ok(
    /"crons"\s*:\s*\[\s*"11,41 \* \* \* \*"\s*\]/.test(config),
    "the deployment cron must be at UTC minutes 11 and 41",
  );
  assert.ok(
    !/"(?:GH_DISPATCH_TOKEN|vars)"\s*:/.test(config),
    "secret values must not be configured as plaintext variables",
  );
});
