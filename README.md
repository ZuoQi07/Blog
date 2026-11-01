<div align="center">

# 柒月の雨

**左柒的个人博客 —— 在七月的雨里，记下阅读、生活与创造。**

[线上站点](https://blog.julyrain.top) · [关于我](https://blog.julyrain.top/about/) · [归档](https://blog.julyrain.top/archive/) · [RSS](https://blog.julyrain.top/rss.xml)

</div>

![首页](docs/images/preview-home.webp)

## 关于本站

「柒月の雨」是我留给阅读、生活与创造的一处书写空间。这里会收集读书时留下的句子、做东西时走过的弯路，还有那些看似平常却不想忘记的日子。

更新没有固定的节奏，希望这里能成为一个舒服的停靠点。

![文章页](docs/images/preview-post.webp)

## 技术栈

| 项目 | 说明 |
| --- | --- |
| 框架 | [Astro](https://astro.build) 7（静态输出） |
| 交互组件 | [Svelte](https://svelte.dev) 5 |
| 样式 | [Tailwind CSS](https://tailwindcss.com) 4 |
| 代码高亮 | [Expressive Code](https://expressive-code.com/) |
| 搜索 | [Pagefind](https://pagefind.app/)（构建时建立全文索引） |
| 图标 | [Iconify](https://iconify.design)（astro-icon） |
| 页面过渡 | [Swup](https://swup.js.org/) |
| 主题 | [Firefly](https://github.com/CuteLeaf/Firefly)（基于 [Fuwari](https://github.com/saicaca/fuwari) 二次开发） |

## 本地开发

环境要求：**Node.js ≥ 22.23**、**pnpm 11**。本机没有全局 pnpm 时用 corepack 调用即可：

```bash
corepack pnpm install     # 安装依赖
corepack pnpm dev         # 本地开发，http://localhost:4321
corepack pnpm build       # 构建到 dist/（含 Pagefind 索引、字体子集化）
corepack pnpm preview     # 预览构建产物
corepack pnpm check       # Astro 类型检查
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 生产构建，输出到 `dist/` |
| `pnpm preview` | 本地预览 `dist/` |
| `pnpm check` | 类型与模板检查 |
| `pnpm new-post <文件名>` | 新建文章 |
| `pnpm new-d <内容>` | 新建一条动态 |
| `pnpm deploy` | 一键构建 + 部署到服务器 + 推送源码到 GitHub |
| `pnpm deploy:only` | 只发布现有 `dist/`，不重新构建 |
| `pnpm deploy:cert` | 域名直接解析到源站时申请 HTTPS 证书 |

## 目录结构

```
src/
├── config/          站点配置（标题、导航、侧边栏、评论、字体、壁纸…）
├── content/
│   ├── posts/       文章（.md / .mdx）
│   ├── spec/        关于、友链、留言板等特殊页面
│   ├── dynamic/     动态（轻量短内容）
│   └── projects/    项目展示
├── pages/           路由页面
├── components/      组件（Astro + Svelte 岛）
├── layouts/         页面布局
├── styles/          全局样式与主题
├── i18n/            多语言文案
├── plugins/         Markdown / HTML 处理插件
├── utils/           工具函数
└── assets/          需要交给 Astro 优化的图片与字体
public/              原样拷贝的静态资源（壁纸、相册、favicon、音乐…）
scripts/             构建与部署脚本
```

## 写文章

文章放在 `src/content/posts/`，支持 Markdown 与 MDX，frontmatter 示例：

```yaml
---
title: 在七月的雨里开始
published: 2026-10-28 00:00:00
description: 给这场迟来的夏雨留一页纸。
image: ""          # 封面图，留空则不显示；也可填相对路径或 "api"
tags: [日常]
category: 随笔
draft: false       # true 则只在开发环境可见
pinned: false      # 置顶
---
```

正文支持 GFM、提示块（admonitions）、数学公式（KaTeX）、Mermaid / PlantUML 图表、GitHub 仓库卡片、代码分组等扩展语法。

「关于我」页面内容在 `src/content/spec/about.md`；友链、留言板等页面的自定义内容也在 `src/content/spec/` 下。

## 站点配置

大部分个性化设置都在 `src/config/`，常用的几个：

| 文件 | 内容 |
| --- | --- |
| `siteConfig.ts` | 站点标题、副标题、URL、描述、主题色、分页、页面开关 |
| `profileConfig.ts` | 头像、昵称、签名、社交链接 |
| `navBarConfig.ts` | 导航栏菜单 |
| `sidebarConfig.ts` | 侧边栏组件与顺序 |
| `backgroundWallpaper.ts` | 壁纸模式、首页横幅文字、轮播与水波纹 |
| `announcementConfig.ts` | 公告 |
| `commentConfig.ts` | 评论系统（当前未启用） |
| `fontConfig.ts` | 字体（代码字体使用本地 JetBrains Mono） |

## 部署

站点是纯静态产物，部署脚本通过 SSH 上传到服务器并按版本切换，详见 [DEPLOY.md](DEPLOY.md)。

- 线上地址：<https://blog.julyrain.top>（阿里云 CDN 回源到自有服务器，TLS 由 CDN 托管）
- 每次部署成功后会自动把源码提交并推送到 `git@github.com:ZuoQi07/Blog.git`
- 服务器上保留最近 5 个版本，可随时用软链回滚

## 致谢

- [Firefly](https://github.com/CuteLeaf/Firefly) —— 本站使用的 Astro 博客主题
- [Fuwari](https://github.com/saicaca/fuwari) —— Firefly 的上游模板
- 流萤相关图片素材版权归游戏《崩坏：星穹铁道》开发商米哈游所有

## 许可

主题代码遵循 [MIT License](LICENSE)，版权归 Firefly / Fuwari 原作者所有。
本站文章与图片（除主题自带素材外）版权归左柒所有，转载请注明出处。
