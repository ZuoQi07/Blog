---
title: 把 Live-QR 部署到自己的服务器：扫码即传的实时二维码
published: 2026-11-04 01:30:00
description: 在自有服务器上用 Docker 部署 Live-QR 实时二维码系统：手机扫码上传文本，观看端实时重绘二维码，附带 nginx 反代、HTTPS 与踩坑记录。
tags: [部署, Docker, 自托管, 折腾]
category: 折腾
draft: false
pinned: false
---

逛 GitHub 时看到一个很有意思的小工具：**Live-QR**。它解决的问题很具体——手机扫了一个二维码，想把里面的内容弄到电脑上，通常要复制、发文件、或者手动输入。Live-QR 让手机当扫描器，电脑当显示器：手机扫码后，文本经服务器实时推送到观看端，观看端立刻重绘成二维码。

项目地址：<https://github.com/Dynesshely/Live-QR>，协议 AGPL-3.0。

我把它部署到了自己的服务器：**<https://qr.julyrain.top>**。

![Live-QR 首页](/images/posts/live-qr/screenshot.png)

## 它是什么

- **上传端**：手机浏览器打开网站，调用摄像头扫描二维码，用 `jsQR` 解码成文本，通过 `POST /api/upload` 发给服务器；
- **观看端**：输入 8 位分享码，建立 WebSocket 连接，实时接收文本并用 `qrcode` 重新渲染成二维码；
- **服务器**：Node.js 22 + Express 5 + `ws`，纯内存存储（`Map<string, ChannelState>`），没有数据库。

适合的场景：把手机里的链接、配置、一段文字快速“投”到电脑屏幕上，或者反过来把电脑上的内容变成二维码给手机扫。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 后端 | Node.js 22 + Express 5 + `ws` |
| 前端 | Vue 3 + Vite 6 + Tailwind CSS 4 |
| 二维码 | jsQR（解码）+ qrcode（生成） |
| 反代 | Caddy（安全头 + 压缩） |
| 容器 | Docker 三阶段构建，Node 22 Alpine + Caddy + tini，非 root（uid 10001） |
| 存储 | 纯内存 + 磁盘审计日志 |

## 部署过程

### 1. 域名

给我的域名加了一条 A 记录：

```
qr.julyrain.top  A  121.199.9.157
```

还是用之前的火山引擎 DNS 脚本（`node scripts/volc-dns.mjs add-a julyrain.top qr 121.199.9.157`），几秒钟就生效了。

### 2. 把代码弄上服务器

服务器访问 GitHub 不太稳定，所以没有直接在服务器上 `git clone`，而是本地克隆后打包上传：

```bash
git clone --depth 1 https://github.com/Dynesshely/Live-QR.git
tar -czf live-qr.tar.gz Live-QR
scp live-qr.tar.gz zuoqi@server:/tmp/
```

然后在服务器上解压到 `/opt/Live-QR`。

### 3. Docker 构建

项目自带 `docker-compose.yml`，默认宿主机 `41606` → 容器 `80`：

```bash
cd /opt/Live-QR
sudo docker compose up -d --build
```

这一步在 1.6G 内存的小机器上**非常慢**，构建期间 SSH 一度卡在 banner 交换阶段，负载飙到 13，等了二十多分钟才恢复。如果机器内存小，建议先加 swap，或者本地构建好镜像再传上去。

### 4. 踩坑：CRLF 让容器起不来

构建完成后容器一直 `Restarting (127)`，日志是：

```
[FATAL tini] exec /entrypoint.sh failed: No such file or directory
```

查了一下 `entrypoint.sh`，发现是 Windows 下克隆的文件带了 CRLF：

```
#!/bin/sh^M$
```

`/bin/sh\r` 找不到，于是 exec 失败。解决很简单：

```bash
sudo sed -i 's/\r$//' entrypoint.sh Caddyfile Dockerfile docker-compose.yml
sudo docker compose up -d --build
```

Linux 上直接 clone 不会有这个问题，只有从 Windows 打包上传才会踩到。

### 5. nginx 反代 + HTTPS

容器内的 Caddy 只监听 80，TLS 交给外层。我加了一个 nginx 站点，重点是 `/ws` 要带 WebSocket 升级头：

```nginx
server {
    listen 80;
    server_name qr.julyrain.top;

    location /ws {
        proxy_pass http://127.0.0.1:41606;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:41606;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

然后 `certbot --nginx -d qr.julyrain.top` 签发证书并自动加 301 跳转。

## 验证

```bash
curl https://qr.julyrain.top/api/health
# {"status":"ok"}

curl -X POST https://qr.julyrain.top/api/channel/create
# {"code":201,"data":{"shareCode":"33737310",...}}

curl "https://qr.julyrain.top/api/channel/verify?shareCode=33737310"
# {"code":200,"valid":true,...}
```

WebSocket 握手也验证过，返回 `101 Switching Protocols`。

## 使用方式

1. 手机打开 <https://qr.julyrain.top>，选「我是上传者」，授权摄像头；
2. 扫描一个二维码，页面会显示 8 位分享码；
3. 电脑打开同一个站点，选「我是观看者」，输入分享码；
4. 手机再扫新的二维码，电脑端实时重绘。

## 几个注意事项

- **纯内存存储**：通道内容约 30 分钟无上传自动过期，容器重启就没了；
- **审计日志**：服务端会把上传的明文文本、上传者/观看者 IP 写入磁盘日志，保留 **243 天**（可在 `.env` 调整），所以**不要传密码、验证码、证件号这类敏感信息**；
- **分享码就是访问凭证**：拿到 8 位码的人都能看到内容；
- **合规**：README 里明确写了，公网部署的备案、日志留存、内容审核义务由部署者承担。我这边是个人自用，站点也保留了项目自带的三层合规提示；
- **资源占用**：容器很小，内存几十 MB 级别，主要压力在构建阶段。

## 小结

Live-QR 是个完成度很高的小项目：前端交互顺、后端够用、Docker 打包也规范。部署本身不复杂，真正的坑是「Windows 换行符」和「小内存机器构建」这两个环境问题，和项目代码无关。

现在它跑在 <https://qr.julyrain.top>，感兴趣可以试试扫码投屏的效果。
