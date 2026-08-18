/**
 * dsh-file-attach — Host half (static Cordis plugin, TypeScript).
 *
 * Systematically injects file/selection attachments into the DSH prompt system
 * via the `agent/pre-step` waterfall (official DSH extension point).
 *
 * 注入点 = agent/pre-step waterfall(DSH 官方扩展点)。已对照源码验证:
 *   dsh-agent-loop turn(): for (const message of decision.messages)
 *                            this.session.append('user/message', message, ...)
 *   step(): buildRequest(..., this.session.deriveMessages(), ...)
 * —— waterfall 返回的 messages 既写入持久日志,又进入模型请求,
 *    model-visible ⟺ logged 由构造保证,无需扩展自维护 messages[]、不改 vendor。
 *
 * @module dsh-file-attach/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Attachment, Suggestion, AddItemRaw, AttachmentsResult, AddResult } from './types.js'

/** Cordis plugin name. */
export const name = 'dsh-file-attach'

/**
 * 注入声明：静态插件不依赖 dynamicCordisRunner，
 * 但保留 inject 确保 tools 服务就绪（供工具注册用）。
 */
export const inject = ['tools']

// ---- internal state ----

/** Per-session attachment store: sessionId → Attachment[] */
let store: Map<string, Attachment[]>
/** Per-session suggestion store: sessionId → Suggestion[] */
let suggests: Map<string, Suggestion[]>
/** One-shot consumption bookkeeping: sessionId → { turn, step } */
let pendingClear: Map<string, { turn: number; step: number }>
let seq = 0

function initIfNeeded(): void {
  if (store === undefined) {
    store = new Map()
    suggests = new Map()
    pendingClear = new Map()
  }
}

function snapshot(sessionId: string): Attachment[] {
  return (store.get(sessionId) ?? []).map((a) => ({ ...a }))
}

function snapshotSuggests(sessionId: string): Suggestion[] {
  return (suggests.get(sessionId) ?? []).map((s) => ({ ...s }))
}

// ---- helpers ----

/** Validate path is a real, accessible, regular file. */
async function isRealFile(ctx: Context, path: string): Promise<boolean> {
  const fs = ctx.get('fs')
  if (fs === undefined) return false
  try {
    const target = await fs.resolve(path)
    const info = await fs.stat(target)
    return !!(info && info.type === 'file')
  } catch {
    return false
  }
}

/** Normalize line ranges: only valid 1-based numeric ranges, max 32 segments. */
function normalizeRanges(raw: unknown): { startLine: number; endLine: number }[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) return null
  const out: { startLine: number; endLine: number }[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null
    const s = (r as Record<string, unknown>).startLine
    const e = (r as Record<string, unknown>).endLine
    if (typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e))
      return null
    const start = Math.max(1, Math.floor(s))
    const end = Math.max(start, Math.floor(e))
    out.push({ startLine: start, endLine: end })
  }
  return out.length > 0 ? out : null
}

function sameRanges(
  a: readonly { startLine: number; endLine: number }[] | undefined,
  b: readonly { startLine: number; endLine: number }[] | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((r, i) => b[i] !== undefined && r.startLine === b[i]!.startLine && r.endLine === b[i]!.endLine)
}

function lineCountOf(ranges: readonly { startLine: number; endLine: number }[] | undefined): number {
  return (ranges ?? []).reduce((t, r) => t + (r.endLine - r.startLine + 1), 0)
}

/** Read file content by line ranges (1-based). fs.readBytes 1 MiB limit; content 20k truncation. */
async function readSelectionContent(
  ctx: Context,
  path: string,
  ranges: readonly { startLine: number; endLine: number }[],
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const fs = ctx.get('fs')
  if (fs === undefined) return { ok: false, error: 'fs-unavailable' }
  try {
    const target = await fs.resolve(path)
    const bytes = await fs.readBytes(target, undefined, 1024 * 1024)
    const text = new TextDecoder('utf-8').decode(bytes)
    const lines = text.split('\n')
    const parts: string[] = []
    for (const r of ranges) {
      const s = Math.max(1, r.startLine)
      const e = Math.min(lines.length, r.endLine)
      if (s > e) continue
      parts.push(lines.slice(s - 1, e).join('\n'))
    }
    if (parts.length === 0) return { ok: false, error: 'empty-selection' }
    let content = parts.join('\n')
    if (content.length > 20000) content = content.slice(0, 20000) + '\n…[truncated at 20000 chars]'
    return { ok: true, content }
  } catch {
    return { ok: false, error: 'cannot-read: ' + path }
  }
}

