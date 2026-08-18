/**
 * dsh-file-attach — shared types for Host and Client halves.
 *
 * These types are shared between the Node.js host and browser client.
 * The host manages state; the client renders UI and calls host methods.
 */

/** One attached file/selection/content item. */
export interface Attachment {
  id: string
  kind: 'file' | 'content' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  content?: string
}

/** One suggestion (not yet formally attached). */
export interface Suggestion {
  id: string
  kind: 'file' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  lineCount?: number
}

/** RPC result for list/suggest operations. */
export interface AttachmentsResult {
  attachments: Attachment[]
  suggestions: Suggestion[]
}

/** RPC result for add operation. */
export interface AddResult extends AttachmentsResult {
  errors: string[]
}

/** Item to add via the add RPC (raw input, before validation). */
export interface AddItemRaw {
  kind?: string
  path: string
  content?: string
  ranges?: unknown
}

/** Typed item to add (after validation). */
export interface AddItem {
  kind: 'file' | 'content' | 'selection'
  path: string
  content?: string
  ranges?: readonly { startLine: number; endLine: number }[]
}

/** Selection suggestion payload. */
export interface SelectionSuggestion {
  path: string
  ranges: readonly { startLine: number; endLine: number }[]
  lineCount: number
}
