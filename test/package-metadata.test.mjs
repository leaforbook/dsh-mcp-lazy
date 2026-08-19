import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('package metadata exposes an installable DSH bundle layer', () => {
  assert.equal(pkg.version, '0.4.0')
  assert.equal(pkg.repository.url, 'git+https://github.com/leaforbook/dsh-mcp-lazy.git')
  assert.equal(pkg.homepage, 'https://github.com/leaforbook/dsh-mcp-lazy#readme')
  assert.equal(pkg.bugs.url, 'https://github.com/leaforbook/dsh-mcp-lazy/issues')
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})
