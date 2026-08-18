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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name. */
export declare const name = "dsh-file-attach-client";
/** Declare service dependencies. */
export declare const inject: readonly ["slots"];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map