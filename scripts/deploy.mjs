#!/usr/bin/env node
/**
 * 一键部署脚本 —— 构建产物发布到服务器，同时把源码提交并推送到 GitHub
 *
 * 用法：
 *   pnpm deploy            # 构建 + 部署到服务器 + 推送源码到 GitHub
 *   pnpm deploy:only       # 只发布当前的 dist/，不重新构建（同样会推送源码）
 *   pnpm deploy --no-git   # 只部署服务器，跳过 GitHub 同步
 *   pnpm deploy:cert       # DNS 生效后申请/续期 HTTPS 证书（certbot --nginx）
 *
 * 配置：读取项目根目录 .env.local（已 gitignore），也可用同名环境变量覆盖
 *   DEPLOY_HOST=121.199.9.157      服务器地址
 *   DEPLOY_PORT=22                 SSH 端口
 *   DEPLOY_USER=root               SSH 用户
 *   DEPLOY_KEY_PATH=...            SSH 私钥路径（推荐，服务器已关闭密码登录）
 *   DEPLOY_KEY_PASSPHRASE=...      私钥口令（可选）
 *   DEPLOY_PASSWORD=...            SSH 密码（仅当服务器还开着密码登录时使用）
 *   DEPLOY_SITE=blog.julyrain.top  站点主域名（同时作为 nginx 配置名）
 *   DEPLOY_DOMAINS="blog.julyrain.top"
 *   DEPLOY_ROOT=/var/www/julyrain.top   服务器上的站点根目录
 *   DEPLOY_KEEP_RELEASES=5         保留多少个历史版本（用于回滚）
 *   DEPLOY_EMAIL=...               申请证书用的邮箱（deploy:cert 需要）
 *   DEPLOY_GIT_REMOTE=git@github.com:ZuoQi07/Blog.git   源码仓库地址
 *
 * 服务器上的目录结构：
 *   $DEPLOY_ROOT/
 *     ├── releases/<时间戳>/     每次发布的完整站点
 *     └── current -> releases/<时间戳>
 */
import { Client } from "ssh2";
import SftpClient from "ssh2-sftp-client";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import net from "node:net";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const wantsCert = process.argv.includes("--cert");
const wantsBuild = process.argv.includes("--build");
const wantsGit = !process.argv.includes("--no-git");
const wantsCheck = process.argv.includes("--check");

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行 */
function loadEnvFile(file) {
  const result = {};
  if (!existsSync(file)) return result;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const env = { ...loadEnvFile(path.join(projectRoot, ".env.local")), ...process.env };

const site = env.DEPLOY_SITE || "julyrain.top";
const cfg = {
  host: env.DEPLOY_HOST,
  port: Number(env.DEPLOY_PORT || 22),
  user: env.DEPLOY_USER || "root",
  password: env.DEPLOY_PASSWORD,
  keyPath: env.DEPLOY_KEY_PATH,
  passphrase: env.DEPLOY_KEY_PASSPHRASE,
  site,
  domains: (env.DEPLOY_DOMAINS || `${site} www.${site}`).split(/\s+/).filter(Boolean),
  root: (env.DEPLOY_ROOT || `/var/www/${site}`).replace(/\/+$/, ""),
  keep: Math.max(1, Number(env.DEPLOY_KEEP_RELEASES || 5)),
  email: env.DEPLOY_EMAIL,
  distDir: path.resolve(projectRoot, env.DEPLOY_DIST || "dist"),
  gitRemote: env.DEPLOY_GIT_REMOTE || "git@github.com:ZuoQi07/Blog.git",
  // 非 root 用户通过 sudo 提权；DEPLOY_SUDO=false 可强制关闭
  sudo: env.DEPLOY_SUDO === "false" ? false : (env.DEPLOY_USER || "root") !== "root",
};

/** 需要 root 权限的命令前面加 sudo -n（免密且不等待输入） */
function rootCmd(command) {
  return cfg.sudo ? `sudo -n ${command}` : command;
}

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function nginxConfig() {
  const serverNames = cfg.domains.join(" ");
  return `# 由 scripts/deploy.mjs 生成的静态博客站点配置（首次部署自动创建，之后不会覆盖）
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};

    root ${cfg.root}/current;
    index index.html;
    charset utf-8;
    client_max_body_size 20m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml application/xml application/javascript application/json application/rss+xml image/svg+xml;

    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }

    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

    location ~* \\.(?:css|js|mjs|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
        try_files $uri =404;
    }

    access_log /var/log/nginx/${cfg.site}.access.log;
    error_log  /var/log/nginx/${cfg.site}.error.log;
}
`;
}

/** 在远端执行命令，返回 { code, stdout, stderr } */
function run(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => (stdout += chunk));
      stream.stderr.on("data", (chunk) => (stderr += chunk));
      stream.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  });
}

