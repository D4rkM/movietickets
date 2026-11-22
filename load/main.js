// k6 load test for the local movietickets stack. See load/README.md and
// docs/flows/load-test/spec.md. Not a CI job; run against http://localhost:3000.
//
// Never calls payment endpoints (POST /bookings/:id/payments, /payments/webhook,
// GET /bookings/:id/payment-summary): bookings are confirmed with the mocked
// POST /bookings/:id/confirm and cancelled without an approved payment, so the
// refund flow never reaches Mercado Pago.
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";
import exec from "k6/execution";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SMOKE = __ENV.SMOKE === "1";
const VUS = Math.max(1, parseInt(__ENV.VUS || "10", 10));
const DURATION = __ENV.DURATION || "30s";
const CANCEL_ITERATIONS = Math.max(1, parseInt(__ENV.CANCEL_ITERATIONS || "3", 10));
const ALL_SCENARIOS = ["browse", "seat_contention", "booking_cancel"];
const SELECTED = SMOKE
  ? ["browse"]
  : (__ENV.SCENARIOS || ALL_SCENARIOS.join(","))
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

for (const name of SELECTED) {
  if (!ALL_SCENARIOS.includes(name)) {
    throw new Error(`Unknown scenario "${name}". Valid: ${ALL_SCENARIOS.join(", ")}`);
  }
}

const SEEDED_EMAIL = "cliente@movietickets.dev";
const SEEDED_PASSWORD = "password123";
const THROWAWAY_PASSWORD = "loadtest-password-123";
// Sessions starting sooner than this are skipped by the write scenarios: the
// API only allows cancelling until 120 min before the session starts.
const MIN_SESSION_LEAD_MS = 3 * 60 * 60 * 1000;
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// Contention correctness counters (AC1 in the spec).
const holdWon = new Counter("contention_hold_won");
const holdConflict = new Counter("contention_hold_conflict");
const holdUnexpected = new Counter("contention_hold_unexpected");
// Booking flow counters.
const bookingCycleOk = new Counter("booking_cycle_ok");
const bookingCycleFailed = new Counter("booking_cycle_failed");

function buildScenarios() {
  const scenarios = {};
  if (SELECTED.includes("browse")) {
    scenarios.browse = SMOKE
      ? { executor: "shared-iterations", vus: 1, iterations: 1, exec: "browse" }
      : { executor: "constant-vus", vus: Math.min(VUS, 10), duration: DURATION, exec: "browse" };
  }
  if (SELECTED.includes("seat_contention")) {
    // Every VU runs exactly one iteration, all starting together, so they race for one seat.
    scenarios.seat_contention = {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "1m",
      exec: "seatContention",
    };
  }
  if (SELECTED.includes("booking_cancel")) {
    scenarios.booking_cancel = {
      executor: "per-vu-iterations",
      vus: Math.min(VUS, 3),
      iterations: CANCEL_ITERATIONS,
      maxDuration: "2m",
      exec: "bookingCancel",
    };
  }
  return scenarios;
}

function buildThresholds() {
  const thresholds = {
    // Only unexpected statuses count as failures (see expected() below).
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
    checks: ["rate>0.99"],
  };
  if (SELECTED.includes("seat_contention")) {
    // AC1: exactly one winner, everyone else got 409, nothing unexpected.
    thresholds.contention_hold_won = ["count==1"];
    thresholds.contention_hold_unexpected = ["count==0"];
    thresholds.contention_hold_conflict = [`count==${VUS - 1}`];
  }
  if (SELECTED.includes("booking_cancel")) {
    thresholds.booking_cycle_failed = ["count==0"];
  }
  return thresholds;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: buildThresholds(),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "max"],
};

// ---------------------------------------------------------------- helpers

/** Per-request status expectation, so only unexpected statuses count in http_req_failed. */
function expected(...statuses) {
  return http.expectedStatuses(...statuses);
}

function params(name, token, ...statuses) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { headers, tags: { name }, responseCallback: expected(...statuses) };
}

// Requests without a body must not declare Content-Type: application/json,
// otherwise Fastify rejects them with 400 (empty JSON body).
function paramsNoBody(name, token, ...statuses) {
  const p = params(name, token, ...statuses);
  delete p.headers["Content-Type"];
  return p;
}

