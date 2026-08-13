import { getBase64FromImg } from '../utils/dom'
import type { PlatformAdapter } from './types'
import type { ConversationNode, ConversationResult } from '../api'

// Claude API response shapes (from reverse engineering claude.ai network traffic)
interface ClaudeOrg {
    uuid: string
    name: string
}

interface ClaudeContentBlock {
    type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | (string & {})
    text?: string
    thinking?: string
    name?: string
    id?: string
    input?: unknown
    content?: unknown
}

interface ClaudeMessage {
    uuid: string
    text: string
    sender: 'human' | 'assistant'
    created_at: string
    updated_at: string
    content?: ClaudeContentBlock[]
    attachments?: Array<{
        file_name: string
        file_type: string
        extracted_content?: string
    }>
    files?: Array<{
        file_name: string
        file_type: string
        preview_url?: string
    }>
}

interface ClaudeConversation {
    uuid: string
    name: string
    created_at: string
    updated_at: string
    model?: string | null
    chat_messages: ClaudeMessage[]
}

// Default avatar SVG (same as page.ts fallback)
const defaultAvatar = 'data:image/svg+xml,%3Csvg%20stroke%3D%22currentColor%22%20fill%3D%22none%22%20stroke-width%3D%221.5%22%20viewBox%3D%22-6%20-6%2036%2036%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20style%3D%22color%3A%20white%3B%20background%3A%20%23ab68ff%3B%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M20%2021v-2a4%204%200%200%200-4-4H8a4%204%200%200%200-4%204v2%22%3E%3C%2Fpath%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%227%22%20r%3D%224%22%3E%3C%2Fcircle%3E%3C%2Fsvg%3E'

export class ClaudeAdapter implements PlatformAdapter {
    readonly platformName = 'Claude'
    readonly hostnames = ['claude.ai']

    // Cached org ID to avoid redundant API calls
    private cachedOrgId: string | null = null

    checkIfConversationStarted(): boolean {
        // We are in a chat if the URL contains /chat/{uuid} or /code/{session_id}
        return !!this.getChatIdFromUrl() || !!this.getCodeSessionIdFromUrl()
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const codeSessionId = this.getCodeSessionIdFromUrl()
        if (codeSessionId) return this.fetchCodeSessionConversation(codeSessionId)

        const chatId = this.getChatIdFromUrl()
        if (!chatId) throw new Error('[Exporter] No Claude chat ID found in URL')

        const orgId = await this.getOrgId()
        const data = await this.fetchClaudeConversation(orgId, chatId)
        return this.mapToConversationResult(data)
    }

    async fetchRawData(): Promise<unknown> {
        const codeSessionId = this.getCodeSessionIdFromUrl()
        if (codeSessionId) return this.fetchCodeSessionConversation(codeSessionId)

        const chatId = this.getChatIdFromUrl()
        if (!chatId) throw new Error('[Exporter] No Claude chat ID found in URL')

        const orgId = await this.getOrgId()
        return this.fetchClaudeConversation(orgId, chatId)
    }

    supportsExportAll(): boolean {
        return false
    }

    async getUserAvatar(): Promise<string> {
        try {
            // Try to find the user avatar already rendered in the page
            const avatarImgs = Array.from(
                document.querySelectorAll<HTMLImageElement>('img[alt]:not([aria-hidden])'),
            )
            const avatar = avatarImgs.find(img => !img.src.startsWith('data:'))
            if (avatar) return getBase64FromImg(avatar)
        }
        catch (e) {
            console.error('[Exporter] Failed to get Claude avatar', e)
        }
        return defaultAvatar
    }

