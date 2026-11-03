#!/usr/bin/env node
// 前端模块导入健康检查：每个 import { name } from "./x.js" 的名字必须在 x.js 的导出里。
// 教训来源：bindTheme 忘了加进 import，init 中途 ReferenceError，页面假死「连接中」。
// 静态正则实现（无依赖）：export { const|let|function|class } 与 async function；export default 不跟踪。
// 用法: node scripts/check_imports.mjs   —— 有坏导入时退出码 1。
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "js");
const exports = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export (?:async )?(?:function|const|let|class) ([\w$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export \{([^}]+)\}/g)) {
    for (const n of m[1].split(",")) names.add(n.trim().split(/\s+as\s+/).pop());
  }
  exports[f] = names;
}

const bad = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(dir, f), "utf8");
  for (const m of src.matchAll(/import \{([^}]+)\} from "\.\/([\w$]+)\.js"/g)) {
    const target = `${m[2]}.js`;
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name && !exports[target]?.has(name)) {
        bad.push(`${f}: import { ${name} } from "./${target}" —— 目标没有这个导出`);
      }
    }
  }
}
if (bad.length) {
  for (const b of bad) console.log("  BAD:", b);
  process.exit(1);
}
console.log(`imports OK ✓（${Object.keys(exports).length} 个模块互相校验通过）`);
