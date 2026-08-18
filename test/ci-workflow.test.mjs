import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('GitHub Actions runs the test suite on Node.js 20', async () => {
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')

  assert.match(workflow, /actions\/checkout@v4/)
  assert.match(workflow, /actions\/setup-node@v4/)
  assert.match(workflow, /node-version:\s*20/)
  assert.match(workflow, /run:\s*npm ci --legacy-peer-deps --ignore-scripts/)
  assert.match(workflow, /run:\s*npm test/)
})
