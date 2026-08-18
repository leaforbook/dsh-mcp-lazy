import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

test('the MCP client advertises the package version', () => {
  assert.match(source, /createRequire\(import\.meta\.url\)/)
  assert.match(source, /version:\s*pluginVersion/)
  assert.doesNotMatch(source, /version:\s*['"]0\.2\.0['"]/)
})
