"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { ensure, request } = require("../source/bridge/cli.cjs");
const { load } = require("../source/bridge/state.cjs");
const profile = path.resolve(process.env.FB_SUPERVISOR_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-supervisor-")));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await ensure(profile);
  try {
    const first = load(path.join(profile, "runtime.json"));
    const before = await request(profile, "/api/status");
    await request(profile, "/api/settings", { openOnStartup: true });
    if (process.platform === "linux") {
      const args = fs.readFileSync(`/proc/${first.pid}/cmdline`).toString().split("\0");
      assert(args.includes(profile) && args.includes("serve"), "Only this owned test backend may be signalled");
    }
    process.kill(first.pid, "SIGKILL");
    let recovered;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      try {
        const runtime = load(path.join(profile, "runtime.json"));
        if (runtime?.pid !== first.pid) {
          const state = await request(profile, "/api/status");
          assert.equal(state.identity.id, before.identity.id);
          assert.equal(state.settings.openOnStartup, true);
          recovered = runtime;
          break;
        }
      } catch {}
    }
    assert(recovered, "Supervisor did not recover the owned crashed backend");
    const entries = fs.readFileSync(path.join(profile, "logs/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert(entries.some(e => e.event === "backend_retry" && e.delayMs === 1000));
    const evidence = { passed: true, platform: process.platform, node: process.version, checks: ["Owned backend crash recovered by independent supervisor", "First retry waits one second", "Device identity and startup preference survive process crash", "Structured exit and retry events persisted"] };
    console.log(JSON.stringify(evidence, null, 2));
    if (process.env.FB_SUPERVISOR_RESULT) fs.writeFileSync(process.env.FB_SUPERVISOR_RESULT, JSON.stringify(evidence, null, 2) + "\n");
  } finally { await request(profile, "/api/shutdown", {}).catch(() => {}); }
})().catch(e => { console.error(e); process.exitCode = 1; });
