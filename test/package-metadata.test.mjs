import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const bundlePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('package metadata publishes the installable bundle from the npm owner scope', () => {
  assert.equal(pkg.name, '@yilinxiao/dsh-mcp-lazy')
  assert.equal(pkg.version, '0.4.0')
  assert.equal(pkg.repository.url, 'git+https://github.com/leaforbook/dsh-mcp-lazy.git')
  assert.equal(pkg.homepage, 'https://github.com/leaforbook/dsh-mcp-lazy#readme')
  assert.equal(pkg.bugs.url, 'https://github.com/leaforbook/dsh-mcp-lazy/issues')
  assert.deepEqual(pkg.publishConfig, { access: 'public' })
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.match(bundlePatch, /name: '@yilinxiao\/dsh-mcp-lazy'/)
})
