const assert = require("assert");
const focus = require("../focus.js");

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

// --- ttyToDevicePath ---

run("ttyToDevicePath: bare ttys name -> /dev path", () => {
  assert.strictEqual(focus.ttyToDevicePath("ttys012"), "/dev/ttys012");
});

run("ttyToDevicePath: trims trailing whitespace from ps output", () => {
  assert.strictEqual(focus.ttyToDevicePath("ttys024 \n"), "/dev/ttys024");
});

run("ttyToDevicePath: already-absolute path passes through", () => {
  assert.strictEqual(focus.ttyToDevicePath("/dev/ttys004"), "/dev/ttys004");
});

run("ttyToDevicePath: '??' (no controlling tty) -> null", () => {
  assert.strictEqual(focus.ttyToDevicePath("??"), null);
});

run("ttyToDevicePath: empty string -> null", () => {
  assert.strictEqual(focus.ttyToDevicePath(""), null);
});

run("ttyToDevicePath: non-string -> null", () => {
  assert.strictEqual(focus.ttyToDevicePath(null), null);
  assert.strictEqual(focus.ttyToDevicePath(undefined), null);
});

run("ttyToDevicePath: rejects non-ttys device (no injection)", () => {
  assert.strictEqual(focus.ttyToDevicePath("ttyp0"), null);
  assert.strictEqual(focus.ttyToDevicePath('ttys0"; do shell script "x'), null);
  assert.strictEqual(focus.ttyToDevicePath("../evil"), null);
});

// --- isValidDevicePath ---

run("isValidDevicePath: accepts valid, rejects invalid", () => {
  assert.strictEqual(focus.isValidDevicePath("/dev/ttys012"), true);
  assert.strictEqual(focus.isValidDevicePath("/dev/ttyp0"), false);
  assert.strictEqual(focus.isValidDevicePath("ttys012"), false);
  assert.strictEqual(focus.isValidDevicePath(""), false);
});

// --- buildITermScript ---

run("buildITermScript: embeds device and compares tty", () => {
  const script = focus.buildITermScript("/dev/ttys012");
  assert.ok(script.includes("iTerm2"));
  assert.ok(script.includes('tty of s is "/dev/ttys012"'));
  assert.ok(script.includes("activate"));
});

run("buildITermScript: throws on invalid device", () => {
  assert.throws(() => focus.buildITermScript('x"; evil'));
  assert.throws(() => focus.buildITermScript("ttys012"));
});

// --- buildTerminalScript ---

run("buildTerminalScript: embeds device and compares tty", () => {
  const script = focus.buildTerminalScript("/dev/ttys030");
  assert.ok(script.includes("Terminal"));
  assert.ok(script.includes('tty of t is "/dev/ttys030"'));
  assert.ok(script.includes("activate"));
});

run("buildTerminalScript: throws on invalid device", () => {
  assert.throws(() => focus.buildTerminalScript("/etc/passwd"));
});

// --- parsePpidComm ---

run("parsePpidComm: parses ppid and comm", () => {
  assert.deepStrictEqual(focus.parsePpidComm(" 1755 claude\n"), {
    ppid: 1755,
    comm: "claude",
  });
  assert.deepStrictEqual(focus.parsePpidComm("64789 /bin/zsh"), {
    ppid: 64789,
    comm: "/bin/zsh",
  });
});

run("parsePpidComm: keeps spaces inside comm (app paths)", () => {
  assert.deepStrictEqual(
    focus.parsePpidComm("  123 /Applications/My Term.app/Contents/MacOS/myterm"),
    { ppid: 123, comm: "/Applications/My Term.app/Contents/MacOS/myterm" },
  );
});

run("parsePpidComm: garbage/empty/non-string -> null", () => {
  assert.strictEqual(focus.parsePpidComm(""), null);
  assert.strictEqual(focus.parsePpidComm("notanumber comm"), null);
  assert.strictEqual(focus.parsePpidComm(null), null);
});

// --- commBasename / matchTerminalApp / matchMultiplexer ---

