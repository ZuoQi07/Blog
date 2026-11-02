import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCollection } from "astro:content";
import type { CollectionConfig } from "astro/content/config";
import { glob, type Loader } from "astro/loaders";
import { type ZodType, z } from "astro/zod";

type PostData = {
	title: string;
	published: Date;
	updated?: Date;
	draft: boolean;
	description: string;
	image: string;
	tags: string[];
	category: string | null;
	lang: string;
	pinned: boolean;
	author: string;
	sourceLink: string;
	licenseName: string;
	licenseUrl: string;
	comment: boolean;
	password: string;
	passwordHint: string;
	series: string;
	seriesOrder?: number;
	prevTitle: string;
	prevSlug: string;
	nextTitle: string;
	nextSlug: string;
};

type DynamicData = {
	published: Date;
	pinned: boolean;
	location: string;
};

type ProjectLink = {
	label: string;
	icon: string;
	value: string;
};

type ProjectData = {
	title: string;
	published: Date;
	draft: boolean;
	order?: number;
	description: string;
	image: string;
	tags: string[];
	link: ProjectLink[];
	status: string;
	lang: string;
};

type ContentCollection<T> = CollectionConfig<
	ZodType<T>,
	ReturnType<typeof glob>
>;

/**
 * 日期字段：允许留空或省略。
 * - `published` 留空（`published:` / `published: ""`）或省略时，构建期自动填入当前时间；
 * - `updated` 留空或省略时回退为 `published`，不会产生虚假的「修改时间」；
 * - 同一次构建内只取一次时间，保证缺省值稳定。
 */
let buildTimestamp: Date | undefined;
const buildNow = () => (buildTimestamp ??= new Date());

const emptyToUndefined = (value: unknown) => {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	return value;
};

const autoDate = () =>
	z.preprocess(
		emptyToUndefined,
		z
			.date()
			.optional()
			.default(() => buildNow()),
	);

const optionalDate = () => z.preprocess(emptyToUndefined, z.date().optional());

/* ---------- 文章内容变更追踪 ---------- */

const POST_HASHES_FILE = fileURLToPath(
	new URL("./constants/post-hashes.json", import.meta.url),
);

type PostHashRecord = {
	/** frontmatter + 正文的内容哈希 */
	hash: string;
	/** 上一次解析出的发布时间（ISO） */
	published: string;
	/** 上一次解析出的更新时间（ISO） */
	updated: string;
};