/** 在远端执行命令，非 0 退出即抛错 */
async function sh(conn, command, label) {
  const { code, stdout, stderr } = await run(conn, command);
  if (code !== 0) {
    throw new Error(`${label || command} 失败（exit ${code}）\n${stderr || stdout}`.trim());
  }
  return stdout.trim();
}

async function connect(attempts = 3) {
  const options = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    readyTimeout: 30000,
    keepaliveInterval: 10000,
  };
  if (cfg.keyPath) {
    options.privateKey = readFileSync(cfg.keyPath);
    if (cfg.passphrase) options.passphrase = cfg.passphrase;
  } else {
    options.password = cfg.password;
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const conn = new Client();
        conn
          .once("ready", () => resolve(conn))
          .once("error", (err) => reject(new Error(`SSH 连接失败：${err.message}`)))
          .connect(options);
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log(`· SSH 连接失败（第 ${attempt}/${attempts} 次），3 秒后重试…`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  throw lastError;
}

/** 首次部署时创建 nginx 站点配置；已存在则只同步 server_name 行 */
async function ensureNginxSite(conn, sftp) {
  const configPath = `/etc/nginx/sites-available/${cfg.site}`;
  const enabledPath = `/etc/nginx/sites-enabled/${cfg.site}`;
  const serverNames = cfg.domains.join(" ");
  const exists = (await run(conn, `test -f ${configPath} && echo yes || echo no`)).stdout.trim() === "yes";

  if (!exists) {
    const tmp = `/tmp/nginx-${cfg.site}.conf`;
    await sftp.put(Buffer.from(nginxConfig(), "utf8"), tmp);
    await sh(conn, `${rootCmd(`mv ${tmp} ${configPath}`)} && ${rootCmd(`chmod 644 ${configPath}`)}`, "写入 nginx 配置");
    log(`· 已创建 nginx 配置：${configPath}`);
  } else {
    // 已存在的配置（可能被 certbot 改过）只更新 server_name，其余内容保持不动
    const current = (await sftp.get(configPath)).toString("utf8");
    const updated = current.replace(/^(\s*)server_name\s+[^;]+;/gm, `$1server_name ${serverNames};`);
    if (updated !== current) {
      const tmp = `/tmp/nginx-${cfg.site}.conf`;
      await sftp.put(Buffer.from(updated, "utf8"), tmp);
      await sh(
        conn,
        `${rootCmd(`cp ${configPath} ${configPath}.bak`)} && ${rootCmd(`mv ${tmp} ${configPath}`)} && ${rootCmd(`chmod 644 ${configPath}`)}`,
        "更新 nginx 配置",
      );
      const test = await run(conn, rootCmd("nginx -t"));
      if (test.code !== 0) {
        await sh(conn, rootCmd(`mv ${configPath}.bak ${configPath}`), "回滚 nginx 配置");
        throw new Error(`nginx -t 校验失败，已回滚：\n${test.stderr || test.stdout}`);
      }
      log(`· 已更新 server_name → ${serverNames}`);
    } else {
      log(`· nginx 配置已是最新（server_name ${serverNames}）`);
    }
  }

  await sh(conn, rootCmd(`ln -sfn ${configPath} ${enabledPath}`), "启用 nginx 站点");
  const test = await run(conn, rootCmd("nginx -t"));
  if (test.code !== 0) {
    throw new Error(`nginx -t 校验失败，未重载：\n${test.stderr || test.stdout}`);
  }
}

async function pruneOldReleases(conn, timestamp) {
  const listing = await sh(conn, `ls -1dt ${cfg.root}/releases/*/ 2>/dev/null || true`, "列出历史版本");
  const releases = listing
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const stale = releases.slice(cfg.keep);
  for (const dir of stale) {
    if (path.basename(dir) === timestamp) continue;
    await run(conn, rootCmd(`rm -rf ${dir}`));
  }
  return stale.length;
}

/** 调用当前包管理器执行 pnpm build（避免在脚本里写死 pnpm 命令） */
function buildSite() {
  const runner = process.env.npm_execpath;
  const command = runner ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = runner ? [runner, "run", "build"] : ["run", "build"];
  log("▶ 构建站点");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: !runner && process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`构建失败（exit ${code}）`)),
    );
  });
}

