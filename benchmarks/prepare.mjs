import { execFileSync } from 'node:child_process'
import { access, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

await mkdir('.benchmarks', { recursive: true })
for (const version of ['5.3', '5.4']) {
  const directory = resolve(`.benchmarks/baseline-${version}`)
  let exists = true
  try {
    await access(directory)
  } catch {
    exists = false
  }
  if (!exists) {
    await mkdir(directory)
    const archive = execFileSync('git', ['archive', `v${version}.0`])
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir')
  }
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
