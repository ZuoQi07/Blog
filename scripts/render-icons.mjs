import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.resolve("docs/icon-proposals");
await mkdir(outDir, { recursive: true });

const BG = (id = "bg") => `
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="0.55" stop-color="#122b47"/>
      <stop offset="1" stop-color="#1b4a73"/>
    </linearGradient>
    <linearGradient id="drop" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#a5f3fc"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#${id})"/>`;

const drop = (x, y, s, fill = "url(#drop)") =>
	`<path d="M12 2C12 2 4 11 4 15a8 8 0 0 0 16 0C20 11 12 2 12 2Z" transform="translate(${x} ${y}) scale(${s})" fill="${fill}"/>`;

const icons = {
	"a-moon-rain": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <mask id="moon">
    <rect width="512" height="512" fill="black"/>
    <circle cx="316" cy="170" r="94" fill="white"/>
    <circle cx="356" cy="142" r="80" fill="black"/>
  </mask>
  <rect width="512" height="512" fill="#f8fafc" mask="url(#moon)"/>
  ${drop(168 - 60, 306 - 60, 5)}
</svg>`,

	"b-cloud-rain": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <g fill="#e8f1fa">
    <circle cx="196" cy="198" r="62"/>
    <circle cx="256" cy="176" r="80"/>
    <circle cx="318" cy="198" r="62"/>
    <rect x="196" y="198" width="122" height="62" rx="31"/>
  </g>
  ${drop(196 - 24, 300 - 24, 2)}
  ${drop(256 - 28, 330 - 28, 2.35)}
  ${drop(318 - 24, 300 - 24, 2)}
</svg>`,

	"c-umbrella": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <path d="M104 258C112 178 176 120 256 120s144 58 152 138q-48 42-96 0-48 42-96 0-48 42-96 0Z" fill="url(#drop)"/>
  <path d="M256 258v122q0 32 32 32t32-32" fill="none" stroke="#f8fafc" stroke-width="20" stroke-linecap="round"/>
  ${drop(150 - 24, 326 - 24, 2, "#7dd3fc")}
  ${drop(372 - 24, 316 - 24, 2, "#7dd3fc")}
</svg>`,

	"d-seven": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <path d="M170 150h182L250 404" fill="none" stroke="#f8fafc" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
  <g stroke="#38bdf8" stroke-width="14" stroke-linecap="round" opacity="0.9">
    <path d="M120 430l-24 34"/>
    <path d="M168 442l-24 34"/>
    <path d="M216 430l-24 34"/>
  </g>
</svg>`,

	"e-qi": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <text x="256" y="352" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" font-size="300" font-weight="700" fill="#f8fafc">柒</text>
  ${drop(442 - 19, 92 - 19, 1.6)}
</svg>`,

	"f-drop-ripple": `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${BG()}
  <path d="M12 2C12 2 4 11 4 15a8 8 0 0 0 16 0C20 11 12 2 12 2Z" transform="translate(122 62) scale(11)" fill="url(#drop)"/>
  <path d="M156 392q100 44 200 0" fill="none" stroke="#7dd3fc" stroke-width="18" stroke-linecap="round" opacity="0.9"/>
  <path d="M186 436q70 30 140 0" fill="none" stroke="#7dd3fc" stroke-width="14" stroke-linecap="round" opacity="0.55"/>
</svg>`,
};

const rendered = [];
for (const [name, svg] of Object.entries(icons)) {
	await writeFile(path.join(outDir, `${name}.svg`), svg.trim());
	const png = await sharp(Buffer.from(svg)).png().toBuffer();
	await writeFile(path.join(outDir, `${name}.png`), png);
	rendered.push({ name, png });
}

// 联系表：3 列 x 2 行
const cellW = 560;
const cellH = 640;
const margin = 40;
const sheetW = margin * 2 + cellW * 3;
const sheetH = margin * 2 + cellH * 2;

const composites = [];
const labels = ["A", "B", "C", "D", "E", "F"];
rendered.forEach((item, index) => {
	const col = index % 3;
	const row = Math.floor(index / 3);
	const x = margin + col * cellW + 24;
	const y = margin + row * cellH + 24;
	composites.push({ input: item.png, left: x, top: y });
	const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="80"><text x="280" y="54" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" font-weight="700" fill="#0f172a">${labels[index]}</text></svg>`;
	composites.push({ input: Buffer.from(labelSvg), left: margin + col * cellW, top: y + 512 + 8 });
});

await sharp({
	create: { width: sheetW, height: sheetH, channels: 4, background: "#ffffff" },
})
	.composite(composites)
	.png()
	.toFile(path.join(outDir, "contact-sheet.png"));

// 小尺寸预览（32 / 48 / 64，每行一种尺寸）
const sizes = [32, 48, 64];
const gap = 24;
const cell = 64;
const smallMargin = 40;
const rowH = 88;
const smallW = smallMargin * 2 + rendered.length * (cell + gap) - gap;
const smallH = smallMargin * 2 + sizes.length * rowH;

const smallComposites = [];
for (const [row, size] of sizes.entries()) {
	for (let index = 0; index < rendered.length; index += 1) {
		const input = await sharp(rendered[index].png).resize(size, size).toBuffer();
		smallComposites.push({
			input,
			left: smallMargin + index * (cell + gap) + (cell - size) / 2,
			top: smallMargin + row * rowH + (cell - size) / 2,
		});
	}
}

await sharp({
	create: { width: smallW, height: smallH, channels: 4, background: "#ffffff" },
})
	.composite(smallComposites)
	.png()
	.toFile(path.join(outDir, "small-sizes.png"));

console.log("icons:", rendered.map((r) => r.name).join(", "));
console.log("contact sheet:", sheetW, "x", sheetH);
