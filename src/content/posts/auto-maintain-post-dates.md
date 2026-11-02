---
title: 让 published 和 updated 自己维护
published: 2026-11-02 12:30:00
description: 把文章时间从“手写 frontmatter”改成“构建时自动维护”：published 留空自动填当前时间，updated 由内容变更检测自动更新。
tags: [Astro, 博客, 折腾]
category: 折腾
draft: false
pinned: false
---

写文章的时候，最烦的往往不是正文，而是 frontmatter 里的那几个时间字段：`published` 忘了写就构建报错，`updated` 写了又经常忘记改。这次干脆把它们交给构建流程自己维护。

## 目标

1. `published` 不再是必填，留空时构建自动填当前时间；
2. `updated` 也不再需要手写，留空时按规则自动维护；
3. 文章内容一旦变化，`updated` 自动更新为构建时间；
4. 内容没变时，多次构建结果保持稳定，不能每次构建都把时间刷新一遍。

## 一、published 改为非必填

在 `src/content.config.ts` 里加了一个预处理：

```ts
const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
};

const autoDate = () =>
  z.preprocess(emptyToUndefined, z.date().optional().default(() => buildNow()));
```

效果是：不写 `published`、写 `published:`（空值）、写 `published: ""` 都会被当成“未填写”，构建时填入当前时间。

现在最小可用 frontmatter 只剩一行标题：

```yaml
---
title: 只有标题也能建
---
```

## 二、updated 缺省时先回退到 published

`updated` 同样是可选字段，缺省时先回退为 `published`，避免出现“每篇文章都显示最后修改”的情况：

```ts
schema: z
  .object({
    published: autoDate(),
    updated: optionalDate(),
    // ...
  })
  .transform((data) => ({
    ...data,
    updated: data.updated ?? data.published,
  })),
```

到这一步，时间字段已经可以完全不手写了，但还差“内容变了要自动更新”的能力。

## 三、构建时检测内容变更

这是这次改动的核心：**每次构建都拿源文件内容和上一次构建的记录做比较，变了就把 `updated` 设为当前时间。**

### 实现

用一个自定义 loader 包住 `glob`：

```ts
const postsBaseLoader = glob({
  pattern: "**/*.{md,mdx}",
  base: "./src/content/posts",
});

const postsLoader: Loader = {
  name: "firefly-posts-with-updated-tracking",
  load: async (context) => {
    await postsBaseLoader.load(context);

    const previous = readPostHashes();
    const next: Record<string, PostHashRecord> = {};

    for (const entry of context.store.values()) {
      const raw = readFileSync(filePath, "utf8");
      const hash = createHash("sha256").update(raw).digest("hex");
      // 显式写了 updated 就以文件为准
      if (explicitUpdated) updated = explicitUpdated;
      else if (!record) updated = published;      // 首次收录
      else if (record.hash === hash) updated = new Date(record.updated); // 没变
      else updated = new Date();                  // 变了

      entry.data.published = published;
      entry.data.updated = updated;
      context.store.set(entry);
      next[entry.id] = { hash, published: ..., updated: ... };
    }

    if (changed) writePostHashes(next);
  },
};
```

基线记录存在 `src/constants/post-hashes.json`：

```json
{
  "hello-world": {
    "hash": "e113d212...",
    "published": "2026-10-28T00:00:00.000Z",
    "updated": "2026-10-28T00:00:00.000Z"
  }
}
```

### 为什么哈希源文件，而不是解析后的数据

一开始我直接对 `entry.data` 做哈希，结果第二次构建怎么都不会触发更新。原因有两个：

1. Astro 会把**校验后的数据**缓存进数据仓库，`entry.data` 里已经带上了 schema 默认值（`tags: []`、`draft: false`……），和源文件里的 frontmatter 不是一回事；
2. 上一轮注入的 `updated` 也留在了缓存里，下一轮会被误判成“用户显式写的更新时间”。

所以最终改成**直接读源文件、对文件内容做 SHA-256**，并且用正则从 frontmatter 里单独取 `published` / `updated`，完全绕开缓存带来的字段污染。

## 实测

用一篇临时文章验证了四种情况：

| 场景 | updated 结果 |
| --- | --- |
| 首次构建 | 等于 published |
| 修改正文后构建 | 构建当前时间 |
| 不改内容再次构建 | 保持不变 |
| 删除文章后构建 | 基线记录自动移除 |

页面里 JSON-LD 的 `dateModified` 也跟着变，`astro check` 0 errors，`astro build` 25 页正常。

## 几个注意点

- **显式优先**：手写 `updated` 时不会被自动逻辑覆盖；
- **基线要提交**：`src/constants/post-hashes.json` 需要跟着仓库走，否则换台机器构建会把所有文章当成“新文章”；
- **只在构建时更新**：`pnpm dev` 里改文件会立刻写基线，但线上要 `pnpm deploy` 才生效；
- **内容变化包括 frontmatter**：改标题、标签、分类也会触发更新时间。

## 小结

现在写完文章只要负责正文，时间字段交给构建流程：

```yaml
---
title: 只写标题就行
---
```

发布、改稿、再发布，`updated` 会自己跟着走。代码改动已经提交（`d6cc53d`），基线文件也在仓库里。
