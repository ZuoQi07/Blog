import assert from "node:assert/strict";
import test from "node:test";
import { migrateNginxConfig, renderNginxConfig } from "./nginx-config.mjs";

const legacyConfig = String.raw`server {
    listen 80;
    server_name old.example.com;

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ $uri/index.html =404;
    }

    location ~* \.(?:css|js|mjs|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
        try_files $uri =404;
    }
}`;

test("migrates the generated Nginx cache rules safely and idempotently", () => {
	const first = migrateNginxConfig(legacyConfig, ["blog.example.com"]);

	assert.equal(first.cachePolicyUpdated, true);
	assert.match(first.config, /server_name blog\.example\.com;/);
	assert.match(
		first.config,
		/add_header Cache-Control "no-store, max-age=0, must-revalidate" always;/,
	);
	assert.match(
		first.config,
		/location \^~ \/_astro\/[\s\S]*?max-age=31536000, immutable/,
	);
	assert.match(
		first.config,
		/add_header Cache-Control "no-cache, max-age=0, must-revalidate" always;/,
	);
	assert.doesNotMatch(first.config, /expires 30d|public, immutable/);

	const second = migrateNginxConfig(first.config, ["blog.example.com"]);
	assert.equal(second.config, first.config);
	assert.equal(second.cachePolicyUpdated, false);
});

test("does not rewrite an unrecognized custom Nginx location layout", () => {
	const customConfig =
		"server {\n    server_name old.example.com;\n    location / { return 418; }\n}";
	const result = migrateNginxConfig(customConfig, ["blog.example.com"]);

	assert.equal(result.cachePolicyUpdated, false);
	assert.match(result.config, /server_name blog\.example\.com;/);
	assert.match(result.config, /location \/ \{ return 418; \}/);
	assert.doesNotMatch(result.config, /_astro/);
});

test("new site configuration uses no-store pages and revalidated public assets", () => {
	const config = renderNginxConfig({
		site: "blog.example.com",
		domains: ["blog.example.com"],
		root: "/var/www/blog.example.com",
	});

	assert.match(config, /location \^~ \/_astro\//);
	assert.match(config, /no-store, max-age=0, must-revalidate/);
	assert.match(config, /no-cache, max-age=0, must-revalidate/);
	assert.doesNotMatch(config, /expires 30d|public, immutable/);
});
