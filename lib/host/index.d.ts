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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name. */
export declare const name = "dsh-file-attach";
/**
 * 注入声明：静态插件不依赖 dynamicCordisRunner，
 * 但保留 inject 确保 tools 服务就绪（供工具注册用）。
 */
export declare const inject: string[];
/**
 * Register the dsh-file-attach host plugin.
 *
 * 注入点: `agent/pre-step` waterfall — 注入已附着文件/选区的 prompt injection 块。
 * 仅当本次 step 有真实用户消息(user source)时注入,工具结果步不触发。
 * 一次性消费: 注入所在 step 的 step/end 后清空附着列表。
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map