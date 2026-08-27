# -*- coding: utf-8 -*-
"""issue #4 验收辅助：config 配置形态一键开关

用法：
  python scripts/issue4-creds-toggle.py status    # 查看当前形态
  python scripts/issue4-creds-toggle.py break     # 备份（首次）+ 删所有 enabled provider 的 apiKey
  python scripts/issue4-creds-toggle.py restore   # 从备份还原真实凭证（完整 key 版）
  python scripts/issue4-creds-toggle.py restore-experiment
                                                  # 删除实验后完整恢复：v2←完整key备份 + cli←实验前备份
                                                  #（自定义 provider 的 key 只在 issue4-bak 里；
                                                  #  cli 的 mcp.servers/plugins 启用清单只在实验备份里）

注意：break/restore 前后请勿运行 ZCode 客户端（它会回写该文件）。
"""
import json, os, shutil, sys

SRC = os.path.join(os.path.expanduser('~'), '.zcode', 'v2', 'config.json')
BAK = SRC + '.issue4-bak-20260827'
CLI = os.path.join(os.path.expanduser('~'), '.zcode', 'cli', 'config.json')
EXP_BAK_DIR = os.path.join(os.path.expanduser('~'), '.zcode', 'issue4-backup-20260827')
EXP_CLI_BAK = os.path.join(EXP_BAK_DIR, 'cli-config.json')


def status():
    if not os.path.exists(SRC):
        print('config.json 不存在')
        return
    d = json.load(open(SRC, encoding='utf-8'))
    for pid, pv in (d.get('provider') or {}).items():
        if isinstance(pv, dict) and pv.get('enabled'):
            ak = (pv.get('options') or {}).get('apiKey')
            flag = 'MISSING' if ak is None else ('EMPTY' if ak == '' else f'present(len={len(ak)})')
            print(f'  enabled {pid}: apiKey={flag}')
    print('备份:', BAK, '存在' if os.path.exists(BAK) else '不存在')


def do_break():
    if not os.path.exists(BAK):
        shutil.copy2(SRC, BAK)
        print('已备份 ->', BAK)
    else:
        print('备份已存在 ->', BAK)
    d = json.load(open(SRC, encoding='utf-8'))
    removed = [pid for pid, pv in (d.get('provider') or {}).items()
               if isinstance(pv, dict) and pv.get('enabled') and 'apiKey' in (pv.get('options') or {})]
    for pid in removed:
        del d['provider'][pid]['options']['apiKey']
    json.dump(d, open(SRC, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('已删除 apiKey 的 enabled provider:', removed)


def do_restore():
    if not os.path.exists(BAK):
        print('备份不存在，无法还原:', BAK)
        sys.exit(1)
    shutil.copy2(BAK, SRC)
    print('已还原真实凭证 <-', BAK)


def do_restore_experiment():
    """删除实验（v2+cli 双删、客户端重建）后的完整恢复"""
    if not os.path.exists(BAK):
        print('v2 完整 key 备份不存在:', BAK)
        sys.exit(1)
    shutil.copy2(BAK, SRC)
    print('v2/config.json <-', BAK, '（完整凭证 + 自定义 provider）')
    if os.path.exists(EXP_CLI_BAK):
        shutil.copy2(EXP_CLI_BAK, CLI)
        print('cli/config.json <-', EXP_CLI_BAK, '（provider + mcp.servers + plugins 启用清单）')
    else:
        print('⚠️ cli 实验备份缺失:', EXP_CLI_BAK, '（cli/config.json 未恢复）')
    print('完成。可删除实验备份目录:', EXP_BAK_DIR)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    {'status': status, 'break': do_break, 'restore': do_restore,
     'restore-experiment': do_restore_experiment}.get(cmd, status)()
