# dsh-file-attach

[English](#english) · [中文](#中文)

---

## 中文

### 简介

`dsh-file-attach` 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的 Cordis 插件，用于将文件和代码选区系统性地注入 DSH 的提示词（prompt）体系。

在 DSH 对话中，用户可以通过以下方式附着文件或代码片段：

- **粘贴/拖放路径**：在输入框粘贴文件路径（如 `/path/to/file.ts`），自动识别并附着
- **建议附着**：扩展浏览的文件或选区自动以虚线框提示，点击即可正式附着
- **手动附着**：通过插件 API 主动添加文件或代码选区

附着的文件在下次模型调用时自动注入提示词，模型可直接读取文件内容作为上下文。

### UI 预览

**已附着实心 chips** — 文件正式附着后显示，`×` 可移除：

![Attached files](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/dsh-file-attach-attached-files.png)

**虚线建议 chips** — IDE 正在浏览的文件/选区，点击任意处即可正式附着：

![Suggested attachments](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/dsh-file-attach-suggested-attachments.png)

**完整视图** — 建议区与附着区同一行，选区建议排在文件建议之前：

![Full demo](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/demo-full.png)

### 工作原理

插件采用 **双半架构**（Host + Client），通过 DSH 官方扩展点 `agent/pre-step` 实现 prompt 注入：

```
┌─────────────┐         ┌─────────────┐
│  Host (Node)│         │Client (Web) │
│             │  RPC    │             │
│ prompt 注入  │◄──────►│ UI 渲染     │
│ 状态管理     │        │ 路径检测     │
│ 文件读取     │        │ 建议展示     │
└─────────────┘         └─────────────┘
```

- **Host 侧**（`src/host/`）：运行在 Node.js 进程中，负责 prompt 注入、状态管理和文件内容读取
- **Client 侧**（`src/client/`）：运行在浏览器 webview 中，负责 UI 渲染、路径检测和交互

### 安装

```bash
# 作为 npm 包安装
npm install dsh-file-attach

# 或通过 pnpm
pnpm add dsh-file-attach
```

### 使用

插件通过 `cordis.patch.yml` 静态注册到 DSH 运行时。Host 和 Client 分别导出 `apply` 函数：

```typescript
// Host 侧注册（Node.js 进程内）
import { apply as hostApply } from 'dsh-file-attach/host'
hostApply(ctx)  // ctx: Cordis Context

// Client 侧注册（浏览器 webview 内）
import { apply as clientApply } from 'dsh-file-attach/client'
clientApply(ctx)
```

### API 参考

Host 侧通过 `window.__dshFileAttachHost` 暴露以下方法：

| 方法 | 参数 | 说明 |
|------|------|------|
| `list(sessionId)` | — | 获取当前会话的附着和建议列表 |
| `add(sessionId, items)` | `items: AddItem[]` | 添加文件/选区/内容附着 |
| `remove(sessionId, id)` | — | 移除指定附着 |
| `clear(sessionId)` | — | 清空所有附着 |
| `suggest(sessionId, paths)` | `paths: string[]` | 设置文件建议列表 |
| `suggestSelection(sessionId, sel)` | `sel \| null` | 设置选区建议（替换式） |
| `suggestRemove(sessionId, id)` | — | 移除指定建议 |
| `suggestClear(sessionId)` | — | 清空所有建议 |

Client 侧通过 `window.__dshFileAttach` 暴露页面级 API：

```typescript
// 提示文件建议（扩展浏览文件时调用）
window.__dshFileAttach.suggest(['/path/to/file.ts'])

// 提示选区建议（扩展选中文本时调用）
window.__dshFileAttach.suggestSelection({
  path: '/path/to/file.ts',
  ranges: [{ startLine: 10, endLine: 20 }],
  lineCount: 11,
})

// 清除所有建议
window.__dshFileAttach.clearSuggest()
```

### 类型定义

```typescript
interface Attachment {
  id: string
  kind: 'file' | 'content' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  content?: string
}

interface Suggestion {
  id: string
  kind: 'file' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  lineCount?: number
}
```

---

## English

### Overview

`dsh-file-attach` is a Cordis plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) that systematically injects file and code selection attachments into the DSH prompt system.

In DSH conversations, users can attach files or code snippets via:

