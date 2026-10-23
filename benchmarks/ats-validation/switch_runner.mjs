import { cpSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const variant = process.argv[2]
if (!['baseline', 'fork'].includes(variant)) throw new Error('Choose baseline or fork')
for (const name of ['runner', 'core']) {
  const target = join(import.meta.dirname, 'app/node_modules/@japa', name)
  rmSync(target, { recursive: true, force: true })
  cpSync(join(import.meta.dirname, `${variant}-packages`, name), target, { recursive: true })
  console.log(name, JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version)
}
