const assert = require("assert");
const { diffStatuses } = require("../notify.js");

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

// 1. first-scan seeding: no notifications, map seeded, badge still counted
run("first-scan seeds map without notifying", () => {
  const prev = new Map();
  const sessions = [
    { sessionId: "a", status: "needs_input" },
    { sessionId: "b", status: "working" },
  ];
  const { toNotify, badgeCount, nextMap } = diffStatuses(prev, sessions, true);
  assert.strictEqual(toNotify.length, 0);
  assert.strictEqual(badgeCount, 1);
  assert.strictEqual(nextMap.get("a"), "needs_input");
  assert.strictEqual(nextMap.get("b"), "working");
});

// 2. working -> needs_input fires once
run("working->needs_input fires once", () => {
  const prev = new Map([["a", "working"]]);
  const sessions = [{ sessionId: "a", status: "needs_input" }];
  const { toNotify, badgeCount } = diffStatuses(prev, sessions, false);
  assert.strictEqual(toNotify.length, 1);
  assert.strictEqual(toNotify[0].sessionId, "a");
  assert.strictEqual(badgeCount, 1);
});

// 3. staying needs_input does not re-fire
run("staying needs_input does not re-fire", () => {
  const prev = new Map([["a", "needs_input"]]);
  const sessions = [{ sessionId: "a", status: "needs_input" }];
  const { toNotify, badgeCount } = diffStatuses(prev, sessions, false);
  assert.strictEqual(toNotify.length, 0);
  assert.strictEqual(badgeCount, 1);
});

// 4. needs_input -> working -> needs_input fires again
run("needs_input->working->needs_input fires again", () => {
  let map = new Map([["a", "needs_input"]]);
  // -> working
  let r = diffStatuses(map, [{ sessionId: "a", status: "working" }], false);
  assert.strictEqual(r.toNotify.length, 0);
  map = r.nextMap;
  assert.strictEqual(map.get("a"), "working");
  // -> needs_input again
  r = diffStatuses(map, [{ sessionId: "a", status: "needs_input" }], false);
  assert.strictEqual(r.toNotify.length, 1);
});

// 5. legacy excluded from notifications (still counts toward badge)
run("legacy session excluded from notifications", () => {
  const prev = new Map([["a", "working"]]);
  const sessions = [
    { sessionId: "a", status: "needs_input", legacy: true },
  ];
  const { toNotify, badgeCount } = diffStatuses(prev, sessions, false);
  assert.strictEqual(toNotify.length, 0);
  assert.strictEqual(badgeCount, 1);
});

// 6. badge count correct across mixed statuses
run("badge count correct", () => {
  const prev = new Map([
    ["a", "needs_input"],
    ["b", "needs_input"],
    ["c", "working"],
  ]);
  const sessions = [
    { sessionId: "a", status: "needs_input" },
    { sessionId: "b", status: "needs_input" },
    { sessionId: "c", status: "working" },
    { sessionId: "d", status: "waiting" },
  ];
  const { badgeCount } = diffStatuses(prev, sessions, false);
  assert.strictEqual(badgeCount, 2);
});

// 7. disappeared sessions dropped from map
run("disappeared sessions dropped from map", () => {
  const prev = new Map([
    ["a", "needs_input"],
    ["gone", "working"],
  ]);
  const sessions = [{ sessionId: "a", status: "needs_input" }];
  const { nextMap } = diffStatuses(prev, sessions, false);
  assert.strictEqual(nextMap.has("gone"), false);
  assert.strictEqual(nextMap.has("a"), true);
  assert.strictEqual(nextMap.size, 1);
});

// 8. brand-new session appearing already in needs_input (not first scan) SHOULD notify
run("new needs_input session with no prior status notifies on non-seed scan", () => {
  const prev = new Map([["a", "working"]]);
  const sessions = [
    { sessionId: "a", status: "working" },
    { sessionId: "new", status: "needs_input" },
  ];
  const { toNotify, badgeCount } = diffStatuses(prev, sessions, false);
  assert.strictEqual(toNotify.length, 1);
  assert.strictEqual(toNotify[0].sessionId, "new");
  assert.strictEqual(badgeCount, 1);
});

// 9. brand-new session appearing already in needs_input on the SEED scan does NOT notify
run("new needs_input session with no prior status does NOT notify on seed scan", () => {
  const prev = new Map();
  const sessions = [
    { sessionId: "new", status: "needs_input" },
  ];
  const { toNotify, badgeCount } = diffStatuses(prev, sessions, true);
  assert.strictEqual(toNotify.length, 0);
  assert.strictEqual(badgeCount, 1);
});

if (!process.exitCode) console.log("\nAll tests passed.");
