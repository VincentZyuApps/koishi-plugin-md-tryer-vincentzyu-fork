import { Context, Schema, h } from 'koishi'
import { examples } from './markdown-example'

/**
 * 🤖 md-tryer 插件名称
 * 用于在 QQ 平台发送原生 Markdown 消息
 */
export const name = 'md-tryer'

/**
 * ⚙️ 插件配置接口
 */
export interface Config {
  /** 🔍 是否在控制台输出详细调试信息 */
  verboseConsoleInfo?: boolean
  /** 🌐 是否允许在非 QQ 平台以纯文本形式发送 */
  allowOtherPlatform?: boolean
  /** 💬 发送消息时是否引用回复触发指令的原消息 */
  enableQuote?: boolean
  /** 📝 自定义的 Markdown 示例数组 */
  examples?: string[]
}

/**
 * 🛠️ 插件配置定义 (Schema)
 */
export const Config: Schema<Config> = Schema.object({
  verboseConsoleInfo: Schema.boolean()
    .default(true)
    .description('🔍 开启调试模式：在控制台打印即将发送的 Markdown 原始内容'),
  
  allowOtherPlatform: Schema.boolean()
    .default(true)
    .description('🌐 跨平台兼容：允许在非 QQ 平台（如 Telegram, Discord）以纯文本形式发送 Markdown'),
  
  enableQuote: Schema.boolean()
    .default(true)
    .description('💬 引用回复：发送消息时自动引用触发该指令的原始消息'),
  
  examples: Schema.array(Schema.string().role('textarea', { rows: [10, 20] }))
    .default(examples)
    .role('')
    .description('📚 Markdown 示例库：预置的 Markdown 模板数组，可通过 --example 索引调用'),
})

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {}
}

function readHeader(headers: unknown, name: string): unknown {
  const source = asRecord(headers)
  if (typeof source.get === 'function') return source.get(name)
  return source[name] || source[name.toLowerCase()]
}

function stringifyForLog(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2)
    return result === undefined ? String(value) : result
  } catch (error) {
    return `[无法序列化: ${error instanceof Error ? error.message : String(error)}]`
  }
}

function getQqErrorDetails(error: unknown, payload: unknown) {
  const source = asRecord(error)
  const response = asRecord(source.response)
  const responseData = response.data
  const data = asRecord(responseData)
  const traceId = data.trace_id || readHeader(response.headers, 'x-tps-trace-id')

  return {
    name: source.name || (error instanceof Error ? error.name : typeof error),
    message: source.message || String(error),
    code: source.code,
    stack: source.stack || (error instanceof Error ? error.stack : undefined),
    requestPayload: payload,
    response: {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      code: data.code ?? data.err_code,
      message: data.message,
      traceId,
      data: responseData,
    },
  }
}

function formatQqErrorForLog(error: unknown, payload: unknown): string {
  const details = getQqErrorDetails(error, payload)
  return [
    '💥 ========== QQ Markdown 发送失败详情 ==========',
    `异常类型: ${details.name}`,
    `异常消息: ${details.message}`,
    `异常代码: ${details.code ?? '(无)'}`,
    `HTTP 状态: ${details.response.status ?? '(无)'} ${details.response.statusText ?? ''}`.trimEnd(),
    `请求 URL: ${details.response.url ?? '(无)'}`,
    `QQ 业务码: ${details.response.code ?? '(无)'}`,
    `QQ 返回消息: ${details.response.message ?? '(无)'}`,
    `QQ trace_id: ${details.response.traceId ?? '(无)'}`,
    `请求 payload:\n${stringifyForLog(details.requestPayload)}`,
    `响应原始 JSON:\n${stringifyForLog(details.response.data)}`,
    `Stack trace:\n${details.stack || '(无)'}`,
    '💥 ==============================================',
  ].join('\n')
}

