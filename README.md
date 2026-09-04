# 纪念簿

本地运行的纪念日提醒 H5 页面，数据保存在同目录的 SQLite 文件 `anniversaries.db`。

```powershell
pip install -r requirements.txt
python server.py
```

打开 `http://127.0.0.1:5178`。

功能包括：用户名自动创建与 token 会话、按用户隔离数据和推送配置、公历/农历纪念日、仅一次/每年/每月/每日重复、秒级倒计时/纪念总时长、提前提醒、每日或限次提醒、企业微信机器人 Webhook 推送与本地 SQLite 持久化。

升级前已有的示例数据归属在用户名 `默认用户` 下。用户名登录没有密码，只用于本地数据分区，不应视为强身份认证。

## PWA 系统通知

首次启动会在项目根目录生成 `vapid_private.pem`。该文件是 Web Push 身份密钥，部署后必须备份并长期保留；更换或丢失后，已经订阅通知的设备需要重新开启通知。

iOS 16.4 及以上需要使用 Safari 将 HTTPS 页面添加到主屏幕，再从桌面图标进入并点击“开启系统通知”。普通局域网 HTTP 地址不能申请 Web Push 权限。

生产部署建议由 Caddy 或 Nginx 提供 HTTPS，并反向代理到本服务。监听参数可以通过环境变量配置：

```powershell
$env:APP_HOST = "0.0.0.0"
$env:APP_PORT = "5178"
$env:VAPID_SUBJECT = "mailto:your-email@example.com"
python server.py
```

页面开放到公网前，应给用户名登录增加密码、一次性访问码或设备绑定机制。
