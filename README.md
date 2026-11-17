# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

### 按来源版式适配（layout rules）

通用链接提取不再替所有来源决定页面里哪一块算文章列表。每个来源可以维护自己的版式规则，规则按版本管理，且只影响该来源；未启用规则的来源继续使用旧版整页通用提取，接口默认行为保持不变。

规则字段：`ruleId`（来源内唯一）、`containerSelector`（文章区域，支持单个 `tag`、`#id`、`.class` 或 `tag#id`/`tag.class` 组合）、可选 `itemSelector`（区域内重复的文章块）、可选 `linkPattern`（区域内链接的正则白名单）、可选 `minimumItems`（该规则自己的可用条目质量水位，缺省回落到来源的 `minimumItems`）、可选 `note`。

- `POST /v1/feeds/:feedId/layout-rules`：登记一条 `candidate` 候选规则，返回自增修订号；候选规则在激活前不影响任何采集。
- `GET /v1/feeds/:feedId/layout-rules`：列出该来源全部规则修订及其状态（`candidate`/`active`/`withdrawn`）。
- `POST /v1/feeds/:feedId/layout-rules/preview`：请求体为 `{ "rule": {…候选规则…}, "html": "…样本页面…" }`，对未入库的临时规则做离线试跑，返回区域是否命中、候选/规范化数量、是否达到水位和样例链接，不写任何采集记录。
- `POST /v1/feeds/:feedId/layout-rules/:ruleId/preview`：用已登记规则对提交的 HTML 页面（纯文本请求体）试跑。
- `POST /v1/feeds/:feedId/layout-rules/:ruleId/activate`：激活指定候选修订，同时把该来源原活动规则置为 `withdrawn`；其他来源不受影响。
- `POST /v1/feeds/:feedId/layout-rules/active`（或 `…/:ruleId/deactivate`）：撤回活动规则，使该来源回到旧版 `legacy-default` 通用提取。

被撤回的修订保持不可变；需要重新启用时登记一条新的候选修订再激活。每次采集（含刷新）的返回和 `runs` 记录都会写明实际采用的 `ruleId`、`ruleRevision`、该次生效的 `minimumItems` 以及提取器状态（`legacy`/`rule_matched`/`rule_unmatched`）。当规则在页面上找不到配置区域，或区域内没有可用文章链接时，采集以可解释原因（如 `layout_container_not_found:#card-feed`、`layout_no_article_links:…`）拒绝，而不会悄悄回退到整页提取、把导航栏当成完整列表。

刷新在发起请求前就冻结当时的规则修订与其质量水位；响应返回前即使运营切换或撤回规则，这份响应仍按冻结时的同一配置解释，不会混用两个版本的候选数量或质量水位。


抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试：`fixtures/rolling-feed.html` 是旧版滚动目录版式，`fixtures/card-feed.html` 是带导航栏的新版卡片目录版式（用于验证按来源版式规则只提取卡片区域）。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
