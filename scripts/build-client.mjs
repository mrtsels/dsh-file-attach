#!/usr/bin/env node
/**
 * build-client.mjs — Wrap compiled client.js in __ModuleLoader__.load format
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const clientPath = resolve(root, 'lib/client/index.js')

const source = readFileSync(clientPath, 'utf8')
const pluginId = 'dsh-file-attach'

let body = source
  .replace(/^export\s+(const|let|var)\s+(\w+)\s*=/gm, 'var $2 =')
  .replace(/^export\s+function\s+(\w+)/gm, 'function $1')
  .replace(/^export\s+default\s+/gm, 'var _default = ')
  .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')

const exportedNames = []
for (const m of source.matchAll(/^export\s+(?:const|let|var|function)\s+(\w+)/gm)) {
  exportedNames.push(m[1])
}
const exportLines = exportedNames.map(n => `\t\texports.${n} = ${n};`).join('\n')

// Only inject React — styles/slots come from ctx, not require
const requireInjections = `
\t\tvar react = require("react");
\t\tvar React = react;
`

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pluginId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${requireInjections.split('\n').map(line => '\t\t' + line).join('\n')}

${body.split('\n').map(line => '\t\t' + line).join('\n')}

${exportLines}

\t\treturn module.exports;
\t}
});
`

writeFileSync(clientPath, wrapped, 'utf8')

try {
  new Function(readFileSync(clientPath, 'utf8'))
  console.log('✅ Wrapped + syntax OK — exports:', exportedNames.join(', '))
} catch (e) {
  console.error('❌ Syntax error:', e.message)
  process.exit(1)
}
