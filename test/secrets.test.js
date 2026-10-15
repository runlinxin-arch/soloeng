import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadSecrets, keyStatus } from '../lib/secrets.js';

test('parseEnv 兼容 export 前缀（开发计划 D4）', () => {
  const env = parseEnv('export DEEPSEEK_API_KEY=sk-abc123\n');
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-abc123');
});

test('parseEnv 处理引号/注释/空行/等号值', () => {
  const text = [
    '# 注释行',
    '',
    'MW_COLLEGIATE_KEY="quoted-key"',
    "MW_THESAURUS_KEY='single-quoted'",
    'export BASE=https://x.test/?a=1&b=2',
    '   SPACED_KEY = spaced-value  '
  ].join('\n');
  const env = parseEnv(text);
  assert.equal(env.MW_COLLEGIATE_KEY, 'quoted-key');
  assert.equal(env.MW_THESAURUS_KEY, 'single-quoted');
  assert.equal(env.BASE, 'https://x.test/?a=1&b=2');
  assert.equal(env.SPACED_KEY, 'spaced-value');
  assert.equal(env['# 注释行'], undefined);
  assert.equal(Object.keys(env).length, 4);
});

test('loadSecrets 合并两个文件且 app secrets 优先', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engsec-'));
  const appSecrets = join(dir, 'secrets.env');
  const fallback = join(dir, '.secrets');
  await writeFile(fallback, 'export DEEPSEEK_API_KEY=from-fallback\nexport ONLY_FALLBACK=1\n');
  await writeFile(appSecrets, 'MW_COLLEGIATE_KEY=app-key\nDEEPSEEK_API_KEY=from-app\n');
  const r = await loadSecrets({ appSecrets, fallbackSecrets: fallback });
  assert.equal(r.values.MW_COLLEGIATE_KEY, 'app-key');
  assert.equal(r.values.DEEPSEEK_API_KEY, 'from-app', 'app secrets 应优先');
  assert.equal(r.values.ONLY_FALLBACK, '1', '仅存在于 fallback 的键应保留');
  assert.equal(r.found[appSecrets], true);
  assert.equal(r.found[fallback], true);
});

test('loadSecrets 文件缺失时不抛错', async () => {
  const r = await loadSecrets({ appSecrets: '/nonexistent/a.env', fallbackSecrets: '/nonexistent/b.env' });
  assert.deepEqual(r.values, {});
  assert.equal(r.found['/nonexistent/a.env'], false);
});

test('keyStatus 只暴露布尔，绝不泄露明文（PRD §5.1）', () => {
  const s = keyStatus({ DEEPSEEK_API_KEY: 'sk-secret', MW_COLLEGIATE_KEY: 'k', MW_THESAURUS_KEY: 't' });
  assert.deepEqual(s, { deepseek: true, mwCollegiate: true, mwThesaurus: true, mw: true });
  const json = JSON.stringify(s);
  assert.ok(!json.includes('sk-secret'), '状态里不得出现明文 key');
  assert.equal(keyStatus({}).deepseek, false);
});
