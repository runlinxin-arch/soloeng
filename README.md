# 个人英语学习 App

只给本人使用的本地英语学习工具：输入一个英文词，几秒内得到一张**完全来自官方词典**的中文讲解卡片，
自动写进 Obsidian 库，并按间隔重复安排复习。

- **形态**：本地 Web 应用（浏览器界面 + 本机服务），只监听 `127.0.0.1`，不打包成 .app
- **运行时**：Node.js v24
- **依赖**：仅 1 个（cheerio，用于解析官方页面），其余全部 Node 内置模块
- **前端**：原生 HTML/CSS/JS

---

## 快速开始

```bash
npm install          # 只装 cheerio
node server.js       # 启动服务
```

然后打开 <http://127.0.0.1:4317>。macOS 上也可以直接**双击 `start.command`**。

**首次启动后请先点右上角「设置」，填入你自己的 Obsidian 库目录。**
代码里刻意不预置任何本机路径（默认值为空），未配置时查词会提示「尚未配置库路径」。

### 关于代理（一个容易踩的坑）

如果 shell 里有 `http_proxy` / `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 之类的变量，而那个代理**已经失效**，
直接 `node server.js` 会导致所有抓取失败——因为 **Node 在启动期就装好了代理 dispatcher**，
之后再删环境变量已经太晚。

程序会自己处理这件事：检测到继承了代理变量、而配置是 `direct` 模式时，它会
**用干净环境重启自身**并打印一行提示，然后正常走直连。所以上面两种启动方式都可以。

想手动确认网络模式，可以看这两个地方：

```bash
curl -s http://127.0.0.1:4317/api/health      # network 字段 + proxyEnv 列表
```

设置里的 `networkMode` 设为 `env` 可以关掉这个自愈（让请求老实走代理）。

## 目录结构

```
server.js             本地服务（node:http + SSE）
start.command         双击启动
lib/
  fetcher.js          官方词典抓取（UA、超时、重试、串行限速、网络模式）
  parser.js           官方 HTML → 结构化数据
  normalize.js        多源合并 → NormalizedWord（缺失字段显式标记）
  dictionary.js       一个词的完整抓取编排（OALD → 剑桥 → MW）
  parse-input.js      输入解析（单查 / 辨析 / 词根 / 中文拦截）
  llm.js              DeepSeek 流式调用 + prompt 渲染
  markdown.js         零依赖 frontmatter 读写
  store.js            Markdown 卡片读写、索引、备份、区块更新
  srs.js              间隔重复算法（纯函数）
  config.js           配置读写、库检测、Obsidian 库名推导
  secrets.js          密钥装载（兼容 `export` 语法）
  dates.js            本机自然日日期运算
  log.js              按天日志 + 每日调用计数（自动抹掉密钥）
  service.js          查词 / 复习流水线（与 HTTP 解耦，便于测试）
