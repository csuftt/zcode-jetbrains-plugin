#!/usr/bin/env python3
"""PAT 换发链日志健康巡检（issue#45-3 内置渠道材料链）

用法：
    python scripts/pat-log-check.py                 # 分析 IDEA 当前日志
    python scripts/pat-log-check.py --log <路径>     # 指定日志（如 PyCharm 的 idea.log 或滚动 idea.log.1）

分析对象（背景：内置渠道材料链走 PAT 换发，PAT 寿命约 5 小时=expiresIn 18000s，
到期自动重换发；历史上「过期重换发」出现过约 40 秒的间歇性失败窗口，已加
请求级日志 + 换发重试 1 次 + 负缓存 60s 加固，本脚本用于观察加固效果）：
  [PAT] 前缀行          —— locateProject/list/create/issue 各步失败与请求级服务端响应
  [AccountProviderBridge] —— credentials.json 并发写重试耗尽、PAT 材料缺失
  providerRuntimeHeaders: supplying —— 供给成功
  prompt_failed         —— 回合失败
"""
import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_LOG = r"C:\Users\Administrator\AppData\Local\JetBrains\IntelliJIdea2026.2\log\idea.log"

PATTERNS = [
    ("PAT失败", re.compile(r"\[PAT\]")),
    ("凭证读失败", re.compile(r"\[AccountProviderBridge\]")),
    ("供给成功", re.compile(r"providerRuntimeHeaders: supplying apiKey")),
    ("回合失败", re.compile(r"prompt_failed")),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--since", help="只看该时刻之后（HH:MM 或 MM-DD HH:MM），默认当天")
    args = ap.parse_args()

    log = Path(args.log)
    if not log.exists():
        print(f"日志不存在: {log}")
        return 2
    today = datetime.now().strftime("%Y-%m-%d ")
    lines = []
    with log.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not any(p.search(line) for _, p in PATTERNS):
                continue
            if args.since:
                if args.since not in line and (len(args.since) == 5 and (today + args.since) not in line):
                    continue
            elif today not in line:
                continue
            lines.append(line)

    ok = [l for l in lines if "supplying apiKey" in l]
    fails = [l for l in lines if "[PAT]" in l]
    cred = [l for l in lines if "[AccountProviderBridge]" in l]
    turn_fail = [l for l in lines if "prompt_failed" in l]

    print(f"=== PAT 换发链巡检（{log.name}，当日）===")
    print(f"供给成功: {len(ok)} 次，最近一次: {ok[-1][:19] if ok else '无'}")
    print(f"[PAT] 失败行: {len(fails)} 条")
    for l in fails:
        print("  " + l[:400])
    if cred:
        print(f"[AccountProviderBridge] 异常: {len(cred)} 条")
        for l in cred:
            print("  " + l[:300])
    print(f"prompt_failed: {len(turn_fail)} 次: " + ", ".join(l[11:23] for l in turn_fail[-5:]))

    # 诊断
    if not fails and not cred:
        print(f"结论: 换发链健康（观察窗口内零失败，供给 {len(ok)} 次）。加固生效中。")
    else:
        print("结论: 有失败，逐条看上方 [PAT] 行的请求级响应（status+code+msg）。")
        retried = any("issue bad resp" in l or "create bad resp" in l for l in fails)
        recovered = ok and fails and ok[-1][:19] > fails[-1][:19]
        if retried and recovered:
            print("注: 检测到换发失败后供给已恢复——若失败行后紧随 supplying，说明重试/自愈跨过了失败窗口。")
        # 5 小时周期对照：相邻失败或失败与供给的时间差
        stamps = [l[11:23] for l in fails]
        print(f"失败时间点: {stamps}（历史规律: 失败间隔≈5h=PAT 寿命，即「过期重换发」时机）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
