---
title: 用 R2 + 阿里云 CDN 搭一个图床
published: 2026-11-05 16:20:00
description: Cloudflare R2 存图、阿里云 CDN 加速，解决 S3 端点被阻断、证书自动续期和图片迁移的问题。
tags: [部署, R2, CDN, 折腾]
category: 折腾
draft: false
pinned: false
---

博客的图片一直和站点放在一起，走博客域名的 CDN。这次把它们拆出来，单独搭了一个图床：

```
https://img.julyrain.top/...  →  阿里云 CDN  →  Cloudflare R2
```

## 为什么用 R2

- 免费额度 10GB 存储，读操作不计费；
- 没有出站流量费（Cloudflare 的卖点）；
- 有 S3 兼容接口，迁移方便；
- 前面套阿里云 CDN，国内访问速度由 CDN 保证。

## 一、创建 R2 桶

Cloudflare 控制台开通 R2 后，用 API 建桶并开启公共访问：

```bash
# 创建桶
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"name":"blog-images"}'

# 开启 r2.dev 公共域名
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets/blog-images/domains/managed" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"enabled":true}'
```

拿到的公共域名是 `pub-xxxxxxxx.r2.dev`，这个地址可以直接读，**但写入不行**。

## 二、S3 端点被阻断的问题

R2 的 S3 端点是：

```
https://<account_id>.r2.cloudflarestorage.com
```

实测从国内（本机和服务器都试了）建立 TLS 连接时直接收到 `handshake failure`（alert 40），而 `pub-xxx.r2.dev` 却可以正常访问——说明是这个域名的 SNI 被拦了，不是 Cloudflare 整体不可用。

于是上传不能走 S3 SDK，改走 **Cloudflare API**：

```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/{bucket}/objects/{key}
```

这个接口支持直接 PUT 对象内容，返回 size/etag，读、删、列也都有对应接口。`api.cloudflare.com` 国内可以访问，问题解决。

封装成了脚本 `scripts/r2.mjs`：

```bash
node scripts/r2.mjs put ./photo.webp blog/photo.webp image/webp
# 自动刷新 CDN
```

## 三、阿里云 CDN

新增域名 `img.julyrain.top`，源站指向 `pub-xxx.r2.dev`，需要配三件事：

1. **回源 Host**：`set_req_host_header` → `pub-xxx.r2.dev`；
2. **回源协议**：`forward_scheme` → `https`，端口 443；
3. **回源 SNI**：`https_origin_sni` → `pub-xxx.r2.dev`。

用 API 一次配好：

```bash
BatchSetCdnDomainConfig
  DomainNames=img.julyrain.top
  Functions=[
    {"functionName":"set_req_host_header","functionArgs":[{"argName":"domain_name","argValue":"pub-xxx.r2.dev"}]},
    {"functionName":"forward_scheme","functionArgs":[{"argName":"enable","argValue":"on"},{"argName":"scheme_origin","argValue":"https"},{"argName":"scheme_origin_port","argValue":"443"}]},
    {"functionName":"https_origin_sni","functionArgs":[{"argName":"enabled","argValue":"on"},{"argName":"https_origin_sni","argValue":"pub-xxx.r2.dev"}]}
  ]
```

再加一条缓存规则，图片缓存 30 天：

```json
{"functionName":"filetype_based_ttl_set","functionArgs":[
  {"argName":"ttl","argValue":"2592000"},
  {"argName":"file_type","argValue":"png,jpg,jpeg,webp,avif,gif,svg,ico"},
  {"argName":"weight","argValue":"30"}
]}
```

最后在 DNS 里把 `img` 解析到 CDN 分配的 CNAME（`img.julyrain.top.w.kunlunaq.com`）即可。

## 四、证书与自动续期

CDN 需要自己的证书。这里用 Let's Encrypt，签发时通过 **DNS-01** 验证（因为域名已经 CNAME 到 CDN，HTTP-01 走不通了）。

certbot 的 manual 钩子调用火山引擎 DNS API，动态添加/删除 `_acme-challenge.img` 的 TXT 记录：

```bash
certbot certonly --manual --preferred-challenges dns \
  --manual-auth-hook /usr/local/bin/volc-acme-add.sh \
  --manual-cleanup-hook /usr/local/bin/volc-acme-del.sh \
  -d img.julyrain.top
```

钩子做三件事：

1. 调 `CreateRecord` 写入 TXT；
2. **轮询权威 DNS 直到 TXT 真正可见**（火山引擎新记录有 1～2 分钟延迟，这点很关键）；
3. 验证通过后删除 TXT。

续期配置会自动写成：

```
authenticator = manual
pref_challs = dns-01,
manual_auth_hook = /usr/local/bin/volc-acme-add.sh
manual_cleanup_hook = /usr/local/bin/volc-acme-del.sh
```

之后 `certbot renew` 就能全自动，不用再管证书。

## 五、把博客图片迁过去

博客里的图片原来都在 `public/images/`，一共 5 个文件。用脚本批量上传到 R2 的 `blog/images/...`，再把 Markdown 里的 `/images/...` 替换成 `https://img.julyrain.top/blog/images/...`，最后删掉本地目录。

上传时顺带刷新 CDN，避免同名文件被旧缓存挡住。

## 六、日常使用

```bash
# 上传一张图（自动刷新 CDN）
node scripts/r2.mjs put ./screenshot.png blog/2026/screenshot.png image/png

# 列表
node scripts/r2.mjs list blog/

# 删除
node scripts/r2.mjs delete blog/2026/screenshot.png
```

访问地址：

```
https://img.julyrain.top/blog/2026/screenshot.png
```

## 几个坑

1. **S3 端点不可用**：不要在服务器上用 s3cmd/rclone 直连 R2，会卡在 TLS；走 Cloudflare API。
2. **DNS 传播延迟**：火山引擎新建记录后，权威 DNS 可能要 1～2 分钟才返回，证书钩子里必须轮询等待。
3. **证书名重复**：给 CDN 上传证书时 `CertName` 不能重名，续期后要用新名字（比如加日期后缀）。
4. **缓存刷新**：替换同名图片后必须刷新 CDN，否则 30 天缓存会一直返回旧图。
5. **流量计费**：阿里云 CDN 按流量计费，建议设个封顶。

## 小结

R2 负责存，CDN 负责快，脚本负责自动化。现在博客里的图片已经全部走 `img.julyrain.top`，上传一条命令搞定，证书也能自动续期。
