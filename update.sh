#!/usr/bin/env bash
set -euo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  printf '更新已停止：%s\n' "$*" >&2
  exit 1
}

for tool in git node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "找不到 $tool，请先准备 mise 管理的 Node 和 pnpm。"
done

[[ -z "$(git status --porcelain)" ]] || fail '仓库有未提交或未跟踪文件，请先自行处理；脚本不会 stash、覆盖或删除文件。'
git symbolic-ref -q HEAD >/dev/null || fail '当前处于 detached HEAD，请先切换到需要更新的分支。'
git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 || fail '当前分支没有上游，请先配置跟踪分支。'

check_runtime() {
  node --input-type=commonjs -e '
    const { engines } = require("./package.json");
    const minimum = engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
    if (!minimum) throw new Error("Unsupported Node engine requirement: " + engines.node);
    const actual = process.versions.node.split(".").map(Number);
    const required = minimum.slice(1).map(Number);
    const difference = actual.map((part, i) => part - required[i]).find(part => part !== 0) ?? 0;
    if (difference < 0) throw new Error("Node " + engines.node + " required; found " + process.versions.node);
  ' || fail 'Node 版本不满足 package.json，请通过 mise 准备运行时后重试。'
  local expected actual
  expected="$(node --input-type=commonjs -p 'require("./package.json").packageManager')"
  actual="pnpm@$(pnpm --version)"
  [[ "$actual" == "$expected" ]] || fail "需要 $expected，当前为 $actual；请准备指定版本后重试。"
}

check_runtime
printf '正在快进更新当前分支……\n'
git -c pull.rebase=false pull --ff-only

# Recheck requirements in case the incoming version changed them.
check_runtime
printf '正在安装项目本地依赖……\n'
pnpm install --frozen-lockfile --ignore-scripts
[[ -d node_modules ]] || fail '本地 node_modules 不存在，无法构建。'
printf '正在检查类型并构建……\n'
pnpm run typecheck
pnpm run build
printf '\n更新完成：%s/dist/index.js\n请让 IDE 重新启动代理进程；/reload 不会加载新代码。\n' "$PWD"
