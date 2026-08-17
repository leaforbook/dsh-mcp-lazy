import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isAbsolute, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const requireFromPlugin = createRequire(new URL('../lib/index.js', import.meta.url))
const profileRoot = fileURLToPath(new URL('../../../', import.meta.url))

test('the profile does not shadow host-owned DSH runtime packages', () => {
  const shadowed = []

  for (const packageName of [
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-tools'
  ]) {
    try {
      const resolved = requireFromPlugin.resolve(`${packageName}/package.json`)
      const fromProfile = relative(profileRoot, resolved)
      if (fromProfile !== '' && !fromProfile.startsWith('..') && !isAbsolute(fromProfile)) {
        shadowed.push(resolved)
      }
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error
    }
  }

  assert.deepEqual(
    shadowed,
    [],
    `profile-local DSH runtimes can conflict with the host scheduler:\n${shadowed.join('\n')}`
  )
})
