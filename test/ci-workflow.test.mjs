import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('GitHub Actions verifies the promised Node and DSH compatibility matrices', async () => {
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')

  assert.match(workflow, /actions\/checkout@v4/)
  assert.match(workflow, /actions\/setup-node@v4/)
  assert.match(workflow, /node-version:\s*\[20,\s*24\]/)
  assert.match(workflow, /dsh-version:\s*\[0\.1\.0-rc\.6,\s*0\.1\.0-rc\.7,\s*0\.1\.0-rc\.8\]/)
  assert.match(workflow, /run:\s*npm ci --legacy-peer-deps --ignore-scripts/)
  assert.match(
    workflow,
    /run:\s*npm install --no-save --ignore-scripts @deepseek-ai\/dsh@\$\{\{ matrix\.dsh-version \}\} @deepseek-ai\/dsh-tools@\$\{\{ matrix\.dsh-version \}\} @deepseek-ai\/dsh-subprocess@\$\{\{ matrix\.dsh-version \}\}/
  )
  const dshCompat = workflow.match(/  dsh-compat:\n([\s\S]*)/)?.[1]
  assert.ok(dshCompat, 'dsh-compat job must be present')
  assert.match(
    dshCompat,
    /- run: node --test test\/dsh-version-compat\.test\.mjs\n\s+env:\n\s+DSH_COMPAT_VERSION: \$\{\{ matrix\.dsh-version \}\}/
  )
  assert.match(workflow, /run:\s*npm test/)
})
