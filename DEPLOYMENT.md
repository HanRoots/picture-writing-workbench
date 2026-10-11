# 独立云端部署说明

本项目必须作为独立产品部署，不与 `essay-grading-app` 共用仓库、函数、数据文件、OSS 前缀或浏览器数据库。推荐资源名称：

- GitHub 仓库：`picture-writing-workbench`
- 阿里云 FC Web 函数：`picture-writing-workbench-api`
- 前端地址：`https://hanroots.github.io/picture-writing-workbench/`

## 数据隔离

- 任务、题图、作品图片、原文和结果只存入本项目专属 IndexedDB：`picture-writing-workbench`。
- 登录凭证和客户端编号使用 `picture-writing-workbench-*` 专属浏览器键。
- 所有 API 请求携带 `X-App-Id: picture-writing-workbench-v1`，新后端拒绝其他应用请求。
- 第一版不创建 OSS 数据目录，不读取或写入旧工作台的 `essay-grading/*`。
- GitHub Pages 的不同仓库路径仍属于同一个浏览器域名，因此不能只靠 URL 路径隔离；以上命名和 API 身份校验必须保留。

## 上线前安全要求

此前用于本地调试的模型密钥需要先在 DeepSeek 和 Kimi 控制台轮换。新密钥只配置到 FC 环境变量，不能写入仓库、GitHub Pages 或 `runtime-config.js`。

FC 环境变量至少包括：

```bash
HOST=0.0.0.0
PORT=9000
APP_USERNAME=teacher
APP_PASSWORD=请设置本项目专用强密码
REQUIRE_APP_PASSWORD=1
REQUIRE_MODEL_KEYS=1
CORS_ALLOWED_ORIGINS=https://hanroots.github.io
MOONSHOT_API_KEY=新密钥
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_VISION_MODEL=kimi-k2.6
DEEPSEEK_API_KEY=新密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_TEXT_MODEL=deepseek-flash
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
OCR_MAX_OUTPUT_TOKENS=4096
GRADE_MAX_OUTPUT_TOKENS=4096
CRITERIA_MAX_OUTPUT_TOKENS=2048
```

## 生成 FC 部署包

```bash
npm run package:fc
```

部署包输出到 `dist/picture-writing-workbench-fc.zip`，包内不含 `.env`、模型密钥、浏览器数据或前端图片。

FC 建议配置：

- Node.js 20 Web 函数
- 启动命令：`npm run start:fc`
- 监听端口：`9000`
- 内存：`512 MB`
- 超时：`180 秒`
- 单实例并发：`1`
- 最大按量实例数：`1`
- 最小实例数：`0`

以上配置让模型请求串行执行，避免短时间重复扩容和并发费用。FC 本身不保存任务或图片。

部署完成后先检查：

```bash
curl -sS https://你的-fc-地址/api/health
```

返回结果应包含 `"appId":"picture-writing-workbench-v1"`、`"authRequired":true` 和 `"mode":"hybrid"`。

## 发布 GitHub Pages

1. 创建独立仓库 `picture-writing-workbench`。
2. 在仓库 Settings → Pages 中选择 GitHub Actions。
3. 在 Settings → Secrets and variables → Actions → Variables 中新增：
   - 名称：`VITE_API_BASE_URL`
   - 值：新的 FC HTTPS 地址，不要带末尾 `/`。
4. 推送 `main` 或 `master` 分支，`.github/workflows/deploy-pages.yml` 会自动构建和发布。

前端构建只写入公开的 FC 地址，不包含任何模型密钥或访问密码。

## 费用控制

- GitHub Pages 承载全部静态文件，不消耗 FC 静态页面流量和执行时长。
- FC 最小实例数为 0，没人使用时不保留常驻实例。
- 最大实例数和单实例并发均为 1，避免批量并发放大模型费用。
- 浏览器会把超大图片保守压缩到最长边不超过 3200px、JPEG 质量 0.92；小图保持原文件，兼顾 OCR 清晰度。
- 题图最多 8 张，每份学生作品最多 12 张。
- 识图、OCR 和批改只由老师主动操作触发，不做后台轮询。
- 后端设置每分钟调用上限，并限制模型最大输出长度。
- 不使用 OSS、不生成云端任务副本，因此没有任务图片长期存储和 OSS 请求费用。

## 第一版限制

- 数据不跨设备同步；每台设备、每个浏览器拥有独立任务数据。
- 清除站点数据会删除该浏览器中的任务。
- 如果以后需要跨设备同步，应为本项目创建独立 Bucket 或至少独立的 `picture-writing-workbench/*` 前缀和独立状态文件，禁止复用旧工作台的 `essay-grading/*`。