// ---- core: add items ----

async function addItems(
  ctx: Context,
  sessionId: string,
  items: AddItemRaw[],
): Promise<AddResult> {
  const errors: string[] = []
  const list = store.get(sessionId) ?? []
  const sug = suggests.get(sessionId) ?? []

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      errors.push('invalid-item')
      continue
    }
    const kind: Attachment['kind'] =
      item.kind === 'content' ? 'content' : item.kind === 'selection' ? 'selection' : 'file'
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    if (!path || path.length > 8192) {
      errors.push('bad-path')
      continue
    }

    if (kind === 'content') {
      const content = typeof item.content === 'string' ? item.content : ''
      if (content.length > 20000) { errors.push('content-too-large'); continue }
      if (!content) { errors.push('empty-content'); continue }
      if (!list.some((a) => a.kind === 'content' && a.path === path))
        list.push({ id: 'dshfa-' + (++seq), kind, path, content })
    } else if (kind === 'selection') {
      const ranges = normalizeRanges(item.ranges)
      if (!ranges) { errors.push('bad-ranges'); continue }
      // v16: invalid paths silently skipped
      if (!(await isRealFile(ctx, path))) continue
      if (list.some((a) => a.kind === 'selection' && a.path === path && sameRanges(a.ranges, ranges))) continue
      const read = await readSelectionContent(ctx, path, ranges)
      if (!read.ok) { errors.push(read.error); continue }
      list.push({ id: 'dshfa-' + (++seq), kind, path, ranges, content: read.content })
    } else {
      // v16: invalid paths silently skipped
      if (!(await isRealFile(ctx, path))) continue
      if (!list.some((a) => a.kind === 'file' && a.path === path))
        list.push({ id: 'dshfa-' + (++seq), kind, path, content: '' })
    }

    if (list.length >= 16) break
  }

  // Remove same-name suggestions after formal attachment
  if (sug.length > 0) {
    suggests.set(
      sessionId,
      sug.filter((s) => {
        if (s.kind === 'selection') {
          return !list.some((a) => a.kind === 'selection' && a.path === s.path && sameRanges(a.ranges, s.ranges))
        }
        return !list.some((a) => a.kind === 'file' && a.path === s.path)
      }),
    )
  }

  store.set(sessionId, list)
  return { attachments: snapshot(sessionId), suggestions: snapshotSuggests(sessionId), errors }
}

// ---- format prompt injection block ----

function formatRangesText(ranges: readonly { startLine: number; endLine: number }[] | undefined): string {
  return (ranges ?? [])
    .map((r) => (r.startLine === r.endLine ? String(r.startLine) : r.startLine + '-' + r.endLine))
    .join(', ')
}

function renderIndexBlock(list: Attachment[]): string {
  const lines: string[] = []
  let total = 0
  for (const a of list) {
    const line =
      a.kind === 'content'
        ? `User attached content from file '${a.path}': ${a.content}`
        : a.kind === 'selection'
          ? `User attached selected lines ${formatRangesText(a.ranges)} from file '${a.path}': ${a.content}`
          : `User attached file: '${a.path}'`
    total += line.length
    if (total > 100000) break
    lines.push(line)
  }
  return lines.join('\n')
}

// ---- plugin apply ----

/**
 * Register the dsh-file-attach host plugin.
 *
 * 注入点: `agent/pre-step` waterfall — 注入已附着文件/选区的 prompt injection 块。
 * 仅当本次 step 有真实用户消息(user source)时注入,工具结果步不触发。
 * 一次性消费: 注入所在 step 的 step/end 后清空附着列表。
 */
