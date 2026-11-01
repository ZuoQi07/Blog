# 部署说明（一键发布到服务器 + 同步源码到 GitHub）

站点是纯静态产物（`dist/`），部署脚本通过 SSH 上传到服务器，按版本目录存放，并用软链 `current` 原子切换，最后重载 nginx；服务器部署完成后，再把源码提交并推送到 GitHub。

## 常用命令

```bash
pnpm deploy            # 一键：构建 + 上传 + 切换 + 重载 nginx + 推送源码到 GitHub
pnpm deploy:only       # 只发布当前的 dist/（不重新构建，仍会推送源码）
pnpm deploy:check      # 只做连通性检查：SSH 端口、80 端口、能否登录
pnpm deploy --no-git   # 只部署服务器，跳过 GitHub 同步
pnpm deploy:cert       # DNS 解析生效后，申请/续期 HTTPS 证书
```

部署完成后脚本会带 `Host` 头访问服务器本机做自检，返回 200 才算成功；随后打印 GitHub 提交与推送结果。

## SSH 连不上时

脚本会在上传前先探测端口，失败时直接给出排查方向：

```
✖ 连不上 SSH 端口 121.199.9.157:22（TCP 超时）
  · 80 端口正常，说明服务器还活着，是 SSH 被拦在外层…
```

按这个顺序查：

1. **换网络试一次**（手机热点 / 换 VPN 节点）。能连上 = 本机出口 IP 被拉黑，不是服务器坏了。
2. **服务器上的 fail2ban（本机已经踩过一次）**：`bantime = 1h`、`findtime = 10m`、`maxretry = 5`，10 分钟内 5 次认证失败就封 1 小时。用云助手/VNC 登录后：

   ```bash
   sudo fail2ban-client status sshd          # 看 Banned IP list
   sudo fail2ban-client set sshd unbanip <你的出口 IP>
   sudo fail2ban-client unban --all          # 或全部解封
   ```

   另外注意：短时间反复 `ssh root@…` 试密码、或用 `ssh -o PreferredAuthentications=password` 验证，都会计入失败次数。
3. **阿里云安全组**：22 端口是否对当前出口 IP 开放（宽带/VPN 换 IP 后会被挡）。
4. **云安全中心「暴力破解防御」**：多次认证失败会封禁来源 IP，控制台里能看到并解封。
5. 用 <https://check-host.net> 从其他地区测 `121.199.9.157:22`：外部能连、只有本机连不上，就是 IP 被封。
5. 用 <https://check-host.net> 从其他地区测 `121.199.9.157:22`：外部能连、只有本机连不上，就是 IP 被封。

注意：部署脚本只用密钥认证，不会因为密码错误触发封禁；短期内反复手工 `ssh root@…` 试密码才容易被 fail2ban/云安全中心拉黑。

## 配置

所有配置在项目根目录的 `.env.local`（已被 `.gitignore` 忽略，不会提交）：

| 变量 | 说明 | 当前值 |
| --- | --- | --- |
| `DEPLOY_HOST` | 服务器 IP / 域名 | `121.199.9.157` |
| `DEPLOY_PORT` | SSH 端口 | `22` |
| `DEPLOY_USER` | SSH 用户（普通用户，通过 sudo 提权） | `zuoqi` |
| `DEPLOY_SUDO` | 是否自动加 `sudo -n`；默认非 root 用户开启，`false` 可关闭 | 自动 |
| `DEPLOY_KEY_PATH` | 本机 SSH 私钥路径（服务器已关闭密码登录，必须用密钥） | `C:\Users\17017\.ssh\id_rsa` |
| `DEPLOY_KEY_PASSPHRASE` | 私钥口令（私钥无口令时留空） | 空 |
| `DEPLOY_PASSWORD` | SSH 密码，仅在服务器还开着密码登录时使用 | 已移除 |
| `DEPLOY_SITE` | 站点主域名，同时作为 nginx 配置文件名 | `blog.julyrain.top` |
| `DEPLOY_DOMAINS` | nginx `server_name`，多个用空格分隔 | `blog.julyrain.top` |
| `DEPLOY_ROOT` | 服务器上的站点根目录 | `/var/www/julyrain.top` |
| `DEPLOY_KEEP_RELEASES` | 保留多少个历史版本（回滚用） | `5` |
| `DEPLOY_EMAIL` | 申请证书用的邮箱 | 空 |
| `DEPLOY_GIT_REMOTE` | 源码仓库地址 | `git@github.com:ZuoQi07/Blog.git` |

也可以用同名环境变量临时覆盖，例如 `DEPLOY_HOST=1.2.3.4 pnpm deploy`。

## 同步源码到 GitHub

每次部署成功后，脚本会自动把源码提交并推送到 `git@github.com:ZuoQi07/Blog.git`（`main` 分支）：

