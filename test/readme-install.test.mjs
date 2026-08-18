import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('README documents the GitHub-only installation source', () => {
  assert.match(readme, /dsh plugin --profile web add -w github:leaforbook\/dsh-mcp-lazy/)
  assert.doesNotMatch(readme, /dsh plugin --profile web add @xiaoyilin\/dsh-mcp-lazy/)
})
