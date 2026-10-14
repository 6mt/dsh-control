#!/usr/bin/env bash
# Real-link check: an environment that has no Workspace is repaired by a plain
# restart, with no user action and no API call.
#
# This is the regression guard for the defect where the startup repair read the
# Workspace service before it had activated, failed, and recorded nothing — the
# environment stayed connected and invisible in the sidebar.
#
# Hermetic on purpose: giving an environment its Workspace is purely local, so
# this test needs no SSH, no remote host and no real token.
#
# Usage: scripts/verify-boot-selfheal.sh
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
TEST_HOME="$WORKSPACE_ROOT/dsh-control/research/test-home"
PORT="${PORT:-39496}"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
APP="/Applications/DeepSeek Harness.app/Contents/Resources"

if [ ! -x "$NODE" ]; then
	echo "SKIP: dsh runtime not found at $NODE"
	exit 0
fi

ENV_NAME="selfheal-probe"
fail() { echo "FAIL: $1"; exit 1; }

echo "1/4 造出「环境在、但没有工作区」的状态（复刻线上故障）"
python3 - "$TEST_HOME" "$ENV_NAME" <<'PY' || fail "could not stage the state"
import json, os, shutil, sys
home, name = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(home, "dsh-control"), exist_ok=True)
state = {"environments": {name: {"name": name, "endpoint": "http://127.0.0.1:1", "token": "irrelevant",
                                 "remotePort": 3080, "localPort": 1, "sshTarget": "root@127.0.0.1"}},
         "sessionBindings": {}}
json.dump(state, open(os.path.join(home, "dsh-control", "state.json"), "w"), ensure_ascii=False, indent=1)
registry = os.path.join(home, "storages", "workspace.json")
if os.path.exists(registry):
    data = json.load(open(registry))
    tables = data.get("tables", {}).get("workspaces", {})
    drop = [k for k, v in list(tables.items()) if (v.get("path") or "").endswith(name)]
    for key in drop:
        tables.pop(key)
    data["global"]["workspaceIds"] = [i for i in data["global"]["workspaceIds"] if i not in drop]
    json.dump(data, open(registry, "w"), ensure_ascii=False, indent=1)
shutil.rmtree(os.path.join(home, "workspaces"), ignore_errors=True)
print("   状态就绪：无 workspace 字段 / 无目录 / 无登记")
PY

echo "2/4 启动 dsh（不做任何操作、不调用任何接口）"
DSH_HOME="$TEST_HOME" ELECTRON_RUN_AS_NODE=1 "$APP/../MacOS/DeepSeek Harness" \
	--expose-internals "$APP/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
	--profile dshctl --no-open --port "$PORT" > /tmp/dsh-selfheal.log 2>&1 &
DSH_PID=$!
cleanup() { kill "$DSH_PID" 2>/dev/null; wait "$DSH_PID" 2>/dev/null; }
trap cleanup EXIT

echo "3/4 等待启动完成并观察自愈结果"
result=""
for _ in $(seq 1 20); do
	sleep 2
	result=$(python3 - "$TEST_HOME" "$ENV_NAME" <<'PY'
import json, os, sys
home, name = sys.argv[1], sys.argv[2]
try:
    spec = json.load(open(os.path.join(home, "dsh-control", "state.json")))["environments"][name]
except Exception:
    print(""); raise SystemExit
print(spec.get("workspacePath") or "")
PY
)
	[ -n "$result" ] && break
done

echo "4/4 断言"
[ -n "$result" ] || fail "重启后工作区仍未建立（状态里没有 workspacePath）"
[ -d "$result" ] || fail "状态里记录了工作区，但目录不存在：$result"
python3 - "$TEST_HOME" "$ENV_NAME" "$result" <<'PY' || fail "工作区没有登记到 workspace.json"
import json, os, sys
home, name, path = sys.argv[1], sys.argv[2], sys.argv[3]
registry = json.load(open(os.path.join(home, "storages", "workspace.json")))
entries = (registry.get("tables", {}).get("workspaces") or {}).values()
hits = [v for v in entries if v.get("path") == path]
if not hits:
    print("   登记表里没有这个工作区")
    raise SystemExit(1)
print(f"   已登记：{hits[0].get('title')!r} → {path}")
PY
error=$(python3 - "$TEST_HOME" "$ENV_NAME" <<'PY'
import json, os, sys
home, name = sys.argv[1], sys.argv[2]
spec = json.load(open(os.path.join(home, "dsh-control", "state.json")))["environments"][name]
print(spec.get("workspaceError") or "")
PY
)
[ -z "$error" ] || fail "工作区建好了，但仍留着失败原因：$error"
echo "PASS: 只重启即修复，无任何用户操作"
