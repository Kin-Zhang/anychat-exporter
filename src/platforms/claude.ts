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
        // We are in a chat if the URL contains /chat/{uuid}
        return !!this.getChatIdFromUrl()
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const chatId = this.getChatIdFromUrl()
        if (!chatId) throw new Error('[Exporter] No Claude chat ID found in URL')

        const orgId = await this.getOrgId()
        const data = await this.fetchClaudeConversation(orgId, chatId)
        return this.mapToConversationResult(data)
    }

    async fetchRawData(): Promise<unknown> {
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

            // Claude renders a left nav sidebar - target the innermost scrollable nav
            // This selector may need updating if Claude changes its DOM structure
            const nav = document.querySelector<HTMLElement>('nav')
                ?? document.querySelector<HTMLElement>('[data-testid="sidebar"]')

            if (!nav) return

            injected = true
            const container = getContainer()
            container.style.padding = '8px'

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

    private async getOrgId(): Promise<string> {
        if (this.cachedOrgId) return this.cachedOrgId

        // Uses the existing browser session — no API key required
        const response = await fetch('https://claude.ai/api/organizations', {
            credentials: 'include',
        })
        if (!response.ok) {
            throw new Error(`[Exporter] Failed to fetch Claude org list: ${response.statusText}`)
        }
        const orgs: ClaudeOrg[] = await response.json()
        if (!orgs.length) throw new Error('[Exporter] No Claude organization found')

        this.cachedOrgId = orgs[0].uuid
        return this.cachedOrgId
    }

    private async fetchClaudeConversation(orgId: string, chatId: string): Promise<ClaudeConversation> {
        const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}`
        const response = await fetch(url, {
            credentials: 'include',
        })
        if (!response.ok) {
            throw new Error(`[Exporter] Failed to fetch Claude conversation: ${response.statusText}`)
        }
        return response.json()
    }

    // Map Claude's flat message list to the shared ConversationResult format
    private mapToConversationResult(data: ClaudeConversation): ConversationResult {
        const conversationNodes: ConversationNode[] = data.chat_messages.map((msg, i) => {
            const messages = data.chat_messages
            return {
                id: msg.uuid,
                // Link messages as a chain for compatibility with exporter formatters
                parent: i === 0 ? undefined : messages[i - 1].uuid,
                children: i < messages.length - 1 ? [messages[i + 1].uuid] : [],
                message: {
                    id: msg.uuid,
                    author: {
                        role: msg.sender === 'human' ? 'user' : 'assistant',
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
        let text: string

        if (msg.content && Array.isArray(msg.content) && msg.content.length > 0) {
            const parts: string[] = []
            for (const block of msg.content) {
                if (block.type === 'thinking') continue
                if (block.type === 'tool_use') continue
                if (block.type === 'tool_result') continue
                if (block.type === 'text' && block.text) {
                    parts.push(block.text)
                }
            }
            text = parts.join('\n\n')
        }
        else {
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

    private resolveModelName(slug?: string | null): string {
        if (!slug) return 'Claude'
        // Map common Claude model slugs to readable names
        if (slug.includes('opus')) return 'Claude Opus'
        if (slug.includes('sonnet')) return 'Claude Sonnet'
        if (slug.includes('haiku')) return 'Claude Haiku'
        return 'Claude'
    }
}
