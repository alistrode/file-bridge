"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const args = process.argv.slice(2),
  arg = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f),
  out = arg("--out"),
  interval = Number(arg("--interval", "10")) * 1000;
let previous;
function numeric(p) {
  try {
    return Number(fs.readFileSync(p, "utf8").trim());
  } catch {
    return null;
  }
}
function sample() {
  const time = Date.now();
  let total = os.totalmem(),
    used = total - os.freemem(),
    cores = os.cpus().length,
    cpuTicks = os
      .cpus()
      .reduce(
        (r, c) => ({
          busy:
            r.busy + c.times.user + c.times.sys + c.times.nice + c.times.irq,
          total: r.total + Object.values(c.times).reduce((a, b) => a + b, 0),
        }),
        { busy: 0, total: 0 },
      ),
    cpu = null;
  if (process.platform === "linux") {
    const limit = numeric("/sys/fs/cgroup/memory.max"),
      current = numeric("/sys/fs/cgroup/memory.current");
    if (Number.isFinite(limit) && limit > 0 && current !== null) {
      total = limit;
      used = current;
    }
    try {
      const q = fs
        .readFileSync("/sys/fs/cgroup/cpu.max", "utf8")
        .trim()
        .split(/\s+/);
      if (q[0] !== "max") cores = Number(q[0]) / Number(q[1]);
      const stat = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
      const usage = Number(stat.match(/^usage_usec (\d+)/m)[1]);
      if (previous?.usage !== undefined)
        cpu =
          ((usage - previous.usage) / ((time - previous.time) * 1000 * cores)) *
          100;
      cpuTicks.usage = usage;
    } catch {}
  }
  if (cpu === null && previous)
    cpu =
      ((cpuTicks.busy - previous.busy) / (cpuTicks.total - previous.total)) *
      100;
  previous = { time, ...cpuTicks };
  let disk = null;
  try {
    const s = fs.statfsSync(path.resolve(__dirname, ".."));
    disk = Math.round((s.bavail * s.bsize) / 1048576);
  } catch {}
  const result = {
    time: new Date(time).toISOString(),
    platform: process.platform,
    cpuLimitCores: cores,
    cpuPercent: cpu === null ? null : Math.round(cpu * 10) / 10,
    memoryUsedMiB: Math.round(used / 1048576),
    memoryTotalMiB: Math.round(total / 1048576),
    memoryPercent: Math.round((used / total) * 1000) / 10,
    diskFreeMiB: disk,
  };
  if (out)
    fs.appendFileSync(out, JSON.stringify(result) + "\n", { mode: 0o600 });
  else console.log(JSON.stringify(result));
}
sample();
setInterval(sample, interval);
