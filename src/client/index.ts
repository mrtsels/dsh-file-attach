/**
 * dsh-file-attach — Client half (static Cordis plugin, TypeScript).
 *
 * Renders attachment chips + suggestion dashed boxes in the composer dock.
 * Detects paste/drop of file paths and attaches them.
 *
 * In the static plugin context, `host.call()` (dynamic sandbox API) is unavailable.
 * Client→Host communication uses:
 *   1. Direct fetch to the gateway `/api/dsh-file-attach/<method>` (preferred)
 *   2. Fallback to `window.__dshFileAttachHost` globals (same-process only)
 *
 * @module dsh-file-attach/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Attachment, Suggestion, AddItem, AttachmentsResult, AddResult } from '../host/types.js'

/** Cordis plugin name. */
export const name = 'dsh-file-attach-client'

/** Declare service dependencies — Cordis requires inject for ctx.* access. */
export const inject = ['slots'] as const

// ---- host communication layer ----

/**
 * Resolve the gateway base URL for RPC calls.
 * In the dsh web context, `__DSH_WEB_URL__` is set by the extension bridge.
 */
function getGatewayBase(): string {
  try {
    const base = (globalThis as Record<string, unknown>).__DSH_WEB_URL__
    if (typeof base === 'string' && base !== '') return base
  } catch { /* ignore */ }
  // Fallback: use current page origin (same-origin dsh web server)
  try {
    return window.location.origin
  } catch { return '' }
}

/**
 * Call a host method via the gateway RPC endpoint.
 * Falls back to window globals if gateway is unavailable (same-process dev).
 */