function readPostHashes(): Record<string, PostHashRecord> {
	try {
		return JSON.parse(readFileSync(POST_HASHES_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writePostHashes(records: Record<string, PostHashRecord>) {
	const sorted = Object.fromEntries(
		Object.keys(records)
			.sort()
			.map((key) => [key, records[key]]),
	);
	writeFileSync(POST_HASHES_FILE, `${JSON.stringify(sorted, null, "\t")}\n`);
}

const toDate = (value: unknown): Date | undefined => {
	if (value instanceof Date) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}
	return undefined;
};

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

const readScalar = (frontmatter: string, key: string): string | undefined => {
	const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(frontmatter);
	if (!match) return undefined;
	return match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
};

const postsBaseLoader = glob({
	pattern: "**/*.{md,mdx}",
	base: "./src/content/posts",
});

/**
 * 在 glob loader 之上做内容变更检测：
 * - 用 frontmatter + 正文的哈希与上次构建记录比对；
 * - 内容变化时把 updated 设为当前时间，未变化时沿用上次记录，保证多次构建结果稳定；
 * - 首次收录的文章 updated 等于 published，不制造“修改”痕迹。
 */
const postsLoader: Loader = {
	name: "firefly-posts-with-updated-tracking",
	load: async (context) => {
		await postsBaseLoader.load(context);

		const previous = readPostHashes();
		const next: Record<string, PostHashRecord> = {};
		let manifestChanged = false;

		for (const entry of context.store.values()) {
			const filePath = entry.filePath
				? path.resolve(PROJECT_ROOT, entry.filePath)
				: undefined;

			let raw = "";
			if (filePath) {
				try {
					raw = readFileSync(filePath, "utf8");
				} catch {
					raw = "";
				}
			}

			const frontmatterText =
				/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
			const explicitPublished = toDate(
				readScalar(frontmatterText, "published"),
			);
			const explicitUpdated = toDate(readScalar(frontmatterText, "updated"));

			// 用源文件内容做哈希，避免把 schema 默认值/运行时注入的字段算进去
			const hash = createHash("sha256")
				.update(
					raw || JSON.stringify({ data: entry.data, body: entry.body ?? "" }),
				)
				.digest("hex");

			const record = previous[entry.id];

			const published =
				explicitPublished ?? (record ? new Date(record.published) : new Date());

			let updated: Date;
			if (explicitUpdated) {
				updated = explicitUpdated;
			} else if (!record) {
				// 首次收录：默认没有修改过
				updated = published;
			} else if (record.hash === hash) {
				// 内容没变：沿用记录
				updated = new Date(record.updated);
			} else {
				// 内容变了：标记为刚刚修改
				updated = new Date();
			}

			entry.data.published = published;
			entry.data.updated = updated;
			context.store.set(entry);

			next[entry.id] = {
				hash,
				published: published.toISOString(),
				updated: updated.toISOString(),
			};

			if (
				!record ||
				record.hash !== hash ||
				record.published !== next[entry.id].published ||
				record.updated !== next[entry.id].updated
			) {
				manifestChanged = true;
			}
		}

		if (Object.keys(previous).length !== Object.keys(next).length) {
			manifestChanged = true;
		}
		if (manifestChanged) writePostHashes(next);
	},
};

const postsCollection: ContentCollection<PostData> = defineCollection({
	loader: postsLoader,
	schema: z
		.object({
			title: z.string(),
			published: autoDate(),
			updated: optionalDate(),
			draft: z.boolean().optional().default(false),
			description: z.string().optional().default(""),
			image: z.string().optional().default(""),
			tags: z.array(z.string()).optional().default([]),
			category: z.string().optional().nullable().default(""),
			lang: z.string().optional().default(""),
			pinned: z.boolean().optional().default(false),
			author: z.string().optional().default(""),
			sourceLink: z.string().optional().default(""),
			licenseName: z.string().optional().default(""),
			licenseUrl: z.string().optional().default(""),
			comment: z.boolean().optional().default(true),
			password: z.string().optional().default(""),
			passwordHint: z.string().optional().default(""),
			series: z.string().optional().default(""),
			seriesOrder: z.number().optional(),

			/* For internal use */
			prevTitle: z.string().default(""),
			prevSlug: z.string().default(""),
			nextTitle: z.string().default(""),
			nextSlug: z.string().default(""),
		})
		.transform((data) => ({
			...data,
			// updated 缺省（或留空）时回退到 published
			updated: data.updated ?? data.published,
		})),
});

const specCollection: ContentCollection<Record<string, never>> =
	defineCollection({
		loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/spec" }),
		schema: z.object({}),
	});

const dynamicCollection: ContentCollection<DynamicData> = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/dynamic" }),
	schema: z.object({
		published: z.date(),
		pinned: z.boolean().optional().default(false),
		location: z.string().optional().default(""),
	}),
});

const projectsCollection: ContentCollection<ProjectData> = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/projects" }),
	schema: z.object({
		title: z.string(),
		published: z.date(),
		draft: z.boolean().optional().default(false),
		order: z.number().optional(),
		description: z.string().optional().default(""),
		image: z.string().optional().default(""),
		tags: z.array(z.string()).optional().default([]),
		link: z
			.array(
				z.object({
					label: z.string(),
					icon: z.string().optional().default(""),
					value: z.string(),
				}),
			)
			.optional()
			.default([]),
		status: z.string().optional().default(""),
		lang: z.string().optional().default(""),
	}),
});

export const collections: {
	dynamic: typeof dynamicCollection;
	posts: typeof postsCollection;
	spec: typeof specCollection;
	projects: typeof projectsCollection;
} = {
	dynamic: dynamicCollection,
	posts: postsCollection,
	spec: specCollection,
	projects: projectsCollection,
};
