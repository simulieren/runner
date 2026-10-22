import { readFile } from 'node:fs/promises'

export async function loadLayout() {
  let files
  try {
    files = JSON.parse(await readFile('.benchmarks/ats-layout.json', 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Portable fallback with the same suite sizes as the initial ATS audit.
    files = [
      ['unit', 635],
      ['functional', 401],
      ['browser', 28],
    ].flatMap(([suite, count]) =>
      Array.from(
        { length: count },
        (_, i) => `tests/modules/module_${i % 24}/${suite}/service_${i}.spec.ts`
      )
    )
  }
  if (
    !Array.isArray(files) ||
    !files.every(
      (file) =>
        typeof file === 'string' &&
        file.startsWith('tests/') &&
        !file.includes('\\') &&
        !file.split('/').includes('..') &&
        /\.spec\.(ts|tsx|js)$/.test(file)
    )
  ) {
    throw new Error('Layout must contain relative tests/**/*.spec.{ts,tsx,js} paths')
  }
  return files
}
