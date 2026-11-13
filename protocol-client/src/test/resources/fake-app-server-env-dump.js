// spawn env 透传夹具（issue #50）：把子进程看到的 ZCODE_DATA_BASE_DIR 落盘供断言。
// 宿主测试用 extraEnv 传 SPAWN_ENV_DUMP（落盘路径）与数据根本身——验证引线是
// start(extraEnv=...) 的真实管道，而非进程继承 env。
if (process.argv[2] === "--version") { console.log("0.16.5"); process.exit(0); }

const fs = require("fs");
const dump = process.env.SPAWN_ENV_DUMP;
if (dump) fs.writeFileSync(dump, process.env.ZCODE_DATA_BASE_DIR || "");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m && m.method === "session/list") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { sessions: [] } }) + "\n");
    }
  }
});