function login(email, password) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    params("POST /auth/login", null, 200, 401),
  );
  if (res.status !== 200) return null;
  return res.json("accessToken");
}

function registerAndLogin(index, label) {
  const email = `load-${RUN_ID}-${label}-${index}@loadtest.local`;
  const res = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ name: `Load ${label} ${index}`, email, password: THROWAWAY_PASSWORD }),
    params("POST /auth/register", null, 201),
  );
  if (res.status !== 201) fail(`register failed for ${email}: status ${res.status}`);
  const token = login(email, THROWAWAY_PASSWORD);
  if (!token) fail(`login failed for ${email}`);
  return { email, token };
}

function listSessions() {
  const res = http.get(`${BASE_URL}/movies`, params("GET /movies", null, 200));
  if (res.status !== 200) fail(`GET /movies failed: status ${res.status}`);
  const sessions = [];
  for (const movie of res.json()) {
    for (const session of movie.sessions) sessions.push(session);
  }
  return sessions;
}

function getSeatMap(sessionId, token) {
  return http.get(`${BASE_URL}/sessions/${sessionId}/seats`, params("GET /sessions/:id/seats", token, 200));
}

/** First session far enough in the future for a booking to stay cancellable. */
function pickWritableSession(sessions, token) {
  const minStart = Date.now() + MIN_SESSION_LEAD_MS;
  const candidates = sessions
    .filter((session) => new Date(session.startsAt).getTime() > minStart)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  for (const session of candidates) {
    const res = getSeatMap(session.id, token);
    if (res.status !== 200) continue;
    const freeSeats = res.json("seats").filter((seat) => seat.status === "free");
    if (freeSeats.length >= 1) return { sessionId: session.id, freeSeatIds: freeSeats.map((seat) => seat.id) };
  }
  return null;
}

function holdSeat(sessionId, seatId, token) {
  return http.post(
    `${BASE_URL}/sessions/${sessionId}/seats/${seatId}/hold`,
    null,
    paramsNoBody("POST /sessions/:id/seats/:seatId/hold", token, 200, 409),
  );
}

function releaseSeat(sessionId, seatId, token) {
  return http.del(
    `${BASE_URL}/sessions/${sessionId}/seats/${seatId}/hold`,
    null,
    paramsNoBody("DELETE /sessions/:id/seats/:seatId/hold", token, 200),
  );
}

// ------------------------------------------------------------------ setup

export function setup() {
  const needsWrites = SELECTED.includes("seat_contention") || SELECTED.includes("booking_cancel");
  const data = { browseToken: null, sessionId: null, contention: null, cancel: null };

  // Read-only login with the seeded customer (no writes); catalog-only if it fails.
  data.browseToken = login(SEEDED_EMAIL, SEEDED_PASSWORD);
  if (!data.browseToken) {
    console.warn(`Seeded login (${SEEDED_EMAIL}) failed: browse will skip the seat map. Run "make seed".`);
  }

  const sessions = listSessions();
  if (sessions.length === 0) fail("Catalog is empty: run `make seed` first.");
  data.sessions = sessions.map((session) => session.id);

  if (!needsWrites) return data;

  // booking_cancel handles a 404 on the mocked confirm route itself (no safe probe exists).
  const picked = pickWritableSession(sessions, data.browseToken);
  if (!picked) {
    console.warn(
      "No session starting more than 3h from now with free seats: write scenarios will be skipped.",
    );
    return data;
  }
  data.sessionId = picked.sessionId;
  const seatIds = picked.freeSeatIds;

  if (SELECTED.includes("seat_contention")) {
    const users = [];
    for (let i = 0; i < VUS; i++) users.push(registerAndLogin(i, "c"));
    // Last free seat of the session: stays away from the seats booking_cancel uses.
    data.contention = { seatId: seatIds[seatIds.length - 1], tokens: users.map((user) => user.token) };
  }

  if (SELECTED.includes("booking_cancel")) {
    const cancelVus = Math.min(VUS, 3);
    const needed = cancelVus * CANCEL_ITERATIONS;
    const available = seatIds.slice(0, Math.max(0, seatIds.length - 1));
    if (available.length < needed) {
      console.warn(`Only ${available.length} free seats, need ${needed}: booking_cancel will be skipped.`);
    } else {
      const users = [];
      for (let i = 0; i < cancelVus; i++) users.push(registerAndLogin(i, "b"));
      data.cancel = { seatIds: available.slice(0, needed), tokens: users.map((user) => user.token) };
    }
  }
  return data;
}

