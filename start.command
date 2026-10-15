#!/bin/bash
# 双击启动个人英语学习 App
cd "$(dirname "$0")" || exit 1

# 清除可能失效的代理（PRD 风险表：本机代理可能指向死端口）
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
export NODE_USE_ENV_PROXY=0

PORT="${PORT:-4317}"
command -v node >/dev/null 2>&1 || {
  echo "未找到 Node.js，请先安装 Node v24+"
  read -r -p "按回车退出"
  exit 1
}

( sleep 1; open "http://127.0.0.1:${PORT}/" ) >/dev/null 2>&1 &
exec node server.js
