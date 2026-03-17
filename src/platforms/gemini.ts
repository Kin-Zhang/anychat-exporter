import { getBase64FromImg } from '../utils/dom'
import type { PlatformAdapter } from './types'
import type { ConversationNode, ConversationResult } from '../api'

// Default avatar fallback
const defaultAvatar = 'data:image/svg+xml,%3Csvg%20stroke%3D%22currentColor%22%20fill%3D%22none%22%20stroke-width%3D%221.5%22%20viewBox%3D%22-6%20-6%2036%2036%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20style%3D%22color%3A%20white%3B%20background%3A%20%234285f4%3B%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M20%2021v-2a4%204%200%200%200-4-4H8a4%204%200%200%200-4%204v2%22%3E%3C%2Fpath%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%227%22%20r%3D%224%22%3E%3C%2Fcircle%3E%3C%2Fsvg%3E'

// Gemini DOM selectors — these may need updating if Google changes its markup
// Verified against gemini.google.com as of early 2025
const SELECTORS = {
    // Each conversation turn container
    conversationTurn: 'conversation-turn, .conversation-container',
    // User message text inside a turn
    userQuery: 'user-query',
    // Model response text inside a turn
    modelResponse: 'model-response',
    // The rendered markdown text within a model response
    responseText: '.response-content, .markdown',
    // The sidebar nav where we inject our button
    nav: '.conversation-list, nav',
    // Conversation title in sidebar
    conversationTitle: '.conversation-title',
}

export class GeminiAdapter implements PlatformAdapter {
    readonly hostnames = ['gemini.google.com']

    checkIfConversationStarted(): boolean {
        // In a conversation when the URL contains /app/ with an ID
        return !!this.getChatIdFromUrl()
            && document.querySelectorAll(SELECTORS.conversationTurn).length > 0
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const chatId = this.getChatIdFromUrl() ?? `gemini-${Date.now()}`
        const title = this.extractTitle()
        const nodes = this.extractMessagesFromDOM()

        if (nodes.length === 0) {
            throw new Error('[Exporter] No messages found on Gemini page. The page may still be loading.')
        }

        return {
            id: chatId,
            title,
            model: 'Gemini',
            modelSlug: 'gemini',
            createTime: Date.now() / 1000,
            updateTime: Date.now() / 1000,
            conversationNodes: nodes,
        }
    }

    async fetchRawData(): Promise<unknown> {
        // For Gemini we have no raw API data, so return the processed result
        return this.fetchCurrentConversation()
    }

    supportsExportAll(): boolean {
        return false
    }

    async getUserAvatar(): Promise<string> {
        try {
            const avatarImgs = Array.from(
                document.querySelectorAll<HTMLImageElement>('img[alt]:not([aria-hidden])'),
            )
            const avatar = avatarImgs.find(img => !img.src.startsWith('data:'))
            if (avatar) return getBase64FromImg(avatar)
        }
        catch (e) {
            console.error('[Exporter] Failed to get Gemini avatar', e)
        }
        return defaultAvatar
    }

    injectUI(getContainer: () => HTMLElement): void {
        let injected = false

        const tryInject = () => {
            if (injected) return

            // Look for the bottom controls in the side navigation
            const bottomControls = document.querySelector<HTMLElement>('mat-action-list.desktop-controls')
            if (bottomControls && bottomControls.parentElement) {
                injected = true
                const container = getContainer()
                container.style.padding = '8px'
                bottomControls.parentElement.insertBefore(container, bottomControls)
                console.warn('[Exporter] Injected into Gemini sidebar above controls', bottomControls)
                return
            }

            // Fallback: Try multiple selectors since Google updates their markup frequently
            const sidebarCandidates = [
                document.querySelector<HTMLElement>('.conversation-list'),
                document.querySelector<HTMLElement>('bard-sidenav'),
                document.querySelector<HTMLElement>('nav'),
            ]

            const sidebar = sidebarCandidates.find(el => !!el)
            if (!sidebar) return

            injected = true
            const container = getContainer()
            container.style.padding = '8px'
            sidebar.prepend(container)
            console.warn('[Exporter] Injected into Gemini sidebar', sidebar)
        }

        const interval = setInterval(() => {
            tryInject()
            if (injected) clearInterval(interval)
        }, 500)

        const observer = new MutationObserver(() => {
            if (!injected) tryInject()
        })
        observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- Private helpers ---

    private getChatIdFromUrl(): string | null {
        // Gemini URL: gemini.google.com/app/{id}
        const match = location.pathname.match(/\/app\/([a-z0-9]+)/i)
        return match ? match[1] : null
    }

    private extractTitle(): string {
        // Try sidebar active item title, then page title
        const activeItem = document.querySelector<HTMLElement>(
            '.conversation-title.selected, [aria-selected="true"] .item-title',
        )
        if (activeItem?.textContent) return activeItem.textContent.trim()
        return document.title.replace(/\s*[-|].*$/, '').trim() || 'Gemini Conversation'
    }

    private extractMessagesFromDOM(): ConversationNode[] {
        const turns = Array.from(document.querySelectorAll(SELECTORS.conversationTurn))
        const nodes: ConversationNode[] = []

        turns.forEach((turn, i) => {
            // Extract user message
            const userEl = turn.querySelector(SELECTORS.userQuery)
            if (userEl) {
                const text = userEl.textContent?.trim() ?? ''
                const id = `user-${i}`
                nodes.push({
                    id,
                    parent: nodes.length > 0 ? nodes[nodes.length - 1].id : undefined,
                    children: [],
                    message: {
                        id,
                        author: { role: 'user', metadata: {} },
                        content: { content_type: 'text', parts: [text] },
                        create_time: Date.now() / 1000,
                        update_time: Date.now() / 1000,
                        status: 'finished_successfully',
                        recipient: 'all',
                        weight: 1,
                    },
                })
            }

            // Extract model response
            const modelEl = turn.querySelector(SELECTORS.modelResponse)
            if (modelEl) {
                // Prefer inner response-content div; fall back to full element text
                const textEl = modelEl.querySelector(SELECTORS.responseText) ?? modelEl
                const text = textEl.textContent?.trim() ?? ''
                const id = `assistant-${i}`
                nodes.push({
                    id,
                    parent: nodes.length > 0 ? nodes[nodes.length - 1].id : undefined,
                    children: [],
                    message: {
                        id,
                        author: { role: 'assistant', metadata: {} },
                        content: { content_type: 'text', parts: [text] },
                        create_time: Date.now() / 1000,
                        update_time: Date.now() / 1000,
                        status: 'finished_successfully',
                        recipient: 'all',
                        weight: 1,
                    },
                })
            }
        })

        // Wire up the children references
        for (let i = 0; i < nodes.length - 1; i++) {
            nodes[i].children = [nodes[i + 1].id]
        }

        return nodes
    }
}
