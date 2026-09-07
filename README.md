# 纪念簿

纪念日提醒 PWA。生产版本运行在 Cloudflare Workers，静态资源由 Workers Assets 托管，数据保存在 D1，定时提醒由 Cron Trigger 每分钟执行。

功能包括：用户名会话、按用户隔离数据、公历/农历纪念日、一次/每年/每月/每日重复、倒计时与累计天数、企业微信机器人通知、标准 Web Push 和 PWA 离线外壳。

## Cloudflare 部署

环境要求：Node.js 20+、Cloudflare 账号和 Wrangler 登录状态。

```bash
npm install
npx wrangler login
npm run deploy
```

首次部署时，Wrangler 会根据 `DB` binding 自动创建名为 `anniversary` 的 D1 数据库、建立连接，并将资源 ID 回写到本地配置。部署脚本随后自动执行 D1 migration。

最后上传 Web Push 私钥：

```bash
npm run vapid:secret
```

`npm run vapid:secret` 会读取本地 `vapid_private.pem`，只将私钥标量上传到 Cloudflare Secret。该文件和生成的数据导出文件均被 `.gitignore` 排除。`wrangler.jsonc` 中已经配置了与该私钥匹配的公开 VAPID 公钥，因此原域名切换到 Worker 时可以继续使用已有订阅。

默认 Worker 地址为 `https://anniversary.<你的子域>.workers.dev`。也可以在 Cloudflare 控制台的 Worker `Settings > Domains & Routes` 中绑定自定义域名。

## 迁移现有数据

先生成不包含表结构的 D1 数据文件：

```bash
npm run db:export
npx wrangler d1 execute anniversary --remote --file anniversary-data.sql
```

数据文件可能包含用户名、会话摘要、Webhook 和浏览器 Push 订阅，不要提交到 Git。若部署域名发生变化，浏览器的现有 Push 订阅通常需要用户在新域名重新开启通知。

## 本地开发

```bash
npm run vapid:dev
npm run db:migrate:local
npm run dev
```

访问 Wrangler 输出的本地地址。测试与构建检查：

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

新版 `workerd` 需要较新的 glibc；若旧 Linux 服务器无法启动 `wrangler dev`，可在现代开发机、容器或 GitHub Actions 中进行本地运行和部署。

## 配置

`wrangler.jsonc` 中包含以下非敏感变量：

- `APP_TIMEZONE`：业务日期和提醒时间使用的 IANA 时区，默认 `Asia/Shanghai`
- `VAPID_SUBJECT`：Web Push VAPID 联系地址
- `VAPID_PUBLIC_KEY`：允许公开的 P-256 公钥

敏感变量 `VAPID_PRIVATE_KEY` 必须通过 `wrangler secret put` 设置，不能写入配置文件。

当前登录仅按用户名创建会话，没有密码，不适合直接作为多用户公网身份系统。公开部署前应增加访问码，或在 Worker 前启用 Cloudflare Access。

## 旧版 Python 服务

`server.py` 和 `requirements.txt` 暂时保留，仍可使用本地 SQLite 运行旧版：

```bash
pip install -r requirements.txt
python server.py
```
