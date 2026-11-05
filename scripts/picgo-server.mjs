#!/usr/bin/env node
/**
 * PicGo 本地上传服务
 *
 * 配合 PicGo 的 web-uploader 插件：
 *   API 地址: http://127.0.0.1:36678/upload
 *   POST 参数名: image
 *   jsonPath: url
 *
 * 启动：node scripts/picgo-server.mjs
 */
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(projectRoot, ".env.local");
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}

const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const token = env.CLOUDFLARE_API_TOKEN;
const bucket = env.R2_BUCKET || "blog-images";
const publicDomain = env.R2_PUBLIC_DOMAIN;
const cdnDomain = env.IMG_CDN_DOMAIN || "img.julyrain.top";
const port = Number(process.env.PICGO_PORT || 36678);

if (!accountId || !token || !publicDomain) {
  console.error("缺少 R2 配置（.env.local）");
  process.exit(1);
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const types = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, delimiter);
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    if (!/name="image"/.test(headerText) || !/filename="[^"]*"/.test(headerText)) continue;
    let content = part.subarray(headerEnd + 4);
    // 去掉结尾的 \r\n
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
      content = content.subarray(0, content.length - 2);
    }
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    return { data: content, contentType: typeMatch ? typeMatch[1].trim() : "" };
  }
  return null;
}

async function refreshCdn(key) {
  const ak = env.ALIYUN_ACCESS_KEY_ID;
  const sk = env.ALIYUN_ACCESS_KEY_SECRET;
  if (!ak || !sk) return;
  const encode = (v) =>
    encodeURIComponent(String(v))
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, "%20");
  const params = {
    Action: "RefreshObjectCaches",
    Version: "2018-05-10",
    Format: "JSON",
    AccessKeyId: ak,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ObjectType: "File",
    ObjectPath: `https://${cdnDomain}/${key}`,
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join("&");
  const sig = crypto.createHmac("sha1", `${sk}&`).update(`GET&%2F&${encode(query)}`).digest("base64");
  await fetch(`https://cdn.aliyuncs.com/?${query}&Signature=${encode(sig)}`).catch(() => {});
}

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
  };

  if (req.method === "GET" && req.url === "/health") {
    send(200, { status: "ok" });
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/upload")) {
    send(404, { success: false, message: "not found" });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = Buffer.concat(chunks);
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers["content-type"] || "");
      if (!boundaryMatch) return send(400, { success: false, message: "missing boundary" });
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const file = parseMultipart(body, boundary);
      if (!file || file.data.length === 0) return send(400, { success: false, message: "no image field" });

      const contentType = file.contentType || "image/png";
      const ext =
        Object.keys(types).find((e) => types[e] === contentType) ||
        (contentType.includes("jpeg") ? ".jpg" : contentType.includes("webp") ? ".webp" : ".png");
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const key = `blog/${yyyy}/${mm}/${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`;

      const upload = await fetch(`${apiBase}/${key}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        body: file.data,
      });
      const json = await upload.json();
      if (!json.success) throw new Error(JSON.stringify(json.errors));

      await refreshCdn(key);
      send(200, { success: true, url: `https://${cdnDomain}/${key}`, key });
      console.log(`uploaded ${key} (${file.data.length} bytes)`);
    } catch (error) {
      console.error(error.message);
      send(500, { success: false, message: error.message });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PicGo upload server: http://127.0.0.1:${port}/upload`);
});
