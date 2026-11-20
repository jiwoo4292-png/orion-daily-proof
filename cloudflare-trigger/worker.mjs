const REPOSITORY = "https://api.github.com/repos/jiwoo4292-png/orion-daily-proof";
const WORKFLOW = `${REPOSITORY}/actions/workflows/orion-source-watch.yml`;
const WORK_STEP = "Run ORION watcher";
const DUPLICATE_STEP = "Duplicate watcher slot";
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const POLL_INTERVALS_MS = [0, 10000, 15000, 25000, 35000];

function slotFor(scheduledTime) {
  if (!Number.isFinite(scheduledTime)) return null;
  return new Date(Math.floor(scheduledTime / QUARTER_HOUR_MS) * QUARTER_HOUR_MS).toISOString();
}

function log(event, slot, fields = {}) {
  console.log(JSON.stringify({ event, slot, ...fields }));
}

function binding(env, name) {
  return typeof env?.[name] === "string" ? env[name].trim() : "";
}

function isRunId(runId) {
  return Number.isSafeInteger(runId) && runId > 0;
}

async function github(fetchImpl, token, url, body) {
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ORION hello@orionbiotechai.com",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 200) {
      const data = await response.json().catch(() => null);
      return { status: response.status, data };
    }
    await response.body?.cancel().catch(() => {});
    return { status: response.status, data: null };
  } catch {
    return { status: 0, data: null };
  }
}

function started(step) {
  if (!step || !Number.isFinite(Date.parse(step.started_at))) return false;
  return step.status === "in_progress" ||
    (step.status === "completed" && ["success", "failure", "timed_out"].includes(step.conclusion));
}

function observation(data) {
  const job = Array.isArray(data?.jobs) && data.jobs.find((row) => row.name === "watch");
  if (!Array.isArray(job?.steps)) return null;

  const findStep = (name) => job.steps.find((row) => row.name === name);
  const work = findStep(WORK_STEP);
  if (started(work)) return "watcher_started";
  const duplicate = findStep(DUPLICATE_STEP);
  if (duplicate?.status === "completed" && duplicate.conclusion === "success") return "watcher_duplicate_covered";
  return null;
}

async function discover(fetchImpl, token, slot) {
  // A lost POST body can still leave a GitHub run behind. Match only the exact
  // workflow_dispatch run title for this slot. A nearby manually run job or the
  // prior time slot is never proof.
  const earliest = new Date(Date.parse(slot) - QUARTER_HOUR_MS).toISOString();
  const query = new URLSearchParams({
    branch: "main", event: "workflow_dispatch", per_page: "15", created: `>=${earliest}`,
  });
  const { data } = await github(fetchImpl, token, `${WORKFLOW}/runs?${query}`);
  if (!Array.isArray(data?.workflow_runs)) return [];
  return data.workflow_runs
    .filter((run) => run.display_title === `ORION watcher ${slot}` && isRunId(run.id))
    .slice(0, 3)
    .map((run) => run.id);
}

async function alertWoo(fetchImpl, env, slot, attempts) {
  const secret = binding(env, "ORION_WATCH_ALERT_WEBHOOK");
  try {
    const url = new URL(secret);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `ORION watcher 시작 미확인 · UTC ${slot} · dispatch ${attempts}회` }),
    });
    await response.body?.cancel().catch(() => {});
    log("watcher_alert", slot, { delivered: response.ok, status: response.status });
  } catch {
    log("watcher_alert", slot, { delivered: false, status: 0 });
  }
}

async function runAlarm(scheduledTime, env, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (binding(env, "ORION_WATCH_ENABLED") !== "true") return;
  const slot = slotFor(scheduledTime);
  if (!slot) throw new Error("ORION watcher scheduled time unavailable");
  const token = binding(env, "GH_DISPATCH_TOKEN");
  if (!token) {
    await alertWoo(fetchImpl, env, slot, 0);
    throw new Error("ORION watcher dispatch token missing");
  }

  const runs = new Set();
  let mayHaveHiddenRun = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { status, data } = await github(fetchImpl, token, `${WORKFLOW}/dispatches`, {
      ref: "main", inputs: { scope: "pilot", slot },
    });
    const runId = data?.workflow_run_id;
    if (isRunId(runId)) runs.add(runId);
    else if (status === 0 || status >= 500 || (status >= 200 && status < 300)) mayHaveHiddenRun = true;
    log("watcher_dispatch", slot, { attempt, status, ...(isRunId(runId) ? { runId } : {}) });

    if (!runs.size && !mayHaveHiddenRun) continue;
    for (const interval of POLL_INTERVALS_MS) {
      if (interval) await sleep(interval);
      if (mayHaveHiddenRun) {
        for (const id of await discover(fetchImpl, token, slot)) {
          if (runs.size < 3) runs.add(id);
        }
      }
      const outcomes = await Promise.all([...runs].map(async (id) => {
        const { data: jobs } = await github(fetchImpl, token, `${REPOSITORY}/actions/runs/${id}/jobs?filter=latest`);
        return { runId: id, event: observation(jobs) };
      }));
      const confirmed = outcomes.find((outcome) => outcome.event === "watcher_started") ||
        outcomes.find((outcome) => outcome.event);
      if (confirmed) {
        log(confirmed.event, slot, { attempt, runId: confirmed.runId });
        return;
      }
    }
  }

  await alertWoo(fetchImpl, env, slot, 2);
  throw new Error("ORION watcher start unconfirmed after retry");
}

export { runAlarm };

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runAlarm(controller.scheduledTime, env));
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
