/**
 * kimi-eyes — 实现。
 *
 * 给 DSH 主 agent 装上「眼睛」：注册 `kimi_vision` 工具，把图片交给
 * Kimi K3 视觉模型（Anthropic 协议，api.kimi.com/coding/v1/messages）
 * 识别，返回文本描述。适用于主模型路由不支持图片输入、或用户明确
 * 要求看某张图片的场景（截图、图表、照片、扫描件）。
 *
 * 工具定义优先用应用自带的 @deepseek-ai/dsh-tools 的 defineTool 编译
 * （与内置工具完全同构，function schema 必然是合法 JSON Schema）；
 * 宿主依赖装在 ~/.npm/_npx/<版本>/ 里，本包是符号链接进 profile
 * node_modules 的（ESM 从真实路径向上解析，找不到宿主 node_modules），
 * 所以按目录 mtime 动态发现最新部署里的 dsh-tools，harness 升级后
 * 自动跟随。发现失败时回退到本地等价编译（形态已与 defineTool 逐字节
 * 比对，见 CLAUDE.md 验证一节）。
 *
 * 密钥读取顺序：KIMI_API_KEY → ANTHROPIC_AUTH_TOKEN →
 * ~/.codex/config.toml 里的 ANTHROPIC_AUTH_TOKEN。
 * @module kimi-eyes/impl
 */

import { readFile, stat, readdir } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'kimi-eyes'

/** 需要的服务（Loader 会在 apply 前解析好）。 */
export const inject = ['tools']

// ---------------------------------------------------------------------------
// defineTool：动态发现宿主部署里的真实编译器，失败回退本地等价实现
// ---------------------------------------------------------------------------

/** 按安装时间新→旧，返回各 npx 部署里 dsh-tools 入口文件的候选路径。 */
async function findDshToolsCandidates() {
  const candidates = []
  try {
    const npxRoot = join(homedir(), '.npm', '_npx')
    const dirs = await readdir(npxRoot)
    const found = []
    for (const dir of dirs) {
      const file = join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
      try {
        const info = await stat(file)
        if (info.isFile()) found.push({ file, mtimeMs: info.mtimeMs })
      } catch {
        /* 该部署目录没有 dsh-tools */
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    candidates.push(...found.map((f) => f.file))
  } catch {
    /* ~/.npm/_npx 不存在 */
  }
  return candidates
}

async function loadDefineTool() {
  for (const file of await findDshToolsCandidates()) {
    try {
      const mod = await import(`file://${file}`)
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined
}

/** 把 author 方言的逐字段 spec 编译成 JSON Schema 属性表（properties + required）。 */
function compileProperties(spec) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = prop
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { properties, required }
}

/**
 * 回退编译：等价于 defineTool 对「对象根 + 字符串/数字/布尔标量属性」
 * 的处理（本项目只用这种形态）。仅当宿主 dsh-tools 发现失败时使用。
 */
function fallbackDefineTool(options) {
  const params = compileProperties(options.parameters)
  const out = compileProperties(options.output.schema.properties)
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: params.properties,
      ...(params.required.length > 0 ? { required: params.required } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: options.output.schema.additionalProperties ?? true,
        properties: out.properties,
        ...(out.required.length > 0 ? { required: out.required } : {}),
      },
      render: options.output.render,
    },
    ...(options.isConcurrencySafe !== undefined ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    execute: options.execute,
    ...(options.presentCall !== undefined ? { presentCall: options.presentCall } : {}),
  }
}

/** 顶层 await：模块求值期完成，apply 保持同步（loader 会等 import 完成）。 */
const defineTool = (await loadDefineTool()) ?? fallbackDefineTool

// ---------------------------------------------------------------------------
// 配置默认值
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding'
const DEFAULT_MODEL = 'kimi-k3'
const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 180_000

/** 支持的图片扩展名 → media type（与内置 read_image 保持一致）。 */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const DEFAULT_QUESTION =
  '请详细描述这张图片的内容，包括其中的文字、图表、结构、关键信息和值得注意的细节。'

// ---------------------------------------------------------------------------
// API Key：env 优先，回退读取 ~/.codex/config.toml（30s 缓存，失败可重试）
// ---------------------------------------------------------------------------

let cachedApiKey
let cachedKeyAt = 0

async function loadApiKey() {
  const envKey = process.env.KIMI_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN
  if (envKey) return envKey
  const now = Date.now()
  if (cachedApiKey !== undefined && now - cachedKeyAt < 30_000) return cachedApiKey
  try {
    const text = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8')
    const match = /^ANTHROPIC_AUTH_TOKEN\s*=\s*"([^"]+)"/m.exec(text)
    cachedApiKey = match?.[1] ?? ''
  } catch {
    cachedApiKey = ''
  }
  cachedKeyAt = now
  return cachedApiKey
}

