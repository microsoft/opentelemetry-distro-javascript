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
// 3. The Azure Functions instrumentation import must be fixed. The ESM
//    build uses a default import (required because the package is a webpack
//    bundle and Node ESM can't extract named exports). In CJS, the
//    __importDefault helper double-wraps the require result, so we replace
//    it with a direct require + destructure.

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

// 3. Fix Azure Functions default-import in CJS output
const handlerPath = path.join(cjsDir, "azureMonitor", "traces", "handler.js");
const handler = fs.readFileSync(handlerPath, "utf8");
const azureFunctionsImportPattern =
  /const functions_opentelemetry_instrumentation_1 = __importDefault\(require\("@azure\/functions-opentelemetry-instrumentation"\)\);\s*const \{ AzureFunctionsInstrumentation \} = functions_opentelemetry_instrumentation_1\.default;/;
// Replace the __importDefault pattern with a direct require
const updatedHandler = handler.replace(
  azureFunctionsImportPattern,
  'const { AzureFunctionsInstrumentation } = require("@azure/functions-opentelemetry-instrumentation");',
);
if (updatedHandler === handler) {
  throw new Error(
    `Azure Functions CJS import fixup did not match expected output in ${handlerPath}. ` +
    `The emitted CommonJS handler format may have changed; update scripts/fixup-cjs.cjs before publishing.`,
  );
}
fs.writeFileSync(handlerPath, updatedHandler);

console.log("CJS fixups applied.");
