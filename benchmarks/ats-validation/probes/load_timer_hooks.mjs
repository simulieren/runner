// Lab probe: time loader load() calls for .ts files (wraps the next loader, i.e. ts-exec).
let count = 0,
  total = 0,
  port
export function initialize(data) {
  port = data.port
}
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) return nextLoad(url, context)
  const t = performance.now()
  const result = await nextLoad(url, context)
  total += performance.now() - t
  count++
  port.postMessage({ count, total })
  return result
}