// ---------------------------------------------------------------------------
// 核心：把一张图交给 Kimi 视觉模型
// ---------------------------------------------------------------------------

/** 组合 exec.signal 与超时，返回 controller + 清理函数。 */
function withTimeout(signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('kimi_vision 请求超时')), DEFAULT_TIMEOUT_MS)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

async function describeImage(absPath, mediaType, question, config, exec) {
  const info = await stat(absPath).catch(() => undefined)
  if (info === undefined) throw new Error(`找不到图片文件：${absPath}`)
  if (!info.isFile()) throw new Error(`不是普通文件：${absPath}`)
  const maxBytes = config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  if (info.size > maxBytes) {
    throw new Error(`图片过大（${info.size} bytes，上限 ${maxBytes} bytes）：${absPath}`)
  }

  const data = await readFile(absPath)
  const apiKey = await loadApiKey()
  if (!apiKey) {
    throw new Error(
      '未找到 Kimi API Key：请设置 KIMI_API_KEY 或 ANTHROPIC_AUTH_TOKEN 环境变量，或确认 ~/.codex/config.toml 里有 ANTHROPIC_AUTH_TOKEN',
    )
  }

  const baseUrl = String(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = String(config.model ?? DEFAULT_MODEL)
  const guard = withTimeout(exec.signal)
  try {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
              },
              { type: 'text', text: question },
            ],
          },
        ],
      }),
      signal: guard.signal,
    })
    const raw = await resp.text()
    if (!resp.ok) {
      let detail = raw
      try {
        detail = JSON.parse(raw)?.error?.message ?? raw
      } catch {
        /* 保留原始响应 */
      }
      throw new Error(`Kimi 识图失败（HTTP ${resp.status}）：${String(detail).slice(0, 500)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Kimi 返回了无法解析的响应：${raw.slice(0, 300)}`)
    }
    const blocks = Array.isArray(parsed?.content) ? parsed.content : []
    const answer = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')
      .trim()
    if (!answer) throw new Error(`Kimi 未返回文本内容：${raw.slice(0, 300)}`)
    return answer
  } finally {
    guard.dispose()
  }
}

// ---------------------------------------------------------------------------
// 工具定义与注册
// ---------------------------------------------------------------------------

/**
 * 构造 kimi_vision 工具定义（独立导出，便于脚本测试整条链路）。
 * 参数/输出 schema 经 defineTool 编译，与内置工具同构。
 * @param {object} config - row config（model / baseUrl / maxTokens / maxImageBytes）。
 */
export function buildTool(config) {
  return defineTool({
    name: 'kimi_vision',
    description:
      '用 Kimi K3 视觉模型识别图片内容（PNG/JPEG/WebP/GIF）。当用户让你看某张图、需要识别截图/图表/照片/扫描件里的文字或内容、或需要回答关于图片的问题，而当前模型无法直接看图时使用。',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '图片文件路径；相对路径按当前会话工作目录解析，支持 ~ 开头。',
      },
      question: {
        type: 'string',
        description: '针对图片的具体问题（中文）；省略时默认详细描述图片内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = String(args.file_path ?? '').trim()
      if (!filePath) throw new Error('file_path 不能为空')
      const ext = extname(filePath).toLowerCase()
      const mediaType = MEDIA_TYPES[ext]
      if (mediaType === undefined) {
        throw new Error(`kimi_vision 只支持 PNG/JPEG/WebP/GIF 图片：${filePath}`)
      }
      const question =
        typeof args.question === 'string' && args.question.trim()
          ? args.question.trim()
          : DEFAULT_QUESTION

      // 会话工作目录解析（与内置 fs 工具一致：exec.agent.session.header.cwd）
      const cwd = exec.agent?.session?.header?.cwd
      let absPath = filePath
      if (filePath === '~' || filePath.startsWith('~/')) {
        absPath = join(homedir(), filePath.slice(2))
      } else if (!isAbsolute(absPath)) {
        absPath = resolve(cwd ?? process.cwd(), absPath)
      }

      const answer = await describeImage(absPath, mediaType, question, config, exec)
      return { answer }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Kimi 识图 ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  })
}

/** profile 组合层入口：注册工具，随行热重载自动换绑。 */
export function apply(ctx, config = {}) {
  ctx.tools.register(buildTool(config))
}
