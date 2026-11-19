// stdio 入口：本地宿主（Claude Desktop / Cursor / Cindy 插件）用这个。
// 远程部署用 http-server.mjs。传输之外的全部逻辑都在 core.mjs。

import { createInterface } from "node:readline";
import { createSession, closeWorker, log } from "./core.mjs";

let stdoutBroken = false;

function send(message) {
  if (stdoutBroken) return false;
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
    return true;
  } catch (error) {
    onStdoutBroken(error);
    return false;
  }
}

// EPIPE：宿主把管道关了。以前这里是未捕获异常，进程 100ms 内 exit 1，
// 之后所有 tools/call 都没有接收方（用户看到的就是「一直卡住」）。
// 现在记录原因、收尾退出，不留崩溃堆栈。
function onStdoutBroken(error) {
  if (stdoutBroken) return;
  stdoutBroken = true;
  log(`stdout closed (${error?.code ?? error?.message ?? error}); no receiver left, shutting down`);
  shutdown(0, "stdout broken");
}

const session = createSession(send);

process.stdout.on("error", onStdoutBroken);
process.stdin.on("error", (error) => {
  log(`stdin error: ${error?.message ?? error}`);
  shutdown(0, "stdin error");
});
// 兜底：任何漏网异常都不许把进程带走，记日志继续服务。
process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error?.stack ?? error}`);
});
process.on("unhandledRejection", (error) => {
  log(`unhandled rejection: ${error?.stack ?? error}`);
});

let shuttingDown = false;

/** 收尾：先让在飞请求把结果/错误回完（最多 2 秒），再收掉 worker 退出。 */
function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${reason}`);
  try {
    rl.close();
  } catch {
    /* 已经关了 */
  }
  const finish = () => {
    closeWorker();
    process.exit(code);
  };
  if (stdoutBroken || session.inflight.size === 0) {
    setTimeout(finish, 50).unref();
    return;
  }
  const deadline = Date.now() + 2000;
  const tick = () => {
    if (session.inflight.size === 0 || Date.now() > deadline) return finish();
    setTimeout(tick, 50).unref();
  };
  tick();
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void session.handle(msg);
});
rl.on("close", () => {
  // 以前这里直接 process.exit(0)，stdin 一断就无声消失。现在把在飞请求收完再走。
  shutdown(0, "stdin closed");
});
