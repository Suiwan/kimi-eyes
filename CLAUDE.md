# kimi-eyes

给 DSH 主 agent 装上「眼睛」：注册 `kimi_vision` 工具，把图片交给 Kimi K3 视觉模型识别，返回文本描述。解决主模型路由不支持图片输入时的识图需求（截图、图表、照片、扫描件，可针对图片提问）。

## 技术栈

- 语言 / 运行时：Node.js（ESM，无安装依赖）
- 框架：Cordis 插件（DSH Web profile 组合层 insert 行）
- 上游 API：Kimi（Anthropic 协议，`https://api.kimi.com/coding/v1/messages`）
- schema 编译：动态发现宿主部署（`~/.npm/_npx/*`）里的 `@deepseek-ai/dsh-tools` 的 `defineTool`，与内置工具同构；发现失败回退本地等价编译（已与 defineTool 逐字节比对）

## 文件结构

- `lib/entry.js`：稳定薄入口。loader 热重载只在**行 name 变化**时才重新 import，且裸 import 走 ESM 缓存；entry 用 `import.meta.url` 的查询参数缓存破坏，转发到 `impl.js`。
- `lib/impl.js`：全部实现（工具定义、路径解析、Kimi API 调用）。
- `lib/index.js`：包根转发。

## 启动

```bash
# 安装进 profile（符号链接，仿照 dsh-usage-meter）
ln -sfn ~/workspace/dsh_workspace/kimi-eyes ~/.dsh/profiles/web/node_modules/kimi-eyes
# cordis.patch.yml 行名是相对文件 specifier（带 ?v=N）：
#   name: './node_modules/kimi-eyes/lib/entry.js?v=1'
```

## 热更新协议（重要）

1. 改 `lib/impl.js` → 把 patch 里行名末尾 `?v=N` **递增** → 保存，即热更新。
2. 改 `lib/entry.js` 或 `package.json` → 同样递增 `?v=N`。
3. 只改行 config（如 model）→ 直接保存即可。

密钥读取顺序：`KIMI_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `~/.codex/config.toml` 的 `ANTHROPIC_AUTH_TOKEN`。

## 验证

```bash
# 语法检查
node --check lib/entry.js && node --check lib/impl.js
# 端到端：模拟 loader 导入路径 + 注册 + 真实调用 Kimi API
node -e "
const mod = await import('file://' + process.env.HOME + '/.dsh/profiles/web/node_modules/kimi-eyes/lib/entry.js?v=1')
let def
mod.apply({ tools: { register(d) { def = d } } }, {})
console.log('parameters:', JSON.stringify(def.parameters))
console.log('output:', JSON.stringify(def.output.schema))
const v = await def.execute(
  { file_path: '/tmp/test.png', question: '读出图片里的所有文字。' },
  { agent: undefined, signal: new AbortController().signal },
)
console.log('ANSWER:', v.answer)
"
```
