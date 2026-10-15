# P0 管道验证结论（T0.1–T0.6）

**日期** 2026-10-15 ｜ **方式** 对官方站点真实抓取 + 解析，非推测
**产物** `fixtures/html/*`（原始页面）、`fixtures/*.json`（解析结果）、`test/parser.test.js`（19 个离线用例）

---

## 1 · 结论摘要

| 卡片必需字段 | 实测来源 | 状态 |
|---|---|---|
| 英/美音标 | OALD `.phons_br .phon` / `.phons_n_am .phon` | ✅ |
| 官方音频（英/美） | OALD `.phons_* [data-src-mp3]` | ✅ |
| 词性 | OALD 每页一个词性，页面互链（见 §3） | ✅ |
| 核心释义 | OALD `li.sense > span.def` + `.grammar` + `.labels` | ✅ |
| 例句 | OALD `ul.examples > li .x` | ✅ |
| **固定搭配** | **OALD 免费「Collocations Dictionary」片段，已按类目分组** | ✅ **无需付费页** |
| 熟词僻义 | OALD 义项顺序 + `.labels`（formal 等）+ `.grammar` | ✅ |
| 延伸义与词族 | OALD `wordfamily` / `synonyms` 区块 + `.xrefs[xt=syn]` | ✅ |
| **易混词辨析** | **OALD `which_word` 官方说明**（如「Which Word? affect / effect」） | ✅ **正是 PRD 要的「官方用法说明」** |
| 词源与构词 | OALD `unbox=wordorigin`；MW `et` 补强 | ✅ |
| CEFR / 牛津3000 / OPAL | OALD `.symbols a[href]`（`ox3ksym_a2`、`opal_symbol`） | ✅（CEFR 见 §2） |
| 拼写建议 | OALD `.result-list a.dym-link` | ✅ 两分支都可复现 |
| 近义/反义 | MW Thesaurus `meta.syns`/`meta.ants` | ✅ |

---

## 2 · ⚠️ 重要：CEFR 不能抓，抓了就是编造

页面上唯一的 `class="cefr"` 内容是 **B2**，但它的祖先链是：

```
div.cefr < div.wotd-box.ox_3000 < ...（侧栏）
```

即 **Word of the Day 侧栏**，当时展示的词是 `enhance`，**与 `effect` 无关**。
实测 `#entryContent .cefr` **= 0**。词条内只有 `.topic_cefr`（话题等级 c1/c2，不是词级 CEFR）。

**因此**：`tags.cefr` 对 `effect` 为 `null`，卡片**不显示 CEFR 胶囊**。
真正的 CEFR 只在 OALD 词条自身给出 `.cefr` 时才取（已加 `/^[abc][12]$/` 校验）。
> 这直接纠正了 PRD §2.2 示意线框里的「CEFR B1」——那是示意，不是事实。

---

## 3 · OALD 一词性一页，需互链发现

`effect_1` = **noun**（4 义项），`effect_2` = **verb**（1 义项）。
词条页内含指向 `effect_2` 的链接，因此用 `discoverEntryUrls()` 从页面互链发现**同词其他词性**，
并显式排除 `american_english` / `collocations` / `pronunciation` 等同形 URL（已加测试）。

## 4 · 固定搭配：整页付费，但免费片段够用

- 整页 `/definition/collocations/effect_1`：**HTTP 200 但被付费墙拦截**
  （`.entry-unauthorised`：*"available with an access code"*）
- **但**定义页免费渲染了官方片段，且**结构完整**：`span.unbox`(类目) + `ul.collocs_list > li`

实测 `effect` 拿到 5 个类目：

| 类目 | 条目（示例） |
|---|---|
| adjective | decisive, dramatic, far-reaching, special, cinematic, audio |
| verb + effect | bring about, exert, have |
| effect + verb | exist, occur, spread |
| preposition | in effect, to this effect, to that effect |
| phrases | cause and effect, to little effect, to no effect |

**结论**：**已批准的降级链（MW 惯用短语 → 标「未收录」）暂不触发**，
固定搭配优先用 OALD 官方免费片段；MW 短语作为补强；两者皆无才标「官方词典未收录」。

## 5 · 剑桥（回退源）可用

`affect` 在 OALD **确为 404**（返回拼写建议页，与 PRD 验收项 2 假设一致），
剑桥能解析出 verb + noun、义项 ≥3、英美音标齐全。
注意剑桥同页会重复同一词性块（多词典），解析器按词性去重并保留最完整的一份。

## 6 · 网络与代理

- 抓取前 `applyNetworkMode('direct')` 主动清除 `http_proxy/https_proxy/all_proxy/NODE_USE_ENV_PROXY`
- 实测直连可用：OALD **0.65 s**、effect_2 0.41 s、剑桥 0.86 s
- OALD×2 + 剑桥 全流程 ≈ **2 s**，远低于 G1 的 10 s 预算
- 串行 + 最小间隔 1.2 s 已生效（`throttle`）

## 7 · 待办（进入 v1 时）

- MW `et` 词源文本含 Unicode 引号，做卡片时保持原样即可
- OALD `effect_2` 的音频与 `effect_1` 相同（同词同音，属正常）
- `extra_examples` 区块 body 长度为 0：折叠内容需另一次请求，v1 不做