run("commBasename: basename, lowercase, login-shell dash stripped", () => {
  assert.strictEqual(focus.commBasename("/bin/zsh"), "zsh");
  assert.strictEqual(focus.commBasename("-/bin/zsh"), "zsh");
  assert.strictEqual(focus.commBasename("-zsh"), "zsh");
  assert.strictEqual(
    focus.commBasename("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
    "ghostty",
  );
});

run("matchTerminalApp: known terminals matched, bundle path extracted", () => {
  assert.deepStrictEqual(
    focus.matchTerminalApp("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
    { appName: "Ghostty", bundlePath: "/Applications/Ghostty.app" },
  );
  assert.deepStrictEqual(focus.matchTerminalApp("Ghostty"), {
    appName: "Ghostty",
    bundlePath: null,
  });
  assert.strictEqual(focus.matchTerminalApp("wezterm-gui").appName, "WezTerm");
  assert.strictEqual(focus.matchTerminalApp("/usr/local/bin/kitty").appName, "kitty");
  assert.strictEqual(focus.matchTerminalApp("Alacritty").appName, "Alacritty");
});

run("matchTerminalApp: non-terminals -> null", () => {
  assert.strictEqual(focus.matchTerminalApp("/bin/zsh"), null);
  assert.strictEqual(focus.matchTerminalApp("claude"), null);
  assert.strictEqual(focus.matchTerminalApp("/opt/homebrew/bin/zellij"), null);
});

run("matchMultiplexer: zellij and tmux matched, others not", () => {
  assert.strictEqual(focus.matchMultiplexer("/opt/homebrew/bin/zellij"), "zellij");
  assert.strictEqual(focus.matchMultiplexer("tmux"), "tmux");
  assert.strictEqual(focus.matchMultiplexer("/bin/zsh"), null);
});

// --- async tests: findTerminalAncestor (fake process table) + resolveTty guards ---

/** Build an injected reader from a fake process table: pid -> {ppid, comm}. */
function fakeRead(table) {
  return async (pid) => table[pid] || null;
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

(async () => {
  await runAsync("findTerminalAncestor: finds terminal via direct chain", async () => {
    const table = {
      100: { ppid: 90, comm: "claude" },
      90: { ppid: 80, comm: "-/bin/zsh" },
      80: { ppid: 1, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    };
    const res = await focus.findTerminalAncestor(100, { read: fakeRead(table) });
    assert.deepStrictEqual(res.terminal, {
      appName: "Ghostty",
      bundlePath: "/Applications/Ghostty.app",
    });
  });

  await runAsync(
    "findTerminalAncestor: dead-end at detached multiplexer reports it",
    async () => {
      const table = {
        100: { ppid: 90, comm: "claude" },
        90: { ppid: 80, comm: "/bin/zsh" },
        80: { ppid: 1, comm: "/opt/homebrew/bin/zellij" },
      };
      const res = await focus.findTerminalAncestor(100, { read: fakeRead(table) });
      assert.strictEqual(res.terminal, null);
      assert.strictEqual(res.multiplexer, "zellij");
    },
  );

  await runAsync("findTerminalAncestor: no terminal, no multiplexer -> nulls", async () => {
    const table = {
      100: { ppid: 90, comm: "claude" },
      90: { ppid: 1, comm: "node" },
    };
    const res = await focus.findTerminalAncestor(100, { read: fakeRead(table) });
    assert.strictEqual(res.terminal, null);
    assert.strictEqual(res.multiplexer, null);
  });

  await runAsync(
    "findTerminalAncestor: respects maxDepth (no infinite walk on cycles)",
    async () => {
      const table = {
        100: { ppid: 90, comm: "a" },
        90: { ppid: 100, comm: "b" }, // cycle
      };
      const res = await focus.findTerminalAncestor(100, {
        read: fakeRead(table),
        maxDepth: 10,
      });
      assert.strictEqual(res.terminal, null);
    },
  );

  await runAsync("findTerminalAncestor: unknown pid -> nulls", async () => {
    const res = await focus.findTerminalAncestor(424242, { read: fakeRead({}) });
    assert.deepStrictEqual(res, { terminal: null, multiplexer: null });
  });

  await runAsync("resolveTty: non-positive/invalid pid resolves null", async () => {
    assert.strictEqual(await focus.resolveTty(0), null, "pid 0 -> null");
    assert.strictEqual(await focus.resolveTty(-1), null, "negative pid -> null");
    assert.strictEqual(await focus.resolveTty(1.5), null, "non-integer pid -> null");
  });

  if (!process.exitCode) console.log("\nAll tests passed.");
})();
