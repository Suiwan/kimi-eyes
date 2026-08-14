/**
 * kimi-eyes — 稳定入口（薄壳）。
 *
 * loader 在 patch 热重载时只有行 name 变化才会重新 import，且裸
 * import(name) 走 ESM 缓存；所以实现代码放在 impl.js，这里用
 * import.meta.url 自带的查询参数做缓存破坏：
 *
 *   patch 行名写 './node_modules/kimi-eyes/lib/entry.js?v=1'，
 *   改了 impl.js 之后把 ?v=1 递增（如 ?v=2）保存即热更新，无需重启。
 *
 * 顶层 await 在模块求值期完成，loader 的 `await import(...)` 会等
 * 到 exports 全部就绪，apply 保持同步函数。
 * @module kimi-eyes/entry
 */

const { search } = new URL(import.meta.url)
const impl = await import(new URL(`impl.js${search}`, import.meta.url))

export const name = impl.name
export const inject = impl.inject
export const apply = impl.apply
