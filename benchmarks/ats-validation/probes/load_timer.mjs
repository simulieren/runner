import { register } from 'node:module'
import { MessageChannel } from 'node:worker_threads'
const { port1, port2 } = new MessageChannel()
let last = { count: 0, total: 0 }
port1.on('message', (m) => {
  last = m
})
port1.unref()
register(new URL('./load_timer_hooks.mjs', import.meta.url), {
  data: { port: port2 },
  transferList: [port2],
})
process.on('exit', () =>
  console.log(
    `[japa-loadtime] files=${last.count} loadMs=${last.total.toFixed(0)} at=${performance.now().toFixed(0)}`
  )
)