/** 探测 TCP 端口是否可连接 */
function probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 连接前先探测端口，失败时给出可操作的排查提示 */
async function preflight() {
  log(`· 检查 ${cfg.host}:${cfg.port} …`);
  if (await probeTcp(cfg.host, cfg.port, 6000)) return true;

  const httpUp = await probeTcp(cfg.host, 80, 6000);
  log("");
  log(`✖ 连不上 SSH 端口 ${cfg.host}:${cfg.port}（TCP 超时）`);
  if (httpUp) {
    log("  · 80 端口正常，说明服务器还活着，是 SSH 被拦在外层，不是脚本或 sshd 的问题：");
    log("    1) 本机出口 IP 被封：换手机热点/VPN 节点再试，能连上就说明是 IP 被拉黑");
    log("    2) 阿里云安全组：确认 22 端口对当前出口 IP 开放（家庭宽带/VPN 出口 IP 变了会被挡）");
    log("    3) 云安全中心「暴力破解防御」：多次认证失败会封禁来源 IP，需要在控制台解封（常见 24 小时）");
    log("    4) 服务器上的 fail2ban / iptables：VNC 登录后 fail2ban-client status sshd / iptables -L -n");
    log("    5) 用 check-host.net 从别的地区测 121.199.9.157:22：外部能连、只有你连不上 = IP 被封");
  } else {
    log("  · 80 端口也连不上，服务器可能宕机或网络异常，请先在阿里云控制台检查实例状态。");
  }
  log("");
  log("  排查完再执行 pnpm deploy:only 重试；只想做连通性检查可运行 pnpm deploy:check。");
  return false;
}

async function main() {
  if (!cfg.host) fail("缺少 DEPLOY_HOST，请在 .env.local 中配置");
  if (!cfg.password && !cfg.keyPath) fail("缺少 SSH 凭据：请配置 DEPLOY_KEY_PATH（推荐）或 DEPLOY_PASSWORD");

  if (wantsCheck) {
    const sshUp = await probeTcp(cfg.host, cfg.port, 6000);
    const httpUp = await probeTcp(cfg.host, 80, 6000);
    log(`SSH  ${cfg.host}:${cfg.port}  ${sshUp ? "可连接" : "超时/被拦截"}`);
    log(`HTTP ${cfg.host}:80        ${httpUp ? "可连接" : "超时"}`);
    if (sshUp) {
      const conn = await connect();
      const who = await run(conn, "whoami");
      log(`SSH 登录成功，当前用户：${who.stdout.trim()}`);
      conn.end();
    }
    process.exit(sshUp ? 0 : 1);
  }

  if (wantsCert) {
    await applyCertificate();
    return;
  }

  if (wantsBuild) await buildSite();

  if (!existsSync(path.join(cfg.distDir, "index.html"))) {
    fail(`未找到 ${path.relative(projectRoot, cfg.distDir)}/index.html，请先执行 pnpm build`);
  }

  if (!(await preflight())) process.exit(1);

  log(`▶ 部署 ${cfg.site} → ${cfg.user}@${cfg.host}:${cfg.port}${cfg.root}`);

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const remoteArchive = `/tmp/blog-${cfg.site}-${timestamp}.tar.gz`;

  // 1) 本地打包
  const tmpDir = mkdtempSync(path.join(tmpdir(), "blog-deploy-"));
  const archivePath = path.join(tmpDir, "site.tar.gz");
  try {
    await execFileAsync("tar", ["-czf", archivePath, "-C", cfg.distDir, "."], { windowsHide: true });
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    fail(`打包失败（需要系统 tar 命令）：${error.message}`);
  }
  const archiveSize = (await import("node:fs")).statSync(archivePath).size;
  log(`· 已打包 ${(archiveSize / 1024 / 1024).toFixed(1)} MB`);

  const conn = await connect();
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: cfg.password,
      privateKey: cfg.keyPath ? readFileSync(cfg.keyPath) : undefined,
      passphrase: cfg.passphrase,
      readyTimeout: 30000,
    });

    // 2) 上传
    let lastPercent = -1;
    await sftp.fastPut(archivePath, remoteArchive, {
      step: (transferred, _chunk, total) => {
        const percent = Math.floor((transferred / total) * 100);
        if (percent >= lastPercent + 20) {
          lastPercent = percent;
          log(`· 上传 ${percent}%`);
        }
      },
    });
    log("· 上传完成");

    // 3) 首次部署时准备好 nginx 站点
    await ensureNginxSite(conn, sftp);

    // 4) 解压到新版本目录并原子切换软链
    await sh(
      conn,
      [
        "set -e",
        rootCmd(`mkdir -p ${cfg.root}/releases/${timestamp}`),
        rootCmd(`tar -xzf ${remoteArchive} -C ${cfg.root}/releases/${timestamp}`),
        rootCmd(`chmod -R u=rwX,go=rX ${cfg.root}/releases/${timestamp}`),
        rootCmd(`ln -sfn ${cfg.root}/releases/${timestamp} ${cfg.root}/current`),
        `rm -f ${remoteArchive}`,
      ].join(" && "),
      "发布新版本",
    );
    const pruned = await pruneOldReleases(conn, timestamp);
    log(`· 已切换到 releases/${timestamp}${pruned ? `，清理旧版本 ${pruned} 个` : ""}`);

    // 5) 重载 nginx
    await sh(conn, rootCmd("systemctl reload nginx"), "重载 nginx");

    // 6) 本机带 Host 头自检
    const probe = await run(
      conn,
      `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${cfg.domains[0]}' http://127.0.0.1/`,
    );
    const code = probe.stdout.trim();
    if (code !== "200") {
      throw new Error(`部署后自检返回 ${code}（期望 200），请检查 nginx 配置与站点目录`);
    }

    log(`\n✔ 部署完成：https://${cfg.domains[0]}/  （源站自检 HTTP ${code}）`);
    log(`  服务器目录：${cfg.root}/current -> releases/${timestamp}`);
    log(`  回滚命令：${rootCmd(`ln -sfn ${cfg.root}/releases/<上一个版本> ${cfg.root}/current`)} && ${rootCmd("systemctl reload nginx")}`);
  } finally {
    await sftp.end().catch(() => {});
    conn.end();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const primary = cfg.domains[0];
  log(`\n提示：若浏览器看到旧内容，请在 CDN 控制台刷新缓存（${primary} 走 CDN 时）`);
  log(`      若域名直接解析到源站，需要执行 pnpm deploy:cert 配置 HTTPS`);

  // 7) 源码同步到 GitHub（--no-git 可跳过）
  if (wantsGit) {
    try {
      await publishGit();
    } catch (error) {
      throw new Error(`服务器部署已完成，但源码推送 GitHub 失败：${error.message}`);
    }
  }
}

