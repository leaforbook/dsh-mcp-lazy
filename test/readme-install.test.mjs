import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('README installs the package from the npm owner scope', () => {
  assert.match(readme, /dsh plugin --profile web add @yilinxiao\/dsh-mcp-lazy/)
  assert.doesNotMatch(readme, /github:leaforbook\/dsh-mcp-lazy/)
  assert.doesNotMatch(readme, /@xiaoyilin\/dsh-mcp-lazy/)
})
