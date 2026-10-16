import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));

/** package.json engines.node 里声明的最低主版本号（唯一事实来源） */
export function requiredMajor() {
  const m = String((pkg.engines && pkg.engines.node) || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function currentMajor() {
  return Number(process.versions.node.split('.')[0]);
}

/** 满足要求返回 null，否则返回一句话说明 */
export function nodeVersionProblem() {
  const need = requiredMajor();
  if (!need) return 'package.json 没有声明 engines.node';
  if (currentMajor() < need) {
    return '需要 Node >= ' + need + '（见 package.json engines），当前是 v' + process.versions.node;
  }
  return null;
}