/** 执行 git 命令；allowFail 时失败返回 null */
async function git(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: projectRoot, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = (error.stderr || error.stdout || error.message || "").trim();
    throw new Error(`git ${args.join(" ")} 失败：${detail}`);
  }
}

/** 提交当前工作区并推送到 GitHub 仓库 */
async function publishGit() {
  log(`\n▶ 同步源码到 GitHub（${cfg.gitRemote}）`);

  const inside = await git(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (inside !== "true") {
    await git(["init", "-b", "main"]);
    log("· 已初始化本地 git 仓库");
  }

  // 没有配置提交身份时给一个默认值，避免首次提交失败
  if (!(await git(["config", "user.name"], { allowFail: true }))) {
    await git(["config", "user.name", "ZuoQi07"]);
  }
  if (!(await git(["config", "user.email"], { allowFail: true }))) {
    await git(["config", "user.email", "ZuoQi07@users.noreply.github.com"]);
  }

  const origin = await git(["remote", "get-url", "origin"], { allowFail: true });
  if (!origin) {
    await git(["remote", "add", "origin", cfg.gitRemote]);
  } else if (origin !== cfg.gitRemote) {
    await git(["remote", "set-url", "origin", cfg.gitRemote]);
    log(`· origin 已更新为 ${cfg.gitRemote}`);
  }

  await git(["add", "-A"]);
  const staged = await git(["diff", "--cached", "--name-only"]);
  if (staged) {
    const files = staged.split("\n").filter(Boolean).length;
    const stamp = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date());
    await git(["commit", "-m", `deploy: ${stamp}`]);
    log(`· 已提交 ${files} 个文件：deploy: ${stamp}`);
  } else {
    log("· 源码无变更，跳过提交");
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })) || "main";
  await git(["push", "-u", "origin", branch]);
  log(`· 已推送到 origin/${branch}`);
}

async function applyCertificate() {
  if (!cfg.email) fail("申请证书需要 DEPLOY_EMAIL（证书到期通知邮箱）");
  log(`▶ 为 ${cfg.domains.join("、")} 申请/续期 HTTPS 证书`);
  const conn = await connect();
  try {
    const domainArgs = cfg.domains.map((domain) => `-d ${domain}`).join(" ");
    const { stdout, stderr } = await sh(
      conn,
      rootCmd(`certbot --nginx ${domainArgs} --non-interactive --agree-tos -m ${cfg.email} --redirect`),
      "certbot",
    );
    log(stdout || stderr);
    await sh(conn, rootCmd("systemctl reload nginx"), "重载 nginx");
    const probe = await run(
      conn,
      `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${cfg.domains[0]}' https://127.0.0.1/ -k`,
    );
    log(`\n✔ 证书已配置，https://${cfg.domains[0]}/ 自检返回 ${probe.stdout.trim()}`);
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}\n`);
  process.exit(1);
});
