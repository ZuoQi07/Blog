#!/usr/bin/env node
/**
 * 火山引擎云解析（DNS）小工具
 *
 * 用法：
 *   node scripts/volc-dns.mjs zones
 *   node scripts/volc-dns.mjs records <域名>
 *   node scripts/volc-dns.mjs add-a <域名> <主机记录> <IP>
 *
 * 凭据读取 .env.local 的 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY
 */
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
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

const AK = process.env.VOLC_ACCESS_KEY_ID || env.VOLC_ACCESS_KEY_ID;
const RAW_SK = process.env.VOLC_SECRET_ACCESS_KEY || env.VOLC_SECRET_ACCESS_KEY;
const SK_CANDIDATES = [RAW_SK, Buffer.from(RAW_SK || "", "base64").toString("utf8")].filter(Boolean);

const HOST = "open.volcengineapi.com";
const REGION = "cn-north-1";
const SERVICE = "DNS";
const VERSION = process.env.VOLC_DNS_VERSION || "2018-08-01";

const encode = (value) =>
  encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "%20");

const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (key, text) => crypto.createHmac("sha256", key).update(text, "utf8").digest();

function buildRequest(secret, method, query, body) {
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = xDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${encode(key)}=${encode(query[key])}`)
    .join("&");

  const headers = {
    host: HOST,
    "x-content-sha256": payloadHash,
    "x-date": xDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");

  const canonicalRequest = [method, "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kSigning = hmac(hmac(hmac(hmac(secret, date), REGION), SERVICE), "request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${HOST}/?${canonicalQuery}`,
    headers: {
      Host: HOST,
      "X-Date": xDate,
      "X-Content-Sha256": payloadHash,
      "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function call(action, params = {}, method = "GET") {
  const query = { Action: action, Version: VERSION };
  const body = method === "POST" ? JSON.stringify(params) : "";
  if (method === "GET") Object.assign(query, params);
  else Object.assign(query, params.__query || {});

  let lastError;
  for (const secret of SK_CANDIDATES) {
    const { url, headers } = buildRequest(secret, method, query, body);
    const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok || parsed?.ResponseMetadata?.Error) {
      lastError = { status: res.status, body: parsed };
      continue;
    }
    return parsed;
  }
  throw new Error(`火山引擎 API 调用失败：${JSON.stringify(lastError)}`);
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "zones") {
    const body = await call("ListZones", { PageSize: "100" });
    console.log(JSON.stringify(body.Result ?? body, null, 2));
  } else if (command === "records") {
    const zoneName = args[0];
    const zones = await call("ListZones", { PageSize: "100", Key: zoneName });
    const zone = (zones.Result?.Zones ?? []).find((z) => z.ZoneName === zoneName);
    if (!zone) throw new Error(`没有找到域名 ${zoneName}`);
    const body = await call("ListRecords", { ZID: String(zone.ZID), PageSize: "100" });
    console.log(JSON.stringify(body.Result ?? body, null, 2));
  } else if (command === "add-a") {
    const [zoneName, host, ip] = args;
    const zones = await call("ListZones", { PageSize: "100", Key: zoneName });
    const zone = (zones.Result?.Zones ?? []).find((z) => z.ZoneName === zoneName);
    if (!zone) throw new Error(`没有找到域名 ${zoneName}`);
    const body = await call(
      "CreateRecord",
      { ZID: Number(zone.ZID), Host: host, Type: "A", Value: ip },
      "POST",
    );
    console.log(JSON.stringify(body.Result ?? body, null, 2));
  } else {
    console.log("用法: zones | records <域名> | add-a <域名> <主机记录> <IP>");
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
