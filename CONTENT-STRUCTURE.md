# 博客内容结构与实现说明

本文档说明 Firefly 主题（本站基于 v6.16.9）的内容组织方式：内容放在哪、frontmatter 有哪些字段、每个目录对应什么路由，以及构建时是怎么被读取、校验、排序和渲染的。

---

## 1. 总览

本站是 Astro 静态站点，**内容驱动**：页面不写死在组件里，而是从 `src/content/` 下的 Markdown/MDX 读取，构建时生成静态 HTML。

| 内容类型 | 目录 | 对应路由 | 说明 |
| --- | --- | --- | --- |
| 博客文章 | `src/content/posts/` | `/posts/<文件名>/` | 支持分类、标签、系列、置顶、加密、评论开关 |
| 固定页面正文 | `src/content/spec/` | `/about/`、`/friends/`、`/guestbook/` | 文件名固定，正文由页面组件读取 |
| 动态（说说） | `src/content/dynamic/` | `/dynamic/` | 短内容流，支持置顶、定位 |
| 项目展示 | `src/content/projects/` | `/projects/`、`/projects/<slug>/` | 卡片列表 + 详情页 |

资源分两类：

- `src/assets/`：需要构建优化的图片（压缩、转 WebP/AVIF、加内容哈希、生成 LQIP 占位）；
- `public/`：原样复制的静态文件（相册、音乐、示例图、favicon 等）。

---

## 2. 目录结构

```text
src/
├── content/
│   ├── posts/                # 博客文章（.md / .mdx）
│   │   ├── hello-world.md
│   │   └── markdown-guide.md
│   ├── spec/                 # 固定页面正文
│   │   ├── about.md
│   │   ├── friends.mdx
│   │   └── guestbook.md
│   ├── dynamic/              # 动态/说说
│   └── projects/             # 项目展示
├── content.config.ts         # 四个 collection 的 loader + zod schema
├── pages/                    # 路由（文件即路由）
├── utils/
│   ├── content-utils.ts      # 排序、系列、标签/分类、相关文章
│   ├── dynamic-utils.ts      # 动态排序与纯文本提取
│   └── projects-utils.ts     # 项目状态、图标、封面解析
public/
├── images/posts/             # 文章里直接引用的图片
├── gallery/                  # 相册
└── assets/music/             # 音乐播放器资源
```

---

## 3. Collection 定义（`src/content.config.ts`）

四个 collection 都用 `glob` loader 读取，`schema` 用 zod 在**构建时校验**；字段缺失或类型不对会直接导致构建失败。

### 3.1 `posts` —— 博客文章

```ts
loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" })
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 必填 | 文章标题 |
| `published` | date | **必填** | 发布时间，决定排序与显示 |
| `updated` | date | — | 更新时间，显示「最后修改」 |
| `draft` | boolean | `false` | 草稿；**仅生产构建**隐藏，dev 可见 |
| `description` | string | `""` | 摘要，用于列表、SEO、OG |
| `image` | string | `""` | 封面；填 `"api"` 时走随机封面 API |
| `tags` | string[] | `[]` | 标签，参与归档与相关推荐 |
| `category` | string \| null | `""` | 分类；为空显示「未分类」 |
| `lang` | string | `""` | 文章语言（覆盖站点语言） |
| `pinned` | boolean | `false` | 置顶，排在列表最前 |
| `author` | string | `""` | 作者，缺省用 `profileConfig.name` |
| `sourceLink` | string | `""` | 转载来源 |
| `licenseName` / `licenseUrl` | string | `""` | 自定义许可协议 |
| `comment` | boolean | `true` | 是否显示评论区 |
| `password` | string | `""` | 设置后文章加密，需要密码查看 |
| `passwordHint` | string | `""` | 密码提示 |
| `series` | string | `""` | 系列名；填写后出现系列导航 |
| `seriesOrder` | number | — | 系列内顺序（升序） |
| `prevTitle` / `prevSlug` / `nextTitle` / `nextSlug` | string | `""` | 构建时由 `getSortedPosts()` 自动写入，**不要手动填** |

### 3.2 `spec` —— 固定页面

```ts
loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/spec" })
schema: z.object({})   // 不校验 frontmatter
```

正文纯 Markdown，页面标题、布局由 `src/pages/about.astro` 等组件决定。**文件名是约定**：

| 文件 | 页面 |
| --- | --- |
| `spec/about.md` | `/about/` |
| `spec/friends.mdx` | `/friends/` |
| `spec/guestbook.md` | `/guestbook/` |

### 3.3 `dynamic` —— 动态/说说

```ts
loader: glob({ pattern: "**/*.md", base: "./src/content/dynamic" })
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `published` | date | 必填 | 发布时间 |
| `pinned` | boolean | `false` | 置顶 |
| `location` | string | `""` | 定位文字 |