- **Paste/drop paths** — paste a file path (e.g. `/path/to/file.ts`) into the input field; auto-detected and attached
- **Suggested attachments** — files or selections the user is browsing appear as dashed chips; click to attach
- **Programmatic attachment** — add files or code selections via the plugin API

Attached files are automatically injected into the prompt on the next model call, giving the model direct access to file contents as context.

### UI Preview

**Attached files** — solid chips with `×` to remove:

![Attached files](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/dsh-file-attach-attached-files.png)

**Suggested attachments** — dashed chips; click anywhere to attach:

![Suggested attachments](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/dsh-file-attach-suggested-attachments.png)

**Full view** — suggestions and attachments in the same strip, selection suggestions before file suggestions:

![Full demo](https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/assets/demo-full.png)

### How It Works

The plugin uses a **dual-half architecture** (Host + Client) and hooks into DSH's official `agent/pre-step` waterfall extension point:

```
┌─────────────┐         ┌─────────────┐
│  Host (Node)│         │Client (Web) │
│             │  RPC    │             │
│ prompt inject│◄──────►│ UI rendering │
│ state mgmt  │        │ path detect  │
│ file read   │        │ suggestions  │
└─────────────┘         └─────────────┘
```

- **Host side** (`src/host/`) — runs in the Node.js process; handles prompt injection, state management, and file content reading
- **Client side** (`src/client/`) — runs in the browser webview; handles UI rendering, path detection, and user interaction

### Installation

```bash
npm install dsh-file-attach
# or
pnpm add dsh-file-attach
```

### Usage

The plugin registers statically via `cordis.patch.yml`. Host and Client each export an `apply` function:

```typescript
// Host registration (Node.js process)
import { apply as hostApply } from 'dsh-file-attach/host'
hostApply(ctx)  // ctx: Cordis Context

// Client registration (browser webview)
import { apply as clientApply } from 'dsh-file-attach/client'
clientApply(ctx)
```

### API Reference

**Host API** — exposed via `window.__dshFileAttachHost`:

| Method | Parameters | Description |
|--------|-----------|-------------|
| `list(sessionId)` | — | List current attachments and suggestions |
| `add(sessionId, items)` | `items: AddItem[]` | Add file/selection/content attachments |
| `remove(sessionId, id)` | — | Remove a specific attachment |
| `clear(sessionId)` | — | Clear all attachments |
| `suggest(sessionId, paths)` | `paths: string[]` | Set file suggestions |
| `suggestSelection(sessionId, sel)` | `sel \| null` | Set selection suggestion (replace) |
| `suggestRemove(sessionId, id)` | — | Remove a specific suggestion |
| `suggestClear(sessionId)` | — | Clear all suggestions |

**Client API** — exposed via `window.__dshFileAttach`:

```typescript
// Suggest a file (called when extension browses a file)
window.__dshFileAttach.suggest(['/path/to/file.ts'])

// Suggest a selection (called when extension selects text)
window.__dshFileAttach.suggestSelection({
  path: '/path/to/file.ts',
  ranges: [{ startLine: 10, endLine: 20 }],
  lineCount: 11,
})

// Clear all suggestions
window.__dshFileAttach.clearSuggest()
```

### Types

```typescript
interface Attachment {
  id: string
  kind: 'file' | 'content' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  content?: string
}

interface Suggestion {
  id: string
  kind: 'file' | 'selection'
  path: string
  ranges?: readonly { startLine: number; endLine: number }[]
  lineCount?: number
}
```

---

## Development

### Prerequisites

- Node.js ≥ 22.19 or ≥ 24
- pnpm ≥ 10
- TypeScript ≥ 5.8

### Build

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Build (tsc → lib/)
pnpm build

# Clean build output
pnpm clean
```

### Project Structure

```
dsh-file-attach/
├── src/
│   ├── host/           # Host half (Node.js)
│   │   ├── index.ts    # Plugin entry + prompt injection
│   │   └── types.ts    # Shared type definitions
│   └── client/         # Client half (browser)
│       └── index.ts    # UI rendering + path detection
├── lib/                # Compiled output (ESM)
├── scripts/
│   └── build-client.mjs  # Client bundle wrapper
├── cordis.patch.yml    # Static plugin registration
├── package.json
└── tsconfig.json
```

### Integration

This plugin is designed for integration with the DSH ecosystem via `build-web-shell.mjs`. The Host and Client halves are compiled separately and assembled into the DSH shell bundle.

### License

[MIT](LICENSE)