export function apply(ctx: Context): void {
  initIfNeeded()

  // ---- agent/pre-step waterfall 注入 ----
  // Harness-specific waterfall event — not in base Cordis Events type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.on('agent/pre-step' as any, async (payload: any, next: () => Promise<any>) => {
    let decision: { kind: string; messages: unknown[] }
    try {
      decision = (await next()) as { kind: string; messages: unknown[] }
    } catch (error) {
      throw error
    }
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const agent = (payload as Record<string, unknown>).agent as Record<string, unknown> | undefined
      const sessionId = agent && typeof agent.id === 'string' ? agent.id : ''
      if (!sessionId) return decision
      const list = store.get(sessionId)
      if (!list || list.length === 0) return decision
      const messages = (payload as Record<string, unknown>).messages as Array<Record<string, unknown>> | undefined
      const hasUser = (messages ?? []).some(
        (m) => m && m.source && (m.source as Record<string, unknown>).kind === 'user',
      )
      if (!hasUser) return decision
      const text = renderIndexBlock(list)
      if (!text) return decision
      const injected = {
        id: `dsh-file-attach:${sessionId}:${++seq}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-file-attach' },
      }
      // Insert after user messages, before runtime context snapshots
      const msgs = [...decision.messages]
      const anchor = msgs.findIndex(
        (m: any) => m && m.source && m.source.kind !== 'user',
      )
      if (anchor === -1) msgs.push(injected)
      else msgs.splice(anchor, 0, injected)
      // Bookkeep for one-shot consumption
      pendingClear.set(sessionId, {
        turn: (payload as Record<string, unknown>).turn as number,
        step: (payload as Record<string, unknown>).step as number,
      })
      return { kind: 'enter', messages: msgs }
    } catch (error) {
      console.error('dsh-file-attach: pre-step injection skipped', error)
      return decision
    }
  })

  // ---- session/event: one-shot consumption ----
  // Harness-specific event.
  ctx.on('session/event' as any, (session: any, event: any) => {
    if (!event || typeof event.type !== 'string') return
    const id = session && typeof session.id === 'string' ? session.id : ''
    if (!id) return
    const pending = pendingClear.get(id)
    if (!pending) return
    const data = event.data as Record<string, unknown> | undefined
    if (!data || typeof data.turn !== 'number') return
    const consumed =
      (event.type === 'step/end' && data.step === pending.step && data.turn === pending.turn) ||
      (event.type === 'turn/end' && data.turn === pending.turn)
    if (!consumed) return
    pendingClear.delete(id)
    store.set(id, [])
  })

  // ---- session/disposed: cleanup ----
  // Harness-specific event.
  ctx.on('session/disposed' as any, (session: any) => {
    if (session && typeof session.id === 'string') {
      store.delete(session.id)
      suggests.delete(session.id)
      pendingClear.delete(session.id)
    }
  })

  // ---- Expose RPC methods via window globals for client-side access ----
  // In a static plugin, the client cannot use `host.call()` (dynamic sandbox API).
  // Instead, we expose the methods as window globals that the client can call directly.
  // The client is injected into the same browser context by build-web-shell.mjs.
  if (typeof globalThis !== 'undefined') {
    const api = {
      list: (sessionId: string): AttachmentsResult => ({
        attachments: snapshot(sessionId),
        suggestions: snapshotSuggests(sessionId),
      }),
      add: async (sessionId: string, items: AddItemRaw[]): Promise<AddResult> => {
        if (!sessionId) return { attachments: [], suggestions: [], errors: ['bad-session'] }
        return addItems(ctx, sessionId, items.slice(0, 16))
      },
      remove: (sessionId: string, id: string): AttachmentsResult => {
        const list = store.get(sessionId) ?? []
        store.set(
          sessionId,
          list.filter((a) => a.id !== id),
        )
        return { attachments: snapshot(sessionId), suggestions: snapshotSuggests(sessionId) }
      },
      clear: (sessionId: string): AttachmentsResult => {
        store.set(sessionId, [])
        return { attachments: [], suggestions: snapshotSuggests(sessionId) }
      },
      suggest: async (sessionId: string, paths: string[]): Promise<AttachmentsResult> => {
        if (!sessionId) return { suggestions: [], attachments: [] }
        const list = store.get(sessionId) ?? []
        const attachedFiles = new Set(list.filter((a) => a.kind === 'file').map((a) => a.path))
        const next: Suggestion[] = []
        const seen = new Set<string>()
        for (const p of paths.slice(0, 16)) {
          if (typeof p !== 'string') continue
          const path = p.trim()
          if (!path || path.length > 8192 || seen.has(path) || attachedFiles.has(path)) continue
          if (!(await isRealFile(ctx, path))) continue
          seen.add(path)
          next.push({ id: 'dshfs-' + (++seq), kind: 'file', path })
        }
        const existing = suggests.get(sessionId) ?? []
        const keptSelection = existing.filter((s) => s.kind === 'selection')
        suggests.set(sessionId, [...keptSelection, ...next])
        return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
      },
      suggestSelection: async (
        sessionId: string,
        selection: { path: string; ranges: { startLine: number; endLine: number }[]; lineCount: number } | null,
      ): Promise<AttachmentsResult> => {
        if (!sessionId) return { suggestions: [], attachments: [] }
        const existing = suggests.get(sessionId) ?? []
        const keptFile = existing.filter((s) => s.kind !== 'selection')
        if (!selection || typeof selection !== 'object') {
          suggests.set(sessionId, keptFile)
          return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
        }
        const path = typeof selection.path === 'string' ? selection.path.trim() : ''
        if (!path || path.length > 8192) {
          suggests.set(sessionId, keptFile)
          return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
        }
        const ranges = normalizeRanges(selection.ranges)
        if (!ranges) {
          suggests.set(sessionId, keptFile)
          return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
        }
        const list = store.get(sessionId) ?? []
        if (list.some((a) => a.kind === 'selection' && a.path === path && sameRanges(a.ranges, ranges))) {
          suggests.set(sessionId, keptFile)
          return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
        }
        if (!(await isRealFile(ctx, path))) {
          suggests.set(sessionId, keptFile)
          return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
        }
        const lineCount =
          typeof selection.lineCount === 'number' && selection.lineCount > 0
            ? selection.lineCount
            : lineCountOf(ranges)
        suggests.set(sessionId, [...keptFile, { id: 'dshfs-' + (++seq), kind: 'selection', path, ranges, lineCount }])
        return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
      },
      suggestRemove: (sessionId: string, id: string): AttachmentsResult => {
        const sug = suggests.get(sessionId) ?? []
        suggests.set(
          sessionId,
          sug.filter((s) => s.id !== id),
        )
        return { suggestions: snapshotSuggests(sessionId), attachments: snapshot(sessionId) }
      },
      suggestClear: (sessionId: string): AttachmentsResult => {
        suggests.set(sessionId, [])
        return { suggestions: [], attachments: snapshot(sessionId) }
      },
    }

    // Expose as window.__dshFileAttachHost for client-side access
    try {
      ;(globalThis as Record<string, unknown>).__dshFileAttachHost = api
    } catch {
      /* globalThis may be frozen */
    }

    // Register HTTP route on the web server for client→host RPC
    const webServer = ctx.get('webServer') as { register?: (route: unknown) => (() => void) } | undefined
    if (webServer?.register) {
      ctx.effect(() => webServer.register!({
        kind: 'prefix',
        path: '/api/dsh-file-attach',
        handler: async (req: any, res: any) => {
          if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return }
          const url = new URL(req.url, 'http://localhost')
          const method = url.pathname.replace('/api/dsh-file-attach/', '')
          const chunks: Uint8Array[] = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(new TextDecoder().decode(
            chunks.reduce((acc, chunk) => { const n = new Uint8Array(acc.length + chunk.length); n.set(acc); n.set(chunk, acc.length); return n }, new Uint8Array(0))
          ))
          const payload = body.payload ?? body
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
          let result: unknown
          if (method === 'list') result = api.list(sessionId)
          else if (method === 'add') result = await api.add(sessionId, payload.items ?? [])
          else if (method === 'remove') result = api.remove(sessionId, payload.id ?? '')
          else if (method === 'clear') result = api.clear(sessionId)
          else if (method === 'suggest') result = await api.suggest(sessionId, payload.paths ?? [])
          else if (method === 'suggest-selection') result = await api.suggestSelection(sessionId, payload.selection ?? null)
          else if (method === 'suggest-remove') result = api.suggestRemove(sessionId, payload.id ?? '')
          else if (method === 'suggest-clear') result = api.suggestClear(sessionId)
          else { res.writeHead(404); res.end('not found'); return }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId ?? '', result: { ok: true, value: result } }))
        },
      } as never))
    }
  }
}