    injectUI(getContainer: () => HTMLElement): void {
        let injected = false

        const tryInject = () => {
            if (injected) return

            // Claude's sidebar is now <aside class="dframe-sidebar" aria-label="Sidebar">
            // (previously a <nav>). Keep the old selectors as a fallback in case
            // Claude reverts or A/B tests the change.
            const nav = document.querySelector<HTMLElement>('aside.dframe-sidebar, aside[aria-label="Sidebar"]')
                ?? document.querySelector<HTMLElement>('nav')
                ?? document.querySelector<HTMLElement>('[data-testid="sidebar"]')

            if (!nav) return

            injected = true
            const container = getContainer()
            container.style.padding = '8px'

            // Prefer inserting as a sibling of the bottom user-menu tray (a direct
            // child of the sidebar's flex column), so it renders as a full-width row
            // right above the account button rather than nesting inside its wrapper.
            const bottomTray = nav.querySelector<HTMLElement>('.df-bottom-tray')
            if (bottomTray && bottomTray.parentElement) {
                bottomTray.parentElement.insertBefore(container, bottomTray)
                console.warn('[Exporter] Injected into Claude nav', nav)
                return
            }

            const userMenu = nav.querySelector('[data-testid="user-menu-button"]')
            if (userMenu && userMenu.parentElement) {
                userMenu.parentElement.insertBefore(container, userMenu)
            }
            else {
                container.style.borderTop = '1px solid rgba(255,255,255,0.1)'
                nav.appendChild(container)
            }
            console.warn('[Exporter] Injected into Claude nav', nav)
        }

        // Try immediately and keep retrying — Claude is a React SPA, nav loads async
        const interval = setInterval(() => {
            tryInject()
            if (injected) clearInterval(interval)
        }, 500)

        // Also watch for navigation changes (switching conversations)
        const observer = new MutationObserver(() => {
            if (!injected) tryInject()
            else observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- Private helpers ---

    private getChatIdFromUrl(): string | null {
        // Claude URL format: claude.ai/chat/{uuid}
        const match = location.pathname.match(/\/chat\/([a-z0-9-]+)/i)
        return match ? match[1] : null
    }

    private getCodeSessionIdFromUrl(): string | null {
        // Claude Code session URL format: claude.ai/code/session_{id}
        const match = location.pathname.match(/\/code\/(session_[a-z0-9]+)/i)
        return match ? match[1] : null
    }

    private getOrgIdFromCookie(): string | null {
        const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/)
        if (!match) return null
        const value = decodeURIComponent(match[1])
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
    }

    private async getOrgId(): Promise<string> {
        if (this.cachedOrgId) return this.cachedOrgId

        const cookieOrgId = this.getOrgIdFromCookie()
        if (cookieOrgId) {
            this.cachedOrgId = cookieOrgId
            return cookieOrgId
        }

        const response = await this.fetchClaude('/api/organizations')
        if (!response.ok) {
            throw new Error(`[Exporter] Failed to fetch Claude org list: ${response.statusText}`)
        }
        const orgs: ClaudeOrg[] = await response.json()
        if (!orgs.length) throw new Error('[Exporter] No Claude organization found')

        this.cachedOrgId = orgs[0].uuid
        return this.cachedOrgId
    }

    private async fetchClaude(path: string): Promise<Response> {
        const origin = location.origin
        const response = await fetch(`${origin}${path}`, { credentials: 'include' })
        if (response.ok || response.status !== 404) return response
        // Claude migrated from /api to /edge-api; try the other prefix on 404
        const altPath = path.startsWith('/api/')
            ? path.replace('/api/', '/edge-api/')
            : path.replace('/edge-api/', '/api/')
        return fetch(`${origin}${altPath}`, { credentials: 'include' })
    }

    private async fetchClaudeConversation(orgId: string, chatId: string): Promise<ClaudeConversation> {
        const response = await this.fetchClaude(`/api/organizations/${orgId}/chat_conversations/${chatId}`)
        if (!response.ok) {
            throw new Error(`[Exporter] Failed to fetch Claude conversation: ${response.statusText}`)
        }
        return response.json()
    }

    // Map Claude's flat message list to the shared ConversationResult format
    private mapToConversationResult(data: ClaudeConversation): ConversationResult {
        const chatMessages = data.chat_messages
            ?? (data as unknown as Record<string, unknown>).messages as ClaudeMessage[] | undefined
            ?? []
        if (chatMessages.length === 0) {
            console.warn('[Exporter] Claude conversation has no messages. API response keys:', Object.keys(data))
        }
        const conversationNodes: ConversationNode[] = chatMessages.map((msg, i) => {
            const messages = chatMessages
            return {
                id: msg.uuid,
                // Link messages as a chain for compatibility with exporter formatters
                parent: i === 0 ? undefined : messages[i - 1].uuid,
                children: i < messages.length - 1 ? [messages[i + 1].uuid] : [],
                message: {
                    id: msg.uuid,
                    author: {
                        role: (msg.sender === 'human' || (msg as unknown as Record<string, unknown>).role === 'user')
                            ? 'user'
                            : 'assistant',
                        metadata: {},
                    },
                    content: {
                        content_type: 'text',
                        parts: [this.buildMessageText(msg)],
                    },
                    create_time: new Date(msg.created_at).getTime() / 1000,
                    update_time: new Date(msg.updated_at).getTime() / 1000,
                    status: 'finished_successfully',
                    recipient: 'all',
                    weight: 1,
                },
            }
        })

        return {
            id: data.uuid,
            title: data.name || 'Claude Conversation',
            model: this.resolveModelName(data.model),
            modelSlug: data.model || 'claude',
            createTime: new Date(data.created_at).getTime() / 1000,
            updateTime: new Date(data.updated_at).getTime() / 1000,
            conversationNodes,
        }
    }

    private buildMessageText(msg: ClaudeMessage): string {
        let text = ''

        if (msg.content && Array.isArray(msg.content) && msg.content.length > 0) {
            const parts: string[] = []
            for (const block of msg.content) {
                if (block.type === 'thinking') continue
                if (block.type === 'tool_result') continue
                if (block.type === 'text' && block.text) {
                    parts.push(block.text)
                    continue
                }
                if (block.type === 'tool_use') {
                    const rendered = this.renderToolUse(block)
                    if (rendered) parts.push(rendered)
                    continue
                }
            }
            text = parts.join('\n\n')
        }

        // Fall back to msg.text whenever the structured content produced nothing.
        // This recovers the assistant's prose when the only block was an artifact
        // / tool_use that we couldn't render into Markdown.
        if (!text && msg.text) {
            text = msg.text
        }

        text = text.replace(/This block is not supported on your current device yet\.\n?/g, '')

        if (msg.attachments?.length) {
            const attachmentInfo = msg.attachments
                .map(a => `[Attachment: ${a.file_name}${a.extracted_content ? `\n${a.extracted_content}` : ''}]`)
                .join('\n')
            text += `\n\n${attachmentInfo}`
        }
        return text.trim()
    }

    private renderToolUse(block: ClaudeContentBlock): string {
        const name = block.name ?? 'tool_use'
        const input = (block.input ?? {}) as Record<string, unknown>

        // Claude artifacts ship the user-visible payload as a tool_use block.
        // Render the artifact body as a fenced code block so the export is not empty.
        if (name === 'artifacts' || name === 'artifacts_v0' || name === 'create_artifact') {
            const command = typeof input.command === 'string' ? input.command : undefined
            if (command === 'delete') return ''

            const title = typeof input.title === 'string' ? input.title : undefined
            const language = typeof input.language === 'string'
                ? input.language
                : typeof input.type === 'string'
                    ? this.languageFromArtifactType(input.type)
                    : ''
            const content = typeof input.content === 'string'
                ? input.content
                : typeof input.new_str === 'string'
                    ? input.new_str
                    : ''
            if (!content) return ''

            const header = title ? `**${title}**\n\n` : ''
            const fence = '```'
            return `${header}${fence}${language}\n${content}\n${fence}`
        }

        // Generic tool_use: keep something visible rather than silently dropping the turn.
        try {
            const json = JSON.stringify(input, null, 2)
            return `\`\`\`json\n[tool_use: ${name}]\n${json}\n\`\`\``
        }
        catch {
            return `[tool_use: ${name}]`
        }
    }

    private languageFromArtifactType(type: string): string {
        if (type.includes('html')) return 'html'
        if (type.includes('react')) return 'jsx'
        if (type.includes('svg')) return 'svg'
        if (type.includes('mermaid')) return 'mermaid'
        if (type.includes('javascript')) return 'javascript'
        if (type.includes('python')) return 'python'
        if (type.includes('markdown')) return 'markdown'
        return ''
    }

    private resolveModelName(slug?: string | null): string {
        if (!slug) return 'Claude'
        // Map common Claude model slugs to readable names
        if (slug.includes('opus')) return 'Claude Opus'
        if (slug.includes('sonnet')) return 'Claude Sonnet'
        if (slug.includes('haiku')) return 'Claude Haiku'
        return 'Claude'
    }

    // --- Claude Code session support (text-only) ---
    //
    // Claude Code sessions (claude.ai/code/session_{id}) render an agentic
    // transcript, not a plain chat, and have no equivalent chat_conversations
    // API endpoint we can reach client-side. We extract turns from the DOM
    // instead: prose is recovered from each turn's markdown blocks, while
    // tool-call cards (bash commands, file edits, job monitors) are skipped —
    // their detail isn't in the DOM until expanded, so only a placeholder
    // line survives.

    private async fetchCodeSessionConversation(sessionId: string): Promise<ConversationResult> {
        const title = this.extractCodeSessionTitle()
        const nodes = await this.extractCodeSessionMessagesFromDOM()

        if (nodes.length === 0) {
            throw new Error('[Exporter] No messages found on Claude Code session page. The page may still be loading.')
        }

        return {
            id: sessionId,
            title,
            model: 'Claude Code',
            modelSlug: 'claude-code',
            createTime: Date.now() / 1000,
            updateTime: Date.now() / 1000,
            conversationNodes: nodes,
        }
    }

    private extractCodeSessionTitle(): string {
        return document.title.replace(/\s*[-|].*$/, '').trim() || 'Claude Code Session'
    }

    private async extractCodeSessionMessagesFromDOM(): Promise<ConversationNode[]> {
        interface Turn { role: 'user' | 'assistant'; id: string; text: string }
        const collected = new Map<number, Turn>()

        const collectVisible = () => {
            const articles = Array.from(
                document.querySelectorAll<HTMLElement>('[role="article"][aria-posinset]'),
            )
            for (const article of articles) {
                const posinset = Number(article.getAttribute('aria-posinset'))
                if (!posinset || collected.has(posinset)) continue

                const entry = article.querySelector<HTMLElement>('[data-epitaxy-entry]')
                const id = entry?.getAttribute('data-epitaxy-entry') ?? `code-turn-${posinset}`

                const userTurn = article.querySelector<HTMLElement>('.epitaxy-user-turn')
                if (userTurn) {
                    const text = this.codeSessionHtmlToMarkdown(userTurn)
                    if (text) collected.set(posinset, { role: 'user', id, text })
                    continue
                }

                const mdBlocks = Array.from(article.querySelectorAll<HTMLElement>('.epitaxy-markdown'))
                const text = mdBlocks
                    .map(block => this.codeSessionHtmlToMarkdown(block))
                    .filter(t => t)
                    .join('\n\n')
                if (text) collected.set(posinset, { role: 'assistant', id, text })
            }
        }

        // The transcript is virtualized (turns outside the viewport aren't in the
        // DOM at all), so scroll from top to bottom collecting turns as they render.
        const scroller = document.querySelector<HTMLElement>('[data-testid="epitaxy-virtual-transcript"]')
        if (scroller) {
            scroller.scrollTop = 0
            await new Promise<void>(resolve => setTimeout(resolve, 150))
            collectVisible()

            let lastScrollTop = -1
            let stableCount = 0
            for (let i = 0; i < 200 && stableCount < 3; i++) {
                scroller.scrollTop += scroller.clientHeight * 0.8
                await new Promise<void>(resolve => setTimeout(resolve, 150))
                collectVisible()

                if (scroller.scrollTop === lastScrollTop) {
                    stableCount += 1
                }
                else {
                    stableCount = 0
                    lastScrollTop = scroller.scrollTop
                }

                if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break
            }
        }
        else {
            collectVisible()
        }

        const ordered = Array.from(collected.keys())
            .sort((a, b) => a - b)
            .map(k => collected.get(k)!)

        return ordered.map((turn, i) => ({
            id: turn.id,
            parent: i === 0 ? undefined : ordered[i - 1].id,
            children: i < ordered.length - 1 ? [ordered[i + 1].id] : [],
            message: {
                id: turn.id,
                author: { role: turn.role, metadata: {} },
                content: { content_type: 'text', parts: [turn.text] },
                create_time: Date.now() / 1000,
                update_time: Date.now() / 1000,
                status: 'finished_successfully',
                recipient: 'all',
                weight: 1,
            },
        }))
    }

    // Minimal HTML -> Markdown conversion for Claude Code's transcript prose.
    // Elements marked data-find-omitted are Claude's own "hide from find-in-page /
    // screen reader summary" markers — they duplicate visible text or are pure UI
    // chrome (message-action toolbars), so we skip them entirely.
    private codeSessionHtmlToMarkdown(root: Element): string {
        function renderChildren(el: Node): string {
            let out = ''
            for (const child of Array.from(el.childNodes)) out += render(child)
            return out
        }

        function render(node: Node): string {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
            if (node.nodeType !== Node.ELEMENT_NODE) return ''
            const el = node as Element
            if (el.hasAttribute('data-find-omitted')) return ''
            const tag = el.tagName

            switch (tag) {
                case 'P': return `\n\n${renderChildren(el).trim()}\n\n`
                case 'BR': return '\n'
                case 'STRONG':
                case 'B': return `**${renderChildren(el)}**`
                case 'EM':
                case 'I': return `*${renderChildren(el)}*`
                case 'CODE': return `\`${el.textContent ?? ''}\``
                case 'A': {
                    const href = el.getAttribute('href') ?? ''
                    const text = renderChildren(el)
                    return href ? `[${text}](${href})` : text
                }
                case 'H1': return `\n\n# ${renderChildren(el).trim()}\n\n`
                case 'H2': return `\n\n## ${renderChildren(el).trim()}\n\n`
                case 'H3': return `\n\n### ${renderChildren(el).trim()}\n\n`
                case 'H4': return `\n\n#### ${renderChildren(el).trim()}\n\n`
                case 'H5': return `\n\n##### ${renderChildren(el).trim()}\n\n`
                case 'H6': return `\n\n###### ${renderChildren(el).trim()}\n\n`
                case 'HR': return '\n\n---\n\n'
                case 'BLOCKQUOTE': {
                    const inner = renderChildren(el).trim()
                    if (!inner) return ''
                    const quoted = inner.split('\n').map(l => l ? `> ${l}` : '>').join('\n')
                    return `\n\n${quoted}\n\n`
                }
                case 'UL':
                case 'OL': {
                    const ordered = tag === 'OL'
                    const items: string[] = []
                    let index = 0
                    for (const child of Array.from(el.children)) {
                        if (child.tagName !== 'LI') continue
                        index += 1
                        const prefix = ordered ? `${index}. ` : '- '
                        const inner = renderChildren(child).trim()
                        const lines = inner.split('\n')
                        const first = lines.shift() ?? ''
                        const rest = lines.map(l => l ? `  ${l}` : '').join('\n')
                        items.push(`${prefix}${first}${rest ? `\n${rest}` : ''}`)
                    }
                    return `\n\n${items.join('\n')}\n\n`
                }
                case 'LI': return renderChildren(el)
                case 'PRE': {
                    const code = el.textContent ?? ''
                    return `\n\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`
                }
                default: return renderChildren(el)
            }
        }

        const out = render(root)
        return out.replace(/\n{3,}/g, '\n\n').trim()
    }
}