// -------------------------------------------------------------- scenarios

export function browse(data) {
  const movies = http.get(`${BASE_URL}/movies`, params("GET /movies", null, 200));
  check(movies, { "GET /movies is 200": (res) => res.status === 200 });
  if (data.browseToken && data.sessions.length > 0) {
    const sessionId = data.sessions[Math.floor(Math.random() * data.sessions.length)];
    const map = getSeatMap(sessionId, data.browseToken);
    check(map, { "GET /sessions/:id/seats is 200": (res) => res.status === 200 });
  }
  sleep(1);
}

export function seatContention(data) {
  if (!data.contention) {
    console.warn("seat_contention skipped: no writable session/seat (see setup warnings).");
    return;
  }
  const { seatId, tokens } = data.contention;
  // iterationInTest is unique per iteration inside the scenario, so each VU gets its own user
  // (__VU is global across scenarios and could map two VUs to the same user, which would
  // count as a second "winner" because re-holding your own seat is a 200 TTL refresh).
  const token = tokens[exec.scenario.iterationInTest % tokens.length];
  const res = holdSeat(data.sessionId, seatId, token);
  if (res.status === 200) {
    holdWon.add(1);
  } else if (res.status === 409) {
    holdConflict.add(1);
  } else {
    holdUnexpected.add(1);
  }
  check(res, { "hold answers 200 or 409": (r) => r.status === 200 || r.status === 409 });
}

export function bookingCancel(data) {
  if (!data.cancel) {
    console.warn("booking_cancel skipped: no writable session/seats (see setup warnings).");
    return;
  }
  // Unique per iteration inside the scenario: one distinct seat per cycle.
  const slot = exec.scenario.iterationInTest;
  const seatId = data.cancel.seatIds[slot];
  const token = data.cancel.tokens[slot % data.cancel.tokens.length];

  const hold = holdSeat(data.sessionId, seatId, token);
  const book = http.post(
    `${BASE_URL}/sessions/${data.sessionId}/seats/${seatId}/book`,
    JSON.stringify({ ticketType: "full" }),
    params("POST /sessions/:id/seats/:seatId/book", token, 201),
  );
  let ok = hold.status === 200 && book.status === 201;
  let bookingId = null;
  if (book.status === 201) bookingId = book.json("bookingId");

  if (ok) {
    // Mocked confirmation (no payment). 404 means the route is not available.
    const confirm = http.post(
      `${BASE_URL}/bookings/${bookingId}/confirm`,
      null,
      paramsNoBody("POST /bookings/:id/confirm", token, 200, 404),
    );
    if (confirm.status === 404) {
      console.warn("POST /bookings/:id/confirm returned 404 (route not enabled): skipping booking_cancel.");
      // Leaves one pending booking; it expires on its own (sweeper / lazy expiry).
      sleep(1);
      return;
    }
    const cancel = http.post(
      `${BASE_URL}/bookings/${bookingId}/cancel`,
      null,
      paramsNoBody("POST /bookings/:id/cancel", token, 200),
    );
    ok = confirm.status === 200 && cancel.status === 200;
  }

  check(null, { "hold, book, confirm and cancel all succeeded": () => ok });
  if (ok) bookingCycleOk.add(1);
  else bookingCycleFailed.add(1);
  sleep(1);
}

// --------------------------------------------------------------- teardown

export function teardown(data) {
  // Release the contention winner's hold (release is idempotent and silent for
  // non-owners, so trying every token is safe). Bookings are already cancelled.
  if (data.contention) {
    for (const token of data.contention.tokens) {
      releaseSeat(data.sessionId, data.contention.seatId, token);
    }
  }
  if (data.cancel) {
    for (const token of data.cancel.tokens) {
      http.del(
        `${BASE_URL}/sessions/${data.sessionId}/holds`,
        null,
        paramsNoBody("DELETE /sessions/:id/holds", token, 200),
      );
    }
  }
}