function formatQqErrorForReply(error: unknown): string {
  const details = getQqErrorDetails(error, undefined)
  const parts = [details.message]
  if (details.response.code !== undefined) parts.push(`QQ code: ${details.response.code}`)
  if (details.response.message) parts.push(`QQ message: ${details.response.message}`)
  if (details.response.traceId) parts.push(`trace_id: ${details.response.traceId}`)
  return parts.join('；')
}

/**
 * 📤 核心发送函数：将 Markdown 内容发送到 QQ 平台
 * @param session - 当前会话上下文
 * @param content - 要发送的 Markdown 原始字符串
 * @param config - 插件配置对象
 */
async function sendMarkdown(session, content: string, config: Config) {
  // 🚫 平台校验：确保仅在 QQ 平台执行
  if (session.platform !== 'qq') {
    return config.enableQuote 
      ? h.quote(session.messageId) + '❌ 此指令仅支持 QQ 平台的原生 Markdown。' 
      : '❌ 此指令仅支持 QQ 平台的原生 Markdown。'
  }

  // 🖨️ 调试日志：打印即将发送的内容
  if (config.verboseConsoleInfo) {
    session.app.logger('md-tryer').info('🚀 ========== 准备发送 Markdown ==========')
    session.app.logger('md-tryer').info('📏 内容长度:', content.length)
    session.app.logger('md-tryer').info('👀 内容预览 (前200字符):', content.substring(0, 200))
    session.app.logger('md-tryer').info('📄 完整内容:')
    session.app.logger('md-tryer').info(content)
    session.app.logger('md-tryer').info('✅ =======================================')
  }

  const payload = {
    msg_id: session.messageId,
    msg_type: 2, // 2 代表 Markdown 消息类型
    markdown: {
      content,
    },
  }

  try {
    // 📨 调用 QQ Bot API 发送原生 Markdown 消息
    await session.bot.internal.sendMessage(session.channelId, payload)
    
    if (config.verboseConsoleInfo) {
      session.app.logger('md-tryer').info('✨ Markdown 发送成功')
    }
  } catch (error) {
    // ❌ 预格式化完整错误，确保控制台和持久化日志不会只剩 Bad Request
    session.app.logger('md-tryer').error(formatQqErrorForLog(error, payload))
    const errorMsg = `❌ Markdown 发送失败。${formatQqErrorForReply(error)}`
    return config.enableQuote ? h.quote(session.messageId) + errorMsg : errorMsg
  }
}

/**
 * 🚀 插件主入口函数
 * @param ctx - Koishi 上下文对象
 * @param config - 用户配置的参数
 */
