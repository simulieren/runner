import { execFileSync } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

await mkdir('.benchmarks', { recursive: true })
// Keep reference runners on the registry core, not the workspace fork.
const upstream = resolve('.benchmarks/upstream-deps')
await mkdir(upstream, { recursive: true })
await writeFile(
  resolve(upstream, 'package.json'),
  JSON.stringify({
    private: true,
    dependencies: { '@japa/runner': '5.4.0', '@japa/core': '10.4.0' },
  })
)
execFileSync(
  'npm',
  [
    'install',
    '--prefix',
    upstream,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--workspaces=false',
  ],
  { stdio: 'inherit' }
)
for (const [version, ref] of [
  ['5.3', 'v5.3.0'],
  ['5.4', 'v5.4.0'],
  ['speed.1', '107f9eb'],
]) {
  const directory = resolve(`.benchmarks/baseline-${version}`)
  let exists = true
  try {
    await access(directory)
  } catch {
    exists = false
  }
  if (!exists) {
    await mkdir(directory)
    const archive = execFileSync('git', ['archive', ref])
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
  }
  const link = resolve(directory, 'node_modules')
  let linked = false
  try {
    const stat = await lstat(link)
    if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink: ${link}`)
    linked = (await readlink(link)) === resolve(upstream, 'node_modules')
    if (!linked) await unlink(link)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!linked) await symlink(resolve(upstream, 'node_modules'), link, 'dir')
  execFileSync(resolve('node_modules/.bin/tsdown'), [], { cwd: directory, stdio: 'inherit' })
}
// Optional argument is a directory of test filenames, accessed only with readdir.
// No test contents, environment files, databases or application code are loaded.
if (process.argv[2]) {
  const files = (await readdir(resolve(process.argv[2]), { recursive: true }))
    .filter((file) => /\.spec\.(ts|tsx|js)$/.test(file))
    .map((file) => `tests/${file}`)
    .sort()
  await writeFile('.benchmarks/ats-layout.json', JSON.stringify(files, null, 2) + '\n')
  console.log(`Saved ${files.length} filenames locally; the manifest is gitignored.`)
}
