const DISPATCH_URL =
  "https://api.github.com/repos/jiwoo4292-png/orion-daily-proof/actions/workflows/orion-source-watch.yml/dispatches";

function logStatus(status) {
  console.log(JSON.stringify({ status, time: new Date().toISOString() }));
}

async function signalWorkflow(env) {
  const token =
    typeof env?.GH_DISPATCH_TOKEN === "string"
      ? env.GH_DISPATCH_TOKEN.trim()
      : "";

  if (!token) {
    logStatus(0);
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let status = 0;

    try {
      const response = await fetch(DISPATCH_URL, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "ORION hello@orionbiotechai.com",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({ ref: "main", inputs: { scope: "pilot" } }),
      });

      status = response.status;
      try {
        await response.body?.cancel();
      } catch {
        // Response contents and cancellation errors are deliberately discarded.
      }
    } catch {
      // Network, timeout, and request errors share a numeric-only failure status.
    }

    logStatus(status);
    if (status >= 200 && status < 300) return;
  }
}

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(signalWorkflow(env));
  },

  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
