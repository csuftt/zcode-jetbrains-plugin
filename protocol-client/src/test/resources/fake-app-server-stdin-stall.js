// stdin 写阻塞判死回归夹具（app-server-silent-hang 三/四例，2026-10-28/29）：
// 模拟交互弹窗应答后 app-server 进程挂死——就绪探测正常应答，收到任何后续请求
// 即永久 pause 停止消费 stdin。此后客户端再发大消息（超过 OS 管道缓冲）时写入
// 永久阻塞，触发 StdinWriteGate 超时判死 → kill 进程树。修复前该场景写入无超时，
// 持 sendLock 永久卡死，所有停止/发送排队无痕，唯一解是用户手动杀进程。
if (process.argv[2] === "--version") { console.log("0.16.5"); process.exit(0); }

// 启动即应答就绪探测（session/list #1），保证 start() 正常返回
process.stdout.write(JSON.stringify({ id: 1, result: { sessions: [] } }) + "\n");

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // 挂死模拟：不再解析、不再应答、永久停读——进程活着但 stdin 无人消费
  try { process.stdin.pause(); } catch (_) {}
});

// 保活不退出（被插件 kill 才死）
setInterval(() => {}, 1 << 30);