### 3.4 `projects` —— 项目展示

```ts
loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/projects" })
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 必填 | 项目名 |
| `published` | date | 必填 | 发布时间 |
| `draft` | boolean | `false` | 草稿，生产构建隐藏 |
| `order` | number | — | 手动排序，越大越靠前（支持 0） |
| `description` | string | `""` | 简介 |
| `image` | string | `""` | 封面 |
| `tags` | string[] | `[]` | 标签 |
| `link` | `{label, icon?, value}[]` | `[]` | 相关链接（图标可用 Iconify 名称） |
| `status` | string | `""` | 状态（进行中/已完成等，映射见 `projects-utils`） |
| `lang` | string | `""` | 语言 |

---

## 4. 路由映射

| 来源 | 路由 | 页面文件 | 实现要点 |
| --- | --- | --- | --- |
| `posts/<name>.md` | `/posts/<name>/` | `src/pages/posts/[...slug].astro` | `getStaticPaths` 用 `getSortedPosts()`，`render(entry)` 渲染正文 |
| 全部文章分页 | `/`、`/2/`、`/3/`… | `src/pages/[...page].astro` | `paginate(getSortedPosts(), { pageSize: siteConfig.pagination.postsPerPage })` |
| `spec/about.md` | `/about/` | `src/pages/about.astro` | `getEntry("spec", "about")` 后 `render` |
| `spec/friends.mdx` | `/friends/` | `src/pages/friends.astro` | 正文 + `friendsConfig` 友链卡片 + 评论 |
| `spec/guestbook.md` | `/guestbook/` | `src/pages/guestbook.astro` | 正文 + 评论（需启用评论系统） |
| `dynamic/*.md` | `/dynamic/` | `src/pages/dynamic/index.astro` | `sortDynamics()` 排序，Svelte feed 渲染 |
| `projects/*.md` | `/projects/`、`/projects/<slug>/` | `src/pages/projects/index.astro`、`[slug].astro` | `getSortedProjects()` |
| 全部文章 | `/archive/` | `src/pages/archive.astro` | 按年份分组 |
| 标签/分类/系列 | `/tags/`、`/categories/`、`/series/` | `src/pages/tags/index.astro` 等 | 统计来自 `content-utils` |
| 搜索 | `/search/` | `src/pages/search.astro` | Pagefind 构建后索引 |
| 订阅 | `/rss.xml`、`/atom.xml` | `rss.xml.ts`、`atom.xml.ts` | 由 `getSortedPosts()` 生成 |
| 文章日历数据 | `/api/allPostMeta.json` | `src/pages/api/allPostMeta.json.ts` | 输出 id/标题/日期/分类 |
| 动态数据 | `/api/dynamic.json` | `src/pages/api/dynamic.json.ts` | 输出动态列表（含图片） |
| OG 图 | `/og/<slug>.png` | `src/pages/og/[...slug].ts` | 动态生成分享图 |

> 文章 URL 由**文件名**决定（去掉 `.md`/`.mdx` 扩展名），重命名文件等于改 URL。

---

## 5. 实现细节

### 5.1 读取与校验

```ts
const posts = await getCollection("posts", ({ data }) =>
  import.meta.env.PROD ? data.draft !== true : true,
);
```

- `glob` loader 把文件读成 entry，`id` 是相对路径（如 `hello-world`）；
- zod schema 在构建时校验，错误会让 `astro build` 失败；
- `draft` 过滤只在**生产构建**生效，`pnpm dev` 能看到草稿。

### 5.2 排序规则（`src/utils/content-utils.ts`）

```ts
// 置顶优先 → 发布时间降序
if (a.data.pinned && !b.data.pinned) return -1;
if (!a.data.pinned && b.data.pinned) return 1;
return a.data.published > b.data.published ? -1 : 1;
```

`getSortedPosts()` 还会顺带写入上一篇/下一篇：

```ts
sorted[i].data.nextSlug = sorted[i - 1].id;   // 数组前一个
sorted[i].data.prevSlug = sorted[i + 1].id;   // 数组后一个
```

这对应文章底部的「上一篇 / 下一篇」导航，注意它是**列表相邻**关系，不是按时间语义的严格前后。

### 5.3 系列（series）

- `series` 相同的文章归为一组，组内按 `seriesOrder` 升序（未设置排最后，0 有效）；
- 文章页顶部渲染 `SeriesNav`，`/series/` 展示全部系列。

### 5.4 相关文章推荐

`getRelatedPosts()` 的评分公式：

```
总分 = 标签 Jaccard 相似度 × 100
     + 标题分词 Jaccard 相似度 × 100
     + 时效分（6 个月半衰期，最高 30）
     + 同分类加分（10）
```

- 标题分词用 `Intl.Segmenter`，中英文混合可用；
- 排除自身与**加密文章**；
- 取前 N 篇（默认 5）。

### 5.5 加密文章

- `password` 非空 → 前端渲染 `EncryptedPost`，内容在浏览器端解密后才显示；
- 页面加 `<meta name="robots" content="noindex, noarchive">`；
- 加密文章**不显示评论区**（`entry.data.comment && !entry.data.password`）；
- 也会被相关推荐排除。

### 5.6 评论区

- 文章 frontmatter `comment: false` 关闭该篇评论；
- 是否显示取决于 `commentConfig.type !== "none"`（本站为 Artalk）；
- 友链页、留言板页也会渲染评论组件（受 `friendsPageConfig.showComment` 控制）。

### 5.7 图片

| 位置 | 处理 |
| --- | --- |
| `src/assets/**` | 构建时压缩、转 WebP/AVIF、加内容哈希，生成 LQIP 占位 |
| `public/**` | 原样复制到 `dist/`，URL 不变 |
| 文章 `image: "api"` | 从 `coverImageConfig` 配置的随机图 API 取封面 |

Markdown 里引用 `public` 图片用绝对路径（`/images/xxx.webp`），引用 `src/assets` 图片用相对路径，由 Astro 处理。

### 5.8 标签、分类、归档

- `getTagList()`、`getCategoryList()` 统计时同样过滤草稿；
- 无分类文章归入「未分类」（i18n 文案）；
- 归档页按年份分组展示。

### 5.9 搜索

构建最后一步运行 Pagefind，索引 `dist/` 中带 `data-pagefind-body` 的内容；文章标题、正文会被索引，搜索页 `/search/` 直接查询索引。

### 5.10 动态（说说）

- 排序：置顶优先 → 发布时间降序；
- 正文按 Markdown 渲染，图片从正文里提取；
- `/api/dynamic.json` 输出给前端 feed 与外部消费。

### 5.11 项目

- 排序：`order` 降序（未设置排后，0 有效）→ 发布时间降序 → 标题；
- `status` 通过 `projects-utils` 映射为颜色/文案；
- `link[].icon` 支持 Iconify 图标名。

### 5.12 构建流水线

```
generate-lqips → generate-vndb-covers → astro build
→ prune-pio-assets → subset-fonts → minify-inline-scripts → pagefind
```

内容相关的步骤在前半段：`astro build` 时读取 collection、校验 schema、渲染 Markdown、生成静态路由。

---

## 6. 新增内容

### 6.1 新文章

```bash
pnpm new-post my-post
```

会生成 `src/content/posts/my-post.md`，然后填 frontmatter：

```yaml
---
title: 文章标题
published: 2026-11-02 12:00:00
description: 一句话摘要
image: ""
tags: [日常, 随笔]
category: 随笔
draft: false
pinned: false
comment: true
---
```

访问 `http://localhost:4321/posts/my-post/` 预览。

### 6.2 新动态

```bash
pnpm new-dynamic
```

```yaml
---
published: 2026-11-02 12:00:00
pinned: false
location: 杭州
---
今天天气不错。
```

### 6.3 新项目

手动创建 `src/content/projects/<slug>.md`：

```yaml
---
title: 项目名
published: 2026-11-01 12:00:00
description: 项目简介
image: ""
tags: [Astro]
link:
  - label: GitHub
    icon: fa7-brands:github
    value: https://github.com/xxx/yyy
status: 进行中
order: 10
---
项目正文……
```

### 6.4 修改固定页面

直接编辑 `src/content/spec/about.md`、`friends.mdx`、`guestbook.md` 即可；友链卡片数据在 `src/config/friendsConfig.ts`，不在 Markdown 里。

---

## 7. 字段速查

```yaml
# 文章
title: string            # 必填
published: date          # 必填
updated: date
draft: boolean           # 默认 false
description: string
image: string            # 可填 "api"
tags: [string]
category: string
lang: string
pinned: boolean          # 默认 false
author: string
sourceLink: string
licenseName: string
licenseUrl: string
comment: boolean         # 默认 true
password: string
passwordHint: string
series: string
seriesOrder: number
```

---

## 8. 注意事项

1. **文件名就是 URL**：`posts/hello-world.md` → `/posts/hello-world/`，改名会让旧链接 404。
2. **中文文件名**在 URL 中会被百分号编码，建议用英文/拼音命名。
3. `draft: true` 只影响生产构建；本地 `pnpm dev` 仍能访问。
4. 加密文章不显示评论、不参与相关推荐、搜索引擎不收录。
5. `spec` 下的文件名是固定的（`about`/`friends`/`guestbook`），改文件名会导致对应页面报「内容不存在」。
6. 修改 schema 字段后需要重启 dev server 才会重新生成类型。
7. `public/` 里的图片不会经过压缩和哈希，替换同名文件后记得刷新 CDN。
8. 文章排序是「置顶优先 + 发布时间倒序」，与文件系统里的顺序无关。
