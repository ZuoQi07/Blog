#!/usr/bin/env node
/**
 * 提交 URL 到 IndexNow（Bing / Yandex 等）
 *
 * 用法：
 *   node scripts/indexnow.mjs            # 提交 sitemap 中的全部 URL
 *   node scripts/indexnow.mjs <url...>   # 只提交指定 URL
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const site = process.env.INDEXNOW_SITE || "https://blog.julyrain.top";
const host = new URL(site).host;

const publicDir = path.join(projectRoot, "public");
const keyFile = readdirSync(publicDir).find((name) => /^[a-f0-9]{32}\.txt$/.test(name));
if (!keyFile) {
  console.error("找不到 IndexNow key 文件（public/<32位hex>.txt）");
  process.exit(1);
}
const key = readFileSync(path.join(publicDir, keyFile), "utf8").trim();
const keyLocation = `${site}/${keyFile}`;

async function sitemapUrls() {
  const index = await fetch(`${site}/sitemap-index.xml`).then((r) => r.text());
  const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const map of maps) {
    const xml = await fetch(map).then((r) => r.text());
    urls.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  return [...new Set(urls)];
}

const args = process.argv.slice(2);
const urlList = args.length > 0 ? args : await sitemapUrls();

if (urlList.length === 0) {
  console.log("没有可提交的 URL");
  process.exit(0);
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, keyLocation, urlList: urlList.slice(0, 10000) }),
});

console.log(`IndexNow: HTTP ${res.status}，提交 ${urlList.length} 个 URL`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 300));
  process.exit(1);
}
