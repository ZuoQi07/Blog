---
title: 在服务器上搭一个 WebDAV：nginx + Apache 的组合方案
published: 2026-11-05 14:15:00
description: 用 nginx 做 TLS 和 Basic Auth、Apache mod_dav 做 WebDAV 后端，在自有服务器上搭一个能列目录、能读写的 WebDAV 服务，附完整配置和踩坑记录。
tags: [部署, WebDAV, 自托管, 折腾]
category: 折腾
draft: false
pinned: false
---

手机上拍的照片、电脑里随手存的文档，想在设备之间同步，又不想把文件交给网盘。WebDAV 是个很合适的选择：协议通用，Windows、macOS、手机上的文件管理器、rclone 都原生支持，服务端也不复杂。

这次在服务器上加了一个 WebDAV 服务：**<https://dav.julyrain.top>**。

## 方案：nginx 在前，Apache 在后

一开始想直接用 nginx 的 `dav` 模块，但很快发现不行：nginx 自带的 `ngx_http_dav_module` 只支持 `PUT`、`DELETE`、`MKCOL`、`COPY`、`MOVE`，**不支持 `PROPFIND`**——而几乎所有 WebDAV 客户端都靠 `PROPFIND` 列目录。实测请求会返回 405。

完整的 WebDAV 需要 `nginx-dav-ext-module`，得自己编译 nginx；另一个选择是 Apache 的 `mod_dav`，功能完整，还能处理 `LOCK`（Windows 映射网络驱动器会用到）。

于是最终结构是：

```
客户端 --HTTPS--> nginx (TLS + Basic Auth + 反代) --> Apache mod_dav (127.0.0.1:8081) --> /srv/webdav
```

这样既不用额外跑 Docker 容器（省内存），又能拿到完整的 WebDAV 能力。

## 一、域名

给域名加一条 A 记录：

```
dav.julyrain.top  A  <服务器IP>
```

还是用之前的火山引擎 DNS 脚本：

```bash
node scripts/volc-dns.mjs add-a julyrain.top dav <服务器IP>
```

## 二、Apache 后端

安装并启用模块：

```bash
sudo apt install -y apache2
sudo a2enmod dav dav_fs
sudo a2dissite 000-default default-ssl
```

**关键一步**：Apache 默认会监听 80 端口，和 nginx 冲突。把它改成只监听本机：

```apache
# /etc/apache2/ports.conf
Listen 127.0.0.1:8081
```

新建 WebDAV 站点：

```apache
<VirtualHost 127.0.0.1:8081>
    ServerName dav.julyrain.top
    DocumentRoot /srv/webdav

    <Directory /srv/webdav>
        Options Indexes FollowSymLinks
        AllowOverride None
        Require all granted
        Dav On
    </Directory>

    DavLockDB /var/lib/dav/lockdb
    ErrorLog ${APACHE_LOG_DIR}/webdav-error.log
    CustomLog ${APACHE_LOG_DIR}/webdav-access.log combined
</VirtualHost>
```

```bash
sudo a2ensite webdav
sudo mkdir -p /var/lib/dav && sudo chown www-data:www-data /var/lib/dav
sudo apache2ctl configtest
sudo systemctl restart apache2
```

数据目录：

```bash
sudo mkdir -p /srv/webdav
sudo chown www-data:www-data /srv/webdav
sudo chmod 750 /srv/webdav
```

> 注意：Apache 只监听 `127.0.0.1:8081`，外网访问不到，只有 nginx 能转发进来。

## 三、Basic Auth

生成密码文件（apr1 哈希）：

```bash
sudo sh -c 'printf "zuoqi:%s\n" "$(openssl passwd -apr1 "你的密码")" > /etc/nginx/.htpasswd-dav'
sudo chown root:www-data /etc/nginx/.htpasswd-dav
sudo chmod 640 /etc/nginx/.htpasswd-dav
```

## 四、nginx 反向代理

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name dav.julyrain.top;

    client_max_body_size 4g;

    location ~ /\. {
        deny all;
    }

    location / {
        auth_basic "WebDAV";
        auth_basic_user_file /etc/nginx/.htpasswd-dav;

        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

要点：

- `client_max_body_size 4g`：允许传大文件；
- `proxy_request_buffering off`：上传大文件时边收边转发，不先落盘到 nginx 临时目录；
- `location ~ /\.` 拒绝 `.git`、`.env` 这类隐藏文件；
- 认证放在 nginx 层，Apache 只信任本机流量。

然后签证书：

```bash
sudo certbot --nginx -d dav.julyrain.top --redirect
```

## 五、验证

```bash
# 未认证 → 401
curl -I https://dav.julyrain.top/

# 列目录 → 207
curl -u zuoqi:密码 -X PROPFIND -H "Depth: 1" https://dav.julyrain.top/

# 上传 → 201
echo hi > hi.txt
curl -u zuoqi:密码 -T hi.txt https://dav.julyrain.top/hi.txt

# 读取
curl -u zuoqi:密码 https://dav.julyrain.top/hi.txt

# 删除 → 204
curl -u zuoqi:密码 -X DELETE https://dav.julyrain.top/hi.txt
```

实测返回：`401 / 207 / 201 / 204`，HTTP 也会 301 跳到 HTTPS。

## 客户端怎么连

| 设备 | 方式 |
| --- | --- |
| Windows | 资源管理器 → 映射网络驱动器 → `https://dav.julyrain.top/` |
| macOS | Finder → 前往 → 连接服务器 → `https://dav.julyrain.top/` |
| Android | Documents、Solid Explorer、FolderSync 等，选 WebDAV |
| iOS | 文件 App 的「连接服务器」，或 Documents |
| 命令行 | `rclone`、`cadaver`、`curl` |

地址统一是 `https://dav.julyrain.top/`，用户名 `zuoqi`，密码就是上面生成的。

## 安全和限制

- **只开 HTTPS**：HTTP 已 301 跳转，Basic Auth 不会明文传输；
- **单账号**：个人用足够，以后要多人可以改成多行 htpasswd；
- **上传上限 4G**：由 `client_max_body_size` 控制；
- **隐藏文件拒绝**：`location ~ /\.` 直接 403；
- **暴力破解**：Basic Auth 没有验证码，建议配合 fail2ban 对 nginx 的 401 做封禁，或者只在内网/VPN 下使用；
- **备份**：数据都在 `/srv/webdav`，直接 `tar` 这个目录即可。

## 踩到的坑

1. **nginx 的 dav 模块不支持 PROPFIND**：一开始配完发现列目录 405，才意识到需要 Apache 的 `mod_dav`；
2. **Apache 默认抢占 80 端口**：装完必须先改 `ports.conf` 只监听 127.0.0.1，否则和 nginx 冲突；
3. **数据目录权限**：Apache 以 `www-data` 运行，目录属主和权限不对会写不进去；
4. **大文件上传**：记得关掉 `proxy_request_buffering`，否则 nginx 会先把整个文件缓存到本地磁盘。

## 小结

这套组合没有额外容器，只多了 Apache 一个进程（内存几十 MB），但拿到了完整 WebDAV：列目录、上传、下载、移动、锁都支持。

如果你也想自建一个「自己的网盘」，又不想折腾 Nextcloud 那一套，nginx + Apache mod_dav 是很轻的方案。