public/               前端（index.html / style.css / app.js / render.js）
prompts/              可编辑的生成 prompt（card.md / diff.md / roots.md）
data/                 config.json、logs/、backup/（不进版本库）
fixtures/             抓取到的官方页面与解析结果（离线测试用）
verify/               验收脚本
test/                 单元测试
```

---

## 配置

非敏感配置在 `data/config.json`（也可用界面右上角「设置」修改）：

| 字段 | 说明 |
|---|---|
| `vaultPath` | 卡片库根目录，卡片以 `{vaultPath}/{word}.md` 落盘 |
| `obsidianVaultName` | Obsidian 库名；留 `null` 时自动上溯含 `.obsidian` 的目录推导 |
| `dailyNewLimit` / `dailyReviewLimit` | 每日新词 / 复习软上限，可手动超额 |
| `model` | `deepseek-flash`（默认）或 `deepseek-v4-pro` |
| `thinkingMode` | `off`（默认，快）/ `low` / `high`（更慢但推理更强） |
| `enableMW` | 是否启用 Merriam-Webster |
| `theme` / `lengthMode` | 界面主题 / 长度档位 |
| `backupKeep` | 覆盖前备份保留份数（默认 20） |
| `networkMode` | `direct`（默认，绕过代理）或 `env` |

### 密钥

密钥**不放在代码里**，只放这两个文件（与代码目录隔离）：

```
~/.english-vocab/secrets.env   (600)  MW_COLLEGIATE_KEY / MW_THESAURUS_KEY
~/.secrets                            DEEPSEEK_API_KEY（兼容 `export KEY=` 写法）
```

界面只显示「已配置 / 未配置」，**从不显示明文**；日志也会自动抹掉密钥。

---

## 数据与不变式

1. **唯一真相源是 Obsidian 库里的 Markdown**，app 不建数据库、不持有第二份状态。
2. **浏览器里没有任何不可再生数据**——不使用 localStorage/sessionStorage/IndexedDB/Cookie。
3. **写文件只有两个时机**：生成完成、复习评分。
4. **覆盖已有卡片前一定先备份**到 `data/backup/`。
5. **抓取失败绝不写文件**（不产生半张卡）。
6. **生成失败不阻塞**：官方内容照常入库并标注「讲解生成失败」。
7. 卡片里**不写来源标注**，但所有英语事实都实时抓自官方词典；官方没有的块显示「官方词典未收录」。

> 把整个 app 目录删掉，一个词都不会丢；重新指向同一个库目录即可完全恢复。

---

## 开发与测试

```bash
npm test                # 全部单元测试（离线，不依赖网络）
npm run verify:v1       # v1 验收（PRD §7.1 九项，需要联网 + DeepSeek key）
npm run verify:v2       # v2 验收（PRD §7.2 四项，纯本地）
npm run spike           # 重新抓取官方页面并刷新 fixtures
```

数据来源优先级：**牛津 OALD → 剑桥 → Merriam-Webster**；任一来源失败都不会让整次查词失败。

---

## 测试数据（fixtures）

以下文件含抓取到的**官方原文**，受版权保护，**不随本仓库分发**（已在 `.gitignore` 中排除）：

- `fixtures/html/` —— 牛津 / 剑桥的页面原文
- `fixtures/mw-*-raw.json` —— Merriam-Webster API 的原始返回
- `fixtures/mw-effect.json` —— 含 MW 词源与释义原文（仅 spike 产出，无代码读取）
- `fixtures/cam-affect.json` —— 含剑桥释义片段（仅 spike 产出，无代码读取）

所以刚克隆下来的仓库里，解析相关的测试会显示为 **skipped**（跳过原因会写明缺哪个文件）。补齐一次即可：

```bash
npm run spike     # 重新抓取官方页面与 MW 原始返回（需要联网 + MW key）
npm test          # 之后即可全量通过
```

其余 `fixtures/*.json` 是体积极小的解析结果摘要，仍然随仓库提供。

---

## 已知限制

- **复习背面按「区块」折叠**，不是严格按词性切分。因为正文由 LLM 生成，
  并未按词性打标；因此「延伸义与词族 / 易混词辨析 / 词源与构词」整体折叠，
  并额外提示「该词还有其他词性」。
- **固定搭配**取自 OALD 词条页免费渲染的官方片段。
  完整的 Oxford Collocations Dictionary 页面需要访问码（付费），因此未使用。
- OALD 上的词级 CEFR 徽章并非每个词条都有；没有就**不显示**，不会用别处的等级冒充。
- `extra_examples`（折叠的额外例句）需要二次请求，v1 未取。
- 首次查一个词约 5–8 秒（含抓取 + 生成），在 PRD 的 10 秒预算内。

## 验收结果

| 范围 | 结果 |
|---|---|
| 单元测试 | **165 / 165 通过** |
| v1（PRD §7.1） | **9 / 9 通过**（实测 7.9s ≤ 10s） |
| v2（PRD §7.2） | **4 / 4 通过** |