async function callHost(method: string, args: Record<string, unknown>): Promise<unknown> {
  // Fallback: direct window global (same-process, dev only)
  try {
    const hostApi = (globalThis as Record<string, unknown>).__dshFileAttachHost as Record<string, Function> | undefined
    if (hostApi !== undefined && typeof hostApi[method] === 'function') {
      return hostApi[method](...Object.values(args))
    }
  } catch { /* ignore */ }

  // Primary: gateway RPC
  const base = getGatewayBase()
  if (base === '') throw new Error('dsh-file-attach: no gateway available')
  const rpcId = `dshfa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(base + '/api/dsh-file-attach/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'dsh-file-attach/' + method,
      payload: args,
    }),
  })
  if (res.status !== 200) throw new Error(`dsh-file-attach: ${method} returned ${res.status}`)
  const raw: unknown = await res.json()
  const value = (raw as { result?: { ok?: boolean; value?: unknown } })?.result?.value
  return value
}

// ---- typed host RPC wrappers ----

async function hostList(sessionId: string): Promise<AttachmentsResult> {
  const result = await callHost('list', { sessionId }) as AttachmentsResult | undefined
  return result ?? { attachments: [], suggestions: [] }
}

async function hostAdd(sessionId: string, items: AddItem[]): Promise<AddResult> {
  const result = await callHost('add', { sessionId, items }) as AddResult | undefined
  return result ?? { attachments: [], suggestions: [], errors: ['no-response'] }
}

async function hostRemove(sessionId: string, id: string): Promise<AttachmentsResult> {
  const result = await callHost('remove', { sessionId, id }) as AttachmentsResult | undefined
  return result ?? { attachments: [], suggestions: [] }
}

async function hostSuggest(sessionId: string, paths: string[]): Promise<AttachmentsResult> {
  const result = await callHost('suggest', { sessionId, paths }) as AttachmentsResult | undefined
  return result ?? { suggestions: [], attachments: [] }
}

async function hostSuggestSelection(
  sessionId: string,
  selection: { path: string; ranges: { startLine: number; endLine: number }[]; lineCount: number } | null,
): Promise<AttachmentsResult> {
  const result = await callHost('suggestSelection', { sessionId, selection }) as AttachmentsResult | undefined
  return result ?? { suggestions: [], attachments: [] }
}

// ---- helpers ----

declare const React: {
  useState: <T>(initial: T) => [T, (v: T) => void]
  useRef: <T>(initial: T) => { current: T }
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => void
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown
}

declare const host: { call(method: string, args: unknown): Promise<unknown> }


function basename(path: string): string {
  return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path)
}

const EDGE_PUNCT = /^\s'"'"'([{〈《（]+|\s'"'"',;.)}]"'〉》）]+$/g

function toPath(token: string): { path: string; token: string } | null {
  const raw = String(token).replace(EDGE_PUNCT, '')
  if (!raw) return null
  // v16: reject pure slash sequences (/, //, ///…)
  if (/^\/+$/.test(raw)) return null
  if (/^file:\/\//i.test(raw)) {
    try {
      return { path: decodeURIComponent(raw.replace(/^file:\/\/[^/]*/i, '')), token: raw }
    } catch {
      return null
    }
  }
  if (/^~(?=\/|$)/.test(raw) || /^\/[^\s]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { path: raw, token: raw }
  }
  return null
}

function detectTokens(text: string): Array<{ kind: 'file'; path: string; token: string }> {
  const out: Array<{ kind: 'file'; path: string; token: string }> = []
  const seen = new Set<string>()
  for (const token of String(text).split(/\s+/)) {
    const hit = toPath(token)
    if (!hit || seen.has(hit.path)) continue
    seen.add(hit.path)
    out.push({ kind: 'file', path: hit.path, token: hit.token })
    if (out.length >= 16) break
  }
  return out
}

function stripTokens(draft: string, tokens: string[]): string {
  let next = String(draft)
  for (const token of tokens) {
    const idx = next.indexOf(token)
    if (idx !== -1) next = next.slice(0, idx) + next.slice(idx + token.length)
  }
  next = next
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return next
}

function sameRanges(
  a: readonly { startLine: number; endLine: number }[] | undefined,
  b: readonly { startLine: number; endLine: number }[] | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((r, i) => b[i] !== undefined && r.startLine === b[i]!.startLine && r.endLine === b[i]!.endLine)
}

function lineCountLabel(n: number): string {
  return n === 1 ? '1 line selected' : n + ' lines selected'
}

// ---- extension-declared active file/selection (v12/v15 protocol) ----

function extActiveFile(): string {
  try {
    const v = (globalThis as Record<string, unknown>).__dshActiveFileFsPath
    return typeof v === 'string' && v.length > 0 ? v : ''
  } catch {
    return ''
  }
}

function extActiveSelection(): { path: string; ranges: { startLine: number; endLine: number }[]; lineCount: number } | null {
  try {
    const v = (globalThis as Record<string, unknown>).__dshActiveSelection as Record<string, unknown> | undefined | null
    if (!v || typeof v !== 'object') return null
    const path = typeof v.path === 'string' ? v.path : ''
    if (!path) return null
    const rawRanges = Array.isArray(v.ranges) ? v.ranges : []
    const ranges = rawRanges
      .filter(
        (r: unknown): r is { startLine: number; endLine: number } =>
          r !== null &&
          typeof r === 'object' &&
          typeof (r as Record<string, unknown>).startLine === 'number' &&
          typeof (r as Record<string, unknown>).endLine === 'number' &&
          Number.isFinite((r as Record<string, unknown>).startLine as number) &&
          Number.isFinite((r as Record<string, unknown>).endLine as number) &&
          ((r as Record<string, unknown>).startLine as number) >= 1 &&
          ((r as Record<string, unknown>).endLine as number) >= ((r as Record<string, unknown>).startLine as number),
      )
      .map((r) => ({
        startLine: Math.floor(r.startLine),
        endLine: Math.floor(r.endLine),
      }))
    if (ranges.length === 0) return null
    const lineCount =
      typeof v.lineCount === 'number' && (v.lineCount as number) > 0
        ? (v.lineCount as number)
        : ranges.reduce((t, r) => t + (r.endLine - r.startLine + 1), 0)
    return { path, ranges, lineCount }
  } catch {
    return null
  }
}

// ---- page-level API ----

function installPageApi(currentSessionRef: { id: string }): void {
  if (typeof globalThis === 'undefined') return
  try {
    const api = {
      suggest: (paths: string[]): Promise<unknown> => {
        const sessionId = currentSessionRef.id
        if (!sessionId || !Array.isArray(paths)) return Promise.resolve({ ok: false, reason: 'no-session' })
        return hostSuggest(sessionId, paths.map((p) => String(p)).filter((p) => p.length > 0))
      },
      suggestSelection: (selection: { path: string; ranges: { startLine: number; endLine: number }[]; lineCount: number } | null): Promise<unknown> => {
        const sessionId = currentSessionRef.id
        if (!sessionId) return Promise.resolve({ ok: false, reason: 'no-session' })
        return hostSuggestSelection(sessionId, selection)
      },
      clearSuggest: (): Promise<unknown> => {
        const sessionId = currentSessionRef.id
        if (!sessionId) return Promise.resolve({ ok: false, reason: 'no-session' })
        return callHost('suggestClear', { sessionId })
      },
    }
    ;(globalThis as Record<string, unknown>).__dshFileAttach = api
  } catch { /* page API optional */ }
}

// ---- plugin apply ----

export function apply(ctx: Context): void {
  // === PROBE: confirm ctx.slots availability ===
  console.log('[dsh-file-attach] apply called')
  console.log('[dsh-file-attach] ctx type:', typeof ctx)
  console.log('[dsh-file-attach] ctx keys:', Object.keys(ctx ?? {}))
  console.log('[dsh-file-attach] ctx.slots:', (ctx as any).slots)
  console.log('[dsh-file-attach] ctx.slots?.inject:', typeof (ctx as any).slots?.inject)
  console.log('[dsh-file-attach] ctx.slots?.register:', typeof (ctx as any).slots?.register)
  // === END PROBE ===

  const cslots = (ctx as any).slots
  if (!cslots || typeof cslots.inject !== 'function') {
    console.error('[dsh-file-attach] ctx.slots unavailable — aborting')
    return
  }

  // CSS injection via direct DOM
  try {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-file-attach'
    tag.textContent = `
    .dshfa-strip { box-sizing:border-box; flex:none; margin:0 auto;
      width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
      max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
      padding:2px var(--dsh-composer-dock-inset) 0;
      flex-direction:row; flex-wrap:wrap; gap:6px; display:flex; }
    .dshfa-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
    .dshfa-suggests { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
    .dshfa-suggest { display:inline-flex; align-items:center; gap:6px; max-width:100%;
      padding:3px 8px 3px 10px; border-radius:999px; font-size:12px; line-height:1.4;
      background:var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));
      border:1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.45));
      color:var(--dsw-alias-label-secondary, inherit);
      cursor:pointer; user-select:none; }
    .dshfa-suggest:hover { background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
    .dshfa-suggest .dshfa-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px; }
    .dshfa-suggest .dshfa-add { flex:none; padding:0 0 0 3px; font-size:12px; font-weight:700; opacity:.6; }
    .dshfa-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%;
      padding:3px 10px; border-radius:999px; font-size:12px; line-height:1.4;
      background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
      border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
      color:var(--dsw-alias-label-primary, inherit); }
    .dshfa-chip .dshfa-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px; }
    .dshfa-chip .dshfa-x { cursor:pointer; font-weight:700; opacity:.6; padding:0 2px; }
    .dshfa-chip .dshfa-x:hover { opacity:1; }
    .dshfa-hint { font-size:11px; color:var(--dsw-alias-label-secondary, inherit); opacity:.7; }
  `
    document.head.append(tag)
  } catch { /* CSS injection optional */ }

  const currentSessionRef = { id: '' }
  installPageApi(currentSessionRef)

  function AttachStrip(props: {
    sessionId: string
    session?: { running?: boolean }
    input?: { draft?: string }
    inputActions?: { setDraft?: (draft: string) => void }
  }): unknown {
    const sessionId = props.sessionId
    currentSessionRef.id = sessionId
    const running = props.session?.running ?? null
    const draft = props.input?.draft ?? ''
    const setDraft = props.inputActions?.setDraft
    const [items, setItems] = React.useState<Attachment[]>([])
    const [suggests, setSuggests] = React.useState<Suggestion[]>([])
    const [error, setError] = React.useState('')
    const stashRef = React.useRef<string[]>([])

    const refresh = (result: AttachmentsResult & { errors?: string[] }) => {
      if (result && Array.isArray(result.attachments)) setItems(result.attachments)
      if (result && Array.isArray(result.suggestions)) setSuggests(result.suggestions)
      if (result && Array.isArray(result.errors) && result.errors.length > 0) setError(result.errors.join(', '))
    }

    const refreshAndBackfill = (): void => {
      hostList(sessionId).then((result) => {
        refresh(result)
        const sug = result.suggestions ?? []
        const att = result.attachments ?? []
        // File backfill
        const target = extActiveFile()
        if (target) {
          const fileSug = sug.some((s) => s.kind !== 'selection' && s.path === target)
          const fileAtt = att.some((a) => a.kind !== 'selection' && a.path === target)
          if (!fileSug && !fileAtt) {
            hostSuggest(sessionId, [target]).then(refresh).catch(() => {})
          }
        }
        // Selection backfill (v15)
        const sel = extActiveSelection()
        if (sel) {
          const selSug = sug.some((s) => s.kind === 'selection' && s.path === sel.path && sameRanges(s.ranges, sel.ranges))
          const selAtt = att.some((a) => a.kind === 'selection' && a.path === sel.path && sameRanges(a.ranges, sel.ranges))
          if (!selSug && !selAtt) {
            hostSuggestSelection(sessionId, { path: sel.path, ranges: sel.ranges, lineCount: sel.lineCount })
              .then(refresh)
              .catch(() => {})
          }
        }
      }).catch(() => {})
    }

    // Initial pull + delayed re-pull + event sync
    React.useEffect(() => {
      const timer = ctx.get('timer') as { timeout?: (fn: () => void, ms: number) => () => void } | undefined
      const d1 = timer?.timeout?.(refreshAndBackfill, 400)
      const d2 = timer?.timeout?.(refreshAndBackfill, 1500)
      const onChanged = (e: Event) => {
        const from = (e as CustomEvent).detail?.from
        if (from !== 'extension') return
        refreshAndBackfill()
      }
      window.addEventListener('dsh:attachments:changed', onChanged)
      return () => {
        d1?.()
        d2?.()
        window.removeEventListener('dsh:attachments:changed', onChanged)
      }
    }, [sessionId])

    const attachPaths = (hits: Array<{ path: string }>): void => {
      if (!hits || hits.length === 0) return
      hostAdd(
        sessionId,
        hits.map((h) => ({ kind: 'file' as const, path: h.path })),
      ).then(refresh).catch(() => {})
    }

    // One-shot consumption: running flip → resync
    const prevRunning = React.useRef(running)
    React.useEffect(() => {
      const prev = prevRunning.current
      prevRunning.current = running
      if (running === false && prev === true && items.length > 0) {
        hostList(sessionId).then(refresh).catch(() => {})
      }
    }, [running, sessionId, items.length])

    // Draft observation: stash strip only
    React.useEffect(() => {
      if (!draft) return
      const stash = stashRef.current
      if (stash.length > 0) {
        const found = stash.filter((t) => draft.indexOf(t) !== -1)
        stashRef.current = []
        if (found.length > 0 && setDraft) {
          const cleaned = stripTokens(draft, found)
          if (cleaned !== draft) setDraft(cleaned)
        }
      }
    }, [draft, sessionId])

    // Document capture paste/drop listeners
    React.useEffect(() => {
      const inComposer = (e: Event): boolean => {
        const target = e.target as HTMLElement | null
        return !!(target && typeof target.closest === 'function' && target.closest('[data-composer-card]'))
      }
      const onPaste = (e: ClipboardEvent): void => {
        if (!inComposer(e)) return
        const cd = e.clipboardData
        const text = ((cd && cd.getData('text/plain')) || '') + '\n' + ((cd && cd.getData('text/uri-list')) || '')
        const detected = detectTokens(text)
        if (detected.length === 0) return
        attachPaths(detected)
        stashRef.current = stashRef.current.concat(detected.map((d) => d.token))
      }
      const onDrop = (e: DragEvent): void => {
        if (!inComposer(e)) return
        const dt = e.dataTransfer
        const text = ((dt && dt.getData('text/uri-list')) || '') + '\n' + ((dt && dt.getData('text/plain')) || '')
        const detected = detectTokens(text)
        if (detected.length > 0) {
          e.preventDefault()
          attachPaths(detected)
        }
      }
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('drop', onDrop, true)
      return () => {
        document.removeEventListener('paste', onPaste, true)
        document.removeEventListener('drop', onDrop, true)
      }
    }, [sessionId])

    const removeItem = (id: string): void => {
      hostRemove(sessionId, id).then((result) => {
        refresh(result)
        try {
          window.dispatchEvent(new CustomEvent('dsh:attachments:changed', { detail: { from: 'plugin' } }))
        } catch { /* event optional */ }
      }).catch(() => {})
    }

    const adoptSuggest = (s: Suggestion): void => {
      hostAdd(sessionId, [{ kind: 'file', path: s.path }]).then(refresh).catch(() => {})
    }

    const adoptSelection = (s: Suggestion): void => {
      hostAdd(sessionId, [{ kind: 'selection', path: s.path, ranges: s.ranges }]).then(refresh).catch(() => {})
    }

    // Don't render if nothing to show
    if (items.length === 0 && suggests.length === 0 && !error) return null

    // Render selection suggestions before file suggestions
    const selSuggestNodes = suggests
      .filter((s) => s.kind === 'selection')
      .map((s) =>
        React.createElement(
          'span',
          {
            key: s.id,
            className: 'dshfa-suggest',
            title: s.path + ' · lines ' + (s.ranges ?? []).map((r) => r.startLine + '-' + r.endLine).join(', '),
            onClick: () => adoptSelection(s),
          },
          React.createElement('span', { className: 'dshfa-name' }, lineCountLabel(s.lineCount ?? 1)),
          React.createElement('span', { className: 'dshfa-add', 'aria-hidden': true }, '+'),
        ),
      )

    const fileSuggestNodes = suggests
      .filter((s) => s.kind !== 'selection')
      .map((s) =>
        React.createElement(
          'span',
          {
            key: s.id,
            className: 'dshfa-suggest',
            title: s.path,
            onClick: () => adoptSuggest(s),
          },
          React.createElement('span', { className: 'dshfa-name' }, basename(s.path)),
          React.createElement('span', { className: 'dshfa-add', 'aria-hidden': true }, '+'),
        ),
      )

    const chipNodes = items.map((it) =>
      React.createElement(
        'span',
        {
          key: it.id,
          className: 'dshfa-chip',
          title:
            it.kind === 'selection'
              ? it.path + ' · lines ' + (it.ranges ?? []).map((r) => r.startLine + '-' + r.endLine).join(', ')
              : it.path,
        },
        React.createElement(
          'span',
          { className: 'dshfa-name' },
          it.kind === 'selection'
            ? lineCountLabel((it.ranges ?? []).reduce((t, r) => t + (r.endLine - r.startLine + 1), 0))
            : basename(it.path),
        ),
        React.createElement('span', { className: 'dshfa-x', onClick: () => removeItem(it.id) }, '×'),
      ),
    )

    const children: unknown[] = []
    const suggestNodes = [...selSuggestNodes, ...fileSuggestNodes]
    if (suggestNodes.length > 0) children.push(React.createElement('div', { className: 'dshfa-suggests', key: 'suggests' }, ...suggestNodes))
    if (chipNodes.length > 0) children.push(React.createElement('div', { className: 'dshfa-chips', key: 'chips' }, ...chipNodes))
    if (error) children.push(React.createElement('div', { className: 'dshfa-hint', key: 'err' }, error))
    return React.createElement('div', { className: 'dshfa-strip' }, ...children)
  }

  ;(globalThis as any).__dshfaDebug = { injectCalled: false, registerCalled: false }
  cslots.inject('conversation.input.dock', () => {
    ;(globalThis as any).__dshfaDebug.injectCalled = true
    return cslots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-file-attach',
        order: 5,
        inject: (sessionId: string) => {
          ;(globalThis as any).__dshfaDebug.registerCalled = true
          return { sessionId }
        },
      },
      AttachStrip,
    )
  })
}