export function apply(ctx: Context, config: Config) {
  // 📊 动态计算示例列表的最大索引，用于生成帮助文档中的范围提示
  const exampleList = config.examples || examples
  const maxIndex = exampleList.length - 1

  /**
   * 💬 命令：echo-md
   * 功能：直接发送指定的 Markdown 内容或预置示例
   */
  ctx.command('echo-md <text:text>', '📝 以原生 Markdown 形式回显内容')
    .option('example', `-e, --example <index:number> 🎲 发送预置的 Markdown 示例，范围 [0, ${maxIndex}]`)
    .option('raw', '--raw 🛠️ 强制以纯文本形式发送（不进行 Markdown 渲染）')
    .action(async ({ session, options }, text) => {
      const quote = config.enableQuote ? h.quote(session.messageId) : ''

      // 🔢 处理 --example 选项：从预置库中选取模板
      if (options.example !== undefined) {
        const index = Number(options.example)
        if (isNaN(index) || index < 0 || index > maxIndex) {
          return quote + `❌ 示例索引必须在 [0, ${maxIndex}] 范围内`
        }
        text = exampleList[index]
      } else if (!text) {
        // ⚠️ 既没给内容也没选示例，提示用户
        return quote + '⚠️ 请输入内容或使用 --example 选项'
      }

      // 🌐 非 QQ 平台处理逻辑
      if (session.platform !== 'qq') {
        if (!config.allowOtherPlatform) {
          return quote + '❌ 此指令仅支持 QQ 平台的原生 Markdown。'
        }
        if (config.verboseConsoleInfo) {
          ctx.logger.info('[RAW模式] 发送内容:', text)
        }
        await session.send(quote + text)
        return
      }

      // 🛠️ RAW 模式：在 QQ 平台也以纯文本发送
      if (options.raw) {
        if (config.verboseConsoleInfo) {
          ctx.logger.info('[RAW模式] 发送内容:', text)
        }
        await session.send(quote + text)
        return
      }

      // ✨ Markdown 模式：调用核心发送函数
      if (config.verboseConsoleInfo) {
        ctx.logger.info('[Markdown模式] 发送内容:', text)
      }

      return sendMarkdown(session, text, config)
    })

  /**
   * ⏳ 命令：echo-md-prompt
   * 功能：交互式获取下一条消息并作为 Markdown 发送
   */
  ctx.command('echo-md-prompt', '⏳ 使用 session.prompt() 将下一条消息以原生 Markdown 回显')
    .action(async ({ session }) => {
      const quote = config.enableQuote ? h.quote(session.messageId) : ''

      // 🌐 非 QQ 平台处理逻辑
      if (session.platform !== 'qq') {
        if (!config.allowOtherPlatform) {
          return quote + '❌ 此指令仅支持 QQ 平台的原生 Markdown。'
        }
        await session.send(quote + '✉️ 请发送下一条消息作为 Markdown 内容。')
        const next = await session.prompt()
        if (!next) return quote + '❌ 未获取到内容。'
        
        // 🔄 提取 prompt 返回的原始文本内容
        let rawContent: string
        if (typeof next === 'string') {
          rawContent = next
          if (config.verboseConsoleInfo) {
            session.app.logger('md-tryer').info('[prompt返回值类型] string')
          }
        } else if (next && typeof next === 'object') {
          // Message 对象，尝试获取其 content 属性
          rawContent = (next as any).content || String(next)
          if (config.verboseConsoleInfo) {
            session.app.logger('md-tryer').info('[prompt返回值类型] object')
            session.app.logger('md-tryer').info('[prompt返回值完整对象]:', JSON.stringify(next, null, 2))
          }
        } else {
          rawContent = String(next)
          if (config.verboseConsoleInfo) {
            session.app.logger('md-tryer').info('[prompt返回值类型] other:', typeof next)
          }
        }
        
        if (config.verboseConsoleInfo) {
          session.app.logger('md-tryer').info('[RAW模式] 提取后的内容:', rawContent)
        }
        await session.send(quote + rawContent)
        return
      }

      // ⏳ QQ 平台交互流程
      await session.send(quote + '✉️ 请发送下一条消息作为 Markdown 文稿内容。')
      const next = await session.prompt()
      if (!next) return quote + '❌ 未获取到文稿内容。'

      // 🔄 提取 prompt 返回的原始文本内容（保留 Markdown 格式）
      let rawContent: string
      if (typeof next === 'string') {
        rawContent = next
        if (config.verboseConsoleInfo) {
          session.app.logger('md-tryer').info('[prompt返回值类型] string')
        }
      } else if (next && typeof next === 'object') {
        // Message 对象，尝试获取其 content 属性
        rawContent = (next as any).content || String(next)
        if (config.verboseConsoleInfo) {
          session.app.logger('md-tryer').info('[prompt返回值类型] object')
          session.app.logger('md-tryer').info('[prompt返回值完整对象]:', JSON.stringify(next, null, 2))
        }
      } else {
        rawContent = String(next)
        if (config.verboseConsoleInfo) {
          session.app.logger('md-tryer').info('[prompt返回值类型] other:', typeof next)
        }
      }
      
      if (config.verboseConsoleInfo) {
        session.app.logger('md-tryer').info('[Markdown模式] 提取后的内容:', rawContent)
      }

      return sendMarkdown(session, rawContent, config)
    })
}
