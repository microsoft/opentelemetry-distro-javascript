// Post-build fixups for the CommonJS output.
//
// The ESM build (dist/esm/) works as-is. The CJS build (dist/commonjs/)
// needs two fixups:
//
// 1. A package.json with {"type":"commonjs"} so Node doesn't treat .js
//    files as ESM (the root package.json has "type":"module").
//
// 2. The module-cjs.cts polyfill must replace module.ts in the CJS output,
//    because module.ts uses import.meta.url which is ESM-only.
//
const fs = require("fs");
const path = require("path");

const cjsDir = path.join(__dirname, "..", "dist", "commonjs");

// 1. CJS package.json marker
fs.writeFileSync(path.join(cjsDir, "package.json"), '{"type":"commonjs"}\n');

// 2. module.ts → module-cjs.cts polyfill swap
const sharedDir = path.join(cjsDir, "shared");
fs.copyFileSync(
  path.join(sharedDir, "module-cjs.cjs"),
  path.join(sharedDir, "module.js"),
);
// Keep source maps consistent: copy the CJS map or remove the stale ESM one
const moduleCjsMapPath = path.join(sharedDir, "module-cjs.cjs.map");
const moduleJsMapPath = path.join(sharedDir, "module.js.map");
if (fs.existsSync(moduleCjsMapPath)) {
  fs.copyFileSync(moduleCjsMapPath, moduleJsMapPath);
} else if (fs.existsSync(moduleJsMapPath)) {
  fs.unlinkSync(moduleJsMapPath);
}

console.log("CJS fixups applied.");
