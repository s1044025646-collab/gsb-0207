// 源码使用无扩展名相对导入（tsx 直接运行），tsc 在 Bundler 解析下原样保留。
// 原生 Node ESM 运行 dist 需要显式 .js 扩展名，这里统一补上。
// 这样 `node dist/cli.js` 与 `tsx src/cli.ts` 都可直接使用。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

for (const file of walk("dist")) {
  const src = readFileSync(file, "utf8");
  const fixed = src
    .replace(/(from\s+["'])(\.[^"']+?)(["'])/g, (m, p1, spec, p3) =>
      spec.endsWith(".js") ? m : `${p1}${spec}.js${p3}`,
    )
    .replace(/(import\(\s*["'])(\.[^"']+?)(["']\s*\))/g, (m, p1, spec, p3) =>
      spec.endsWith(".js") ? m : `${p1}${spec}.js${p3}`,
    );
  if (fixed !== src) writeFileSync(file, fixed, "utf8");
}
console.log("dist 相对导入已补全 .js 扩展名");
