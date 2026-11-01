const STATIC_ASSET_LOCATION = String.raw`location ~* \.(?:css|js|mjs|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)$ {`;

const PAGE_LOCATION = `    location / {
        # 页面 HTML 必须始终从源站重新验证，避免 CDN 保留旧路由内容。
        add_header Cache-Control "no-store, max-age=0, must-revalidate" always;
        try_files $uri $uri/ $uri/index.html =404;
    }`;

const HASHED_ASSET_LOCATION = `    location ^~ /_astro/ {
        # Astro 文件名包含内容哈希，更新内容时 URL 也会变化。
        expires off;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
        try_files $uri =404;
    }`;

const PUBLIC_ASSET_LOCATION = `    ${STATIC_ASSET_LOCATION}
        # public 下的文件使用固定 URL，必须重新验证，不能标记为 immutable。
        expires off;
        add_header Cache-Control "no-cache, max-age=0, must-revalidate" always;
        access_log off;
        try_files $uri =404;
    }`;

function locationPattern(header) {
	const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^[\\t ]*${escaped}`, "m");
}

function replaceLocationBlock(config, pattern, replacement) {
	const match = pattern.exec(config);
	if (!match) return { config, found: false };

	const openingBrace = config.indexOf("{", match.index);
	if (openingBrace === -1) return { config, found: false };

	let depth = 0;
	for (let index = openingBrace; index < config.length; index += 1) {
		if (config[index] === "{") depth += 1;
		if (config[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					config:
						config.slice(0, match.index) +
						replacement +
						config.slice(index + 1),
					found: true,
				};
			}
		}
	}

	return { config, found: false };
}

function insertBeforeLocation(config, pattern, replacement) {
	const match = pattern.exec(config);
	if (!match) return config;
	return `${config.slice(0, match.index)}${replacement}\n\n${config.slice(match.index)}`;
}

export function renderNginxConfig({ site, domains, root }) {
	const serverNames = domains.join(" ");
	return `# 由 scripts/deploy.mjs 生成的静态博客站点配置（首次部署自动创建）
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};

    root ${root}/current;
    index index.html;
    charset utf-8;
    client_max_body_size 20m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml application/xml application/javascript application/json application/rss+xml image/svg+xml;

    # 一次性清理浏览器缓存：访问 /clear-cache 后浏览器会丢弃本站 HTTP 缓存
    location = /clear-cache {
        add_header Clear-Site-Data "cache" always;
        add_header Cache-Control "no-store" always;
        default_type text/plain;
        return 200 "cache cleared";
    }

${HASHED_ASSET_LOCATION}

${PAGE_LOCATION}

    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

${PUBLIC_ASSET_LOCATION}

    access_log /var/log/nginx/${site}.access.log;
    error_log  /var/log/nginx/${site}.error.log;
}
`;
}

/** Update only the known generated locations; leave custom nginx layouts untouched. */
export function migrateNginxConfig(current, domains) {
	const serverNames = domains.join(" ");
	let config = current.replace(
		/^([\t ]*)server_name\s+[^;]+;/gm,
		`$1server_name ${serverNames};`,
	);
	const beforeCacheMigration = config;

	const page = replaceLocationBlock(
		config,
		locationPattern("location / {"),
		PAGE_LOCATION,
	);
	const publicAssets = replaceLocationBlock(
		page.config,
		locationPattern(STATIC_ASSET_LOCATION),
		PUBLIC_ASSET_LOCATION,
	);

	if (page.found && publicAssets.found) {
		config = publicAssets.config;
		const hashedAssets = replaceLocationBlock(
			config,
			locationPattern("location ^~ /_astro/ {"),
			HASHED_ASSET_LOCATION,
		);
		config = hashedAssets.found
			? hashedAssets.config
			: insertBeforeLocation(
					config,
					locationPattern(STATIC_ASSET_LOCATION),
					HASHED_ASSET_LOCATION,
				);
	}

	return {
		config,
		cachePolicyUpdated: config !== beforeCacheMigration,
		changed: config !== current,
	};
}
