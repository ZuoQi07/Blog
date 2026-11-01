# 部署说明（一键发布到服务器）

站点是纯静态产物（`dist/`），部署脚本通过 SSH 上传到服务器，按版本目录存放，并用软链 `current` 原子切换，最后重载 nginx。

## 常用命令

```bash
pnpm deploy        # 一键：构建 + 上传 + 切换 + 重载 nginx
pnpm deploy:only   # 只发布当前的 dist/（不重新构建）
pnpm deploy:cert   # DNS 解析生效后，申请/续期 HTTPS 证书
```

部署完成后脚本会带 `Host` 头访问服务器本机做自检，返回 200 才算成功。

## 配置

所有配置在项目根目录的 `.env.local`（已被 `.gitignore` 忽略，不会提交）：

| 变量 | 说明 | 当前值 |
| --- | --- | --- |
| `DEPLOY_HOST` | 服务器 IP / 域名 | `121.199.9.157` |
| `DEPLOY_PORT` | SSH 端口 | `22` |
| `DEPLOY_USER` | SSH 用户 | `root` |
| `DEPLOY_PASSWORD` | SSH 密码（与 `DEPLOY_KEY_PATH` 二选一） | （已配置） |
| `DEPLOY_KEY_PATH` | SSH 私钥路径，推荐用它替代密码 | 空 |
| `DEPLOY_SITE` | 站点主域名，同时作为 nginx 配置文件名 | `blog.julyrain.top` |
| `DEPLOY_DOMAINS` | nginx `server_name`，多个用空格分隔 | `blog.julyrain.top` |
| `DEPLOY_ROOT` | 服务器上的站点根目录 | `/var/www/julyrain.top` |
| `DEPLOY_KEEP_RELEASES` | 保留多少个历史版本（回滚用） | `5` |
| `DEPLOY_EMAIL` | 申请证书用的邮箱 | 空 |

也可以用同名环境变量临时覆盖，例如 `DEPLOY_HOST=1.2.3.4 pnpm deploy`。

## 服务器上的结构

```
/var/www/julyrain.top/
├── releases/
│   ├── 20261101-102227/   # 每次发布一个目录，内容是当时的 dist/
│   └── 20261101-102440/   # 最新（current 指向它）
└── current -> releases/20261101-102440
```

- nginx 配置：`/etc/nginx/sites-available/blog.julyrain.top`（首次部署自动创建；之后每次部署只会同步其中的 `server_name` 行，其余内容不动，certbot 改过的配置也不会被覆盖），软链到 `sites-enabled/`。
- 发布失败时 `current` 仍指向旧版本，站点不会挂。
- 回滚：把 `current` 指回上一个版本再重载即可

```bash
ln -sfn /var/www/julyrain.top/releases/<旧版本> /var/www/julyrain.top/current
systemctl reload nginx
```

## 域名与 HTTPS

站点域名为 `https://blog.julyrain.top`，该域名已接入**阿里云 CDN**（CNAME 到 `*.kunlunaq.com`），CDN 回源到 `121.199.9.157:80`，并把 Host 头传回服务器：

```
浏览器 --HTTPS--> 阿里云 CDN --HTTP--> 121.199.9.157:80 (nginx, server_name blog.julyrain.top)
```

- HTTPS 证书由 CDN 托管，源站只需要监听 80，**不需要**在服务器上跑 certbot。
- 如果以后取消 CDN、让域名直接解析到源站，再执行：填好 `.env.local` 的 `DEPLOY_EMAIL` → `pnpm deploy:cert`（内部调用 `certbot --nginx`，自动加 443 与 301 跳转）。
- CDN 有缓存：发布后如果页面还是旧的，在阿里云 CDN 控制台「刷新预热」里刷新对应 URL 或整个 `/` 目录。本次换站时发现 `https://blog.julyrain.top/robots.txt` 和 `/sitemap.xml` 还缓存着上一个应用（校园失物招领）的页面，需要手动刷新一次。

## 注意

- `wsxy.julyrain.top` 在同一台服务器上运行另一个应用（Docker `stronghold`，监听 127.0.0.1:3000），本次部署**没有改动**它的配置。
- 密码写在 `.env.local` 里只是图方便；更安全的方式是配置 SSH 密钥后改用 `DEPLOY_KEY_PATH`，并删除 `DEPLOY_PASSWORD`。
- 部署依赖系统 `tar`（Windows 10+ 自带）与 Node 22+。
