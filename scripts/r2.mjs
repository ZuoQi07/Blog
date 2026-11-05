#!/usr/bin/env node
/**
 * Cloudflare R2 小工具（走 Cloudflare API，不依赖被网络阻断的 S3 端点）
 *
 * 用法：
 *   node scripts/r2.mjs list [前缀]
 *   node scripts/r2.mjs put <本地文件> <对象键> [content-type]
 *   node scripts/r2.mjs get <对象键> <输出文件>
 *   node scripts/r2.mjs delete <对象键>
 *   node scripts/r2.mjs url <对象键>
 *
 * 凭据读取 .env.local：
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 *   R2_BUCKET（默认 blog-images）/ R2_PUBLIC_DOMAIN
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const apiToken = env.CLOUDFLARE_API_TOKEN;
const bucket = process.env.R2_BUCKET || env.R2_BUCKET || "blog-images";
const publicDomain = env.R2_PUBLIC_DOMAIN;

if (!accountId || !apiToken) {
  console.error("缺少 .env.local 的 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}`;

async function api(method, url, body, contentType) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
  });
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "list") {
    const prefix = args[0] || "";
    const res = await api("GET", `${apiBase}/objects?prefix=${encodeURIComponent(prefix)}`);
    const json = await res.json();
    if (!json.success) throw new Error(JSON.stringify(json.errors));
    for (const obj of json.result) {
      console.log(`${obj.key}\t${obj.size}\t${obj.last_modified}`);
    }
  } else if (command === "put") {
    const [file, key, contentType = "application/octet-stream"] = args;
    if (!file || !key) throw new Error("用法: put <本地文件> <对象键> [content-type]");
    const body = readFileSync(file);
    const res = await api("PUT", `${apiBase}/objects/${key}`, body, contentType);
    const json = await res.json();
    if (!json.success) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.errors)}`);
    console.log(`PUT ${key} -> ${json.result.size} bytes, etag ${json.result.etag}`);
  } else if (command === "get") {
    const [key, out] = args;
    if (!key || !out) throw new Error("用法: get <对象键> <输出文件>");
    const res = await api("GET", `${apiBase}/objects/${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`GET ${key} -> ${out}`);
  } else if (command === "delete") {
    const [key] = args;
    if (!key) throw new Error("用法: delete <对象键>");
    const res = await api("DELETE", `${apiBase}/objects/${key}`);
    const json = await res.json();
    if (!json.success) throw new Error(JSON.stringify(json.errors));
    console.log(`DELETE ${key} -> ok`);
  } else if (command === "url") {
    const [key] = args;
    if (!publicDomain) throw new Error("缺少 R2_PUBLIC_DOMAIN");
    console.log(`https://${publicDomain}/${key}`);
  } else {
    console.log("用法: list [前缀] | put <文件> <键> [类型] | get <键> <输出> | delete <键> | url <键>");
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
