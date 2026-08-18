import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const loader = fileURLToPath(new URL('./fixtures/dsh-peer-loader.mjs', import.meta.url))
const harness = fileURLToPath(new URL('./fixtures/plugin-host-harness.mjs', import.meta.url))

test('plugin apply lifecycle keeps real MCP fixture connections warm', async () => {
  const { stdout } = await execute(process.execPath, [
    '--no-warnings',
    '--experimental-loader', loader,
    harness
  ], { timeout: 45000 })

  assert.match(stdout, /plugin lifecycle ok/)
})
