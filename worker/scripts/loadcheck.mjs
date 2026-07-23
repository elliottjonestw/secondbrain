#!/usr/bin/env node
/**
 * A load sanity-check, not a benchmark.
 *
 * The question it answers is the one that matters on this stack: does a normal
 * request stay comfortably inside the free plan's **10 ms CPU cap**, and does
 * latency hold up when several requests arrive at once? It is not trying to
 * find a throughput ceiling — finding one would mean spending the 100k
 * requests/day budget to learn a number nobody will act on.
 *
 * Latency here is wall-clock, which on this stack is dominated by D1
 * round-trips (~105 ms each, measured), not by CPU. That is exactly why the
 * useful signal is the *shape*: an endpoint that costs three queries should sit
 * near three times one that costs one, and anything much worse is an N+1 or a
 * missing index — the failure mode that quietly burns the "rows scanned" quota.
 *
 * Usage:
 *   node worker/scripts/loadcheck.mjs                      # local wrangler dev
 *   node worker/scripts/loadcheck.mjs https://host [token]
 *
 * With no token it exercises only unauthenticated paths. Pass an access token
 * (from the app's network tab, or a register call) to include a space read.
 * Run it against STAGING, never production: it registers throwaway accounts.
 */

const BASE = process.argv[2] ?? "http://localhost:8787";
const TOKEN = process.argv[3] ?? null;

/** Deliberately small. This is a sanity check on a free plan, and hammering
 *  our own quota to produce a prettier percentile is self-defeating. */
const ROUNDS = 20;
const CONCURRENCY = 5;

async function timed(fn) {
  const t0 = performance.now();
  let status = 0;
  try {
    status = await fn();
  } catch {
    status = -1;
  }
  return { ms: performance.now() - t0, status };
}

function stats(samples) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  const bad = samples.filter((s) => s.status < 200 || s.status >= 400).length;
  return {
    n: ms.length,
    p50: at(50).toFixed(0),
    p95: at(95).toFixed(0),
    max: ms[ms.length - 1].toFixed(0),
    errors: bad,
  };
}

async function run(name, fn) {
  const samples = [];
  for (let i = 0; i < ROUNDS; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, ROUNDS - i) }, () => timed(fn));
    samples.push(...(await Promise.all(batch)));
  }
  const s = stats(samples);
  console.log(
    `${name.padEnd(28)} n=${s.n}  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  errors=${s.errors}`,
  );
  return s;
}

const json = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.status);

console.log(`Load sanity-check against ${BASE}\n`);

// No database work at all: the floor everything else is measured against.
await run("GET /v1/health", () => fetch(`${BASE}/v1/health`).then((r) => r.status));

// One indexed read on `users`, plus an HMAC. The cheapest realistic D1 request,
// so the gap between this and /health is one round-trip to the primary.
await run("POST /v1/auth/kdf", () =>
  json("/v1/auth/kdf", { email: `loadcheck-${Math.random().toString(36).slice(2)}@example.com` }),
);

if (TOKEN) {
  const me = await fetch(`${BASE}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!me.ok) {
    console.error(`\nToken rejected (${me.status}); skipping authenticated checks.`);
    process.exit(1);
  }
  const { spaces } = await me.json();
  const spaceId = spaces[0]?.space_id;

  // Two queries: the membership check in authorize(), then the read itself.
  // Should land near twice the /auth/kdf figure. Much more than that means the
  // handler is issuing queries it doesn't need.
  await run("GET /v1/auth/me", () =>
    fetch(`${BASE}/v1/auth/me`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(
      (r) => r.status,
    ),
  );
  if (spaceId) {
    await run("GET .../todos", () =>
      fetch(`${BASE}/v1/spaces/${spaceId}/todos?limit=25`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }).then((r) => r.status),
    );
  }
} else {
  console.log("\n(no token given — authenticated endpoints skipped)");
}

console.log(
  "\nWhat to look for: p95 within roughly 2x p50, and each endpoint's cost\n" +
    "proportional to the number of D1 queries it makes. A flat p50 with a wild\n" +
    "max is normal (cold isolate); a rising p50 across rounds is not.",
);
