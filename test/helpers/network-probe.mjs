import { ensureDirectNetwork } from '../../lib/proxy-bootstrap.js';

/**
 * 探针：先自愈，再访问 argv[2] 指定的地址。
 * 重新启动自身时依赖 process.argv.slice(1) 能还原成 [脚本, 参数...]，
 * 所以这里必须是真实文件入口（不能是 node -e）。
 */
const url = process.argv[2];
const configPath = process.argv[3] || '/nonexistent-config.json';

await ensureDirectNetwork(configPath);

try {
  const res = await fetch(url);
  console.log('PROBE_OK ' + res.status);
} catch (e) {
  console.log('PROBE_FAIL ' + String(e.message).slice(0, 60));
}
process.exit(0);