- 仓库不存在本地 `.git` 时自动 `git init -b main`；
- `origin` 不存在或地址不一致时自动新增/修正；
- 没有配置提交身份时，使用 `ZuoQi07 <ZuoQi07@users.noreply.github.com>`（可用 `git config user.name/user.email` 改成本地 Git 账号）；
- 有改动才提交，提交信息为 `deploy: 2026-11-01 18:46` 这样的时间戳；没有改动则跳过提交，直接推送；
- 提交内容只有源码：`dist/`、`node_modules/`、`.astro/`、`.env.*`（含密码）、`.astro-paper-backup/`、`.preview/` 都在 `.gitignore` 里，不会被上传。

只想更新服务器、不推送 GitHub 时用 `pnpm deploy --no-git`。

## 服务器上的结构

```
/var/www/julyrain.top/
├── releases/
│   ├── 20261101-102227/   # 每次发布一个目录，内容是当时的 dist/
│   └── 20261101-110317/   # 最新（current 指向它）
└── current -> releases/20261101-110317
```

- nginx 配置：`/etc/nginx/sites-available/blog.julyrain.top`（首次部署自动创建；之后每次部署只会同步其中的 `server_name` 行，其余内容不动，certbot 改过的配置也不会被覆盖），软链到 `sites-enabled/`。
- HTML 响应带 `Cache-Control: no-cache`（`location /` 里），静态资源仍是 `expires 30d` 的强缓存。这样改标题、发新文章后，CDN 只要回源一次就能拿到新内容，不会长时间卡在旧 HTML。
- 发布失败时 `current` 仍指向旧版本，站点不会挂。
- 回滚：把 `current` 指回上一个版本再重载即可

```bash
sudo ln -sfn /var/www/julyrain.top/releases/<旧版本> /var/www/julyrain.top/current
sudo systemctl reload nginx
```

## 域名与 HTTPS

站点域名为 `https://blog.julyrain.top`，该域名已接入**阿里云 CDN**（CNAME 到 `*.kunlunaq.com`），CDN 回源到 `121.199.9.157:80`，并把 Host 头传回服务器：

```
浏览器 --HTTPS--> 阿里云 CDN --HTTP--> 121.199.9.157:80 (nginx, server_name blog.julyrain.top)
```

- HTTPS 证书由 CDN 托管，源站只需要监听 80，**不需要**在服务器上跑 certbot。
- 如果以后取消 CDN、让域名直接解析到源站，再执行：填好 `.env.local` 的 `DEPLOY_EMAIL` → `pnpm deploy:cert`（内部调用 `certbot --nginx`，自动加 443 与 301 跳转）。
- CDN 有缓存：发布后如果页面还是旧的，在阿里云 CDN 控制台「刷新预热」里刷新对应 URL 或整个 `/` 目录。本次换站时发现 `https://blog.julyrain.top/robots.txt` 和 `/sitemap.xml` 还缓存着上一个应用（校园失物招领）的页面，需要手动刷新一次。

## SSH 登录方式

服务器（`121.199.9.157`）已配置为**仅密钥 + 非 root 登录**：

- 普通用户 `zuoqi`（uid 1001），属于 `sudo` 组，`/etc/sudoers.d/zuoqi` 配置了免密 sudo（部署脚本需要非交互提权）；
- 本机公钥 `~/.ssh/id_rsa.pub` 写入 `/home/zuoqi/.ssh/authorized_keys`（`600`，目录 `700`）；
- `/etc/ssh/sshd_config`：`PasswordAuthentication no`、`PermitRootLogin no`（root 不能远程登录）；
- 原配置备份在 `/etc/ssh/sshd_config.bak-20261101105954`（关闭密码登录前）和 `/etc/ssh/sshd_config.bak-rootlogin-<时间戳>`（禁止 root 登录前），需要恢复时覆盖回去并 `systemctl reload ssh`。

登录并提权：

```bash
ssh zuoqi@121.199.9.157
sudo -i                     # 需要 root 时
```

换一台电脑部署时，把新机器的公钥追加到服务器 `/home/zuoqi/.ssh/authorized_keys`（文件 `600`，目录 `700`，属主 `zuoqi`）。

部署脚本以 `zuoqi` 身份连接，只对需要的命令加 `sudo -n`（写 nginx 配置、切换版本软链、`nginx -t`、`systemctl reload nginx`、清理旧版本）。如果服务器改回 root 登录，把 `.env.local` 的 `DEPLOY_USER` 改回 `root` 即可，脚本会自动去掉 sudo。

## 注意

- `wsxy.julyrain.top` 在同一台服务器上运行另一个应用（Docker `stronghold`，监听 127.0.0.1:3000），本次部署**没有改动**它的配置。
- 部署脚本用 `DEPLOY_KEY_PATH` 里的私钥登录，密码登录已关闭；如果私钥没有口令，请妥善保管该文件。
- 部署依赖系统 `tar`（Windows 10+ 自带）与 Node 22+。
