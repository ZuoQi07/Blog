#!/usr/bin/env node
/**
 * certbot DNS-01 hook for Volcengine DNS (julyrain.top)
 *
 * 用法（certbot 自动调用）：
 *   CERTBOT_DOMAIN=img.julyrain.top CERTBOT_VALIDATION=xxx volc-acme-hook.mjs add
 *   volc-acme-hook.mjs del
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

const [AK, SK] = readFileSync("/etc/letsencrypt/volc-credentials", "utf8").trim().split(/\s+/);
const mode = process.argv[2];
const domain = process.env.CERTBOT_DOMAIN || "";
const validation = process.env.CERTBOT_VALIDATION || "";

if (!AK || !SK || !mode || !domain) {
  console.error("missing AK/SK/mode/domain");
  process.exit(1);
}

const parts = domain.split(".");
const zoneName = parts.slice(-2).join(".");
const sub = parts.slice(0, -2).join(".");
const recordHost = `_acme-challenge${sub ? `.${sub}` : ""}`;

const encode = (v) =>
  encodeURIComponent(String(v))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "%20");

async function call(action, params = {}, method = "GET") {
  const body = method === "POST" ? JSON.stringify(params) : "";
  const query = { Action: action, Version: "2018-08-01", ...(method === "GET" ? params : {}) };
  const signed = { ...query, AccessKeyId: AK, SignatureMethod: "HMAC-SHA256", SignatureVersion: "1.0", SignatureNonce: crypto.randomUUID(), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };

  const canonicalQuery = Object.keys(signed)
    .sort()
    .map((k) => `${encode(k)}=${encode(signed[k])}`)
    .join("&");
  const payloadHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = xDate.slice(0, 8);
  const headers = { host: "open.volcengineapi.com", "x-content-sha256": payloadHash, "x-date": xDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const scope = `${date}/cn-north-1/DNS/request`;
  const canonicalRequest = [method, "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["HMAC-SHA256", xDate, scope, crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
  const kDate = crypto.createHmac("sha256", SK).update(date, "utf8").digest();
  const kRegion = crypto.createHmac("sha256", kDate).update("cn-north-1", "utf8").digest();
  const kService = crypto.createHmac("sha256", kRegion).update("DNS", "utf8").digest();
  const kSigning = crypto.createHmac("sha256", kService).update("request", "utf8").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://open.volcengineapi.com/?${canonicalQuery}`, {
    method,
    headers: {
      Host: "open.volcengineapi.com",
      "X-Date": xDate,
      "X-Content-Sha256": payloadHash,
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: method === "POST" ? body : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.ResponseMetadata?.Error) {
    throw new Error(`${action} failed: ${text.slice(0, 300)}`);
  }
  return json;
}

async function zoneId() {
  const res = await call("ListZones", { PageSize: "100", Key: zoneName });
  const zone = (res.Result?.Zones ?? []).find((z) => z.ZoneName === zoneName);
  if (!zone) throw new Error(`zone not found: ${zoneName}`);
  return Number(zone.ZID);
}

if (mode === "add") {
  const zid = await zoneId();
  await call("CreateRecord", { ZID: zid, Host: recordHost, Type: "TXT", Value: validation }, "POST");
  console.log(`added TXT ${recordHost} = ${validation.slice(0, 12)}...`);

  // 等待权威 DNS 真正返回该 TXT（火山引擎新记录有 1～2 分钟延迟）
  const fqdn = `${recordHost}.${zoneName}`;
  const nsNames = await dns.resolveNs(zoneName).catch(() => []);
  const nsIps = [];
  for (const ns of nsNames) {
    try {
      nsIps.push(...(await dns.resolve4(ns)));
    } catch {
      /* ignore */
    }
  }
  const resolver = new dns.Resolver();
  if (nsIps.length > 0) resolver.setServers(nsIps);

  const deadline = Date.now() + 240000;
  let visible = false;
  while (Date.now() < deadline) {
    try {
      const records = await resolver.resolveTxt(fqdn);
      if (records.some((parts) => parts.join("") === validation)) {
        visible = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!visible) throw new Error("TXT record did not appear on authoritative DNS in time");
  console.log("TXT visible on authoritative DNS");

  // 再等公共递归 DNS 也看到它，避免 Let's Encrypt 的解析器还在负缓存里
  const pub = new dns.Resolver();
  pub.setServers(["1.1.1.1", "8.8.8.8"]);
  const pubDeadline = Date.now() + 300000;
  let networkErrors = 0;
  while (Date.now() < pubDeadline) {
    try {
      const records = await pub.resolveTxt(fqdn);
      if (records.some((parts) => parts.join("") === validation)) {
        console.log("TXT visible on public DNS");
        break;
      }
    } catch (error) {
      if (error.code === "ECONNREFUSED" || error.code === "ETIMEOUT" || error.code === "ESERVFAIL") {
        networkErrors += 1;
        if (networkErrors > 6) {
          console.log("public resolver unreachable, skip public wait");
          break;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
} else if (mode === "del") {
  const zid = await zoneId();
  const listing = await call("ListRecords", { ZID: String(zid), PageSize: "100" });
  const matches = (listing.Result?.Records ?? []).filter(
    (r) => r.Host === recordHost && r.Type === "TXT" && (!validation || r.Value === validation),
  );
  for (const record of matches) {
    await call("DeleteRecord", { ZID: zid, RecordID: String(record.RecordID) }, "POST");
  }
  console.log(`deleted ${matches.length} TXT record(s)`);
} else {
  console.error("usage: add|del");
  process.exit(1);
}
