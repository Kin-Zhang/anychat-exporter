import { getBase64FromImg } from '../utils/dom'
import type { PlatformAdapter } from './types'
import type { ConversationNode, ConversationResult } from '../api'

const defaultAvatar = 'data:image/svg+xml,%3Csvg%20stroke%3D%22currentColor%22%20fill%3D%22none%22%20stroke-width%3D%221.5%22%20viewBox%3D%22-6%20-6%2036%2036%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20style%3D%22color%3A%20white%3B%20background%3A%20%234285f4%3B%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M20%2021v-2a4%204%200%200%200-4-4H8a4%204%200%200%200-4%204v2%22%3E%3C%2Fpath%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%227%22%20r%3D%224%22%3E%3C%2Fcircle%3E%3C%2Fsvg%3E'

const SELECTORS = {
    chatTurn: 'ms-chat-turn',
    userTurnContainer: '.chat-turn-container.user',
    modelTurnContainer: '.chat-turn-container.model',
    turnContent: '.turn-content',
    textChunk: 'ms-text-chunk',
    rawText: 'ms-text-chunk .very-large-text-container',
    cmarkNode: 'ms-text-chunk ms-cmark-node',
    promptChunk: '.turn-content > ms-prompt-chunk',
    thoughtChunk: 'ms-thought-chunk',
    navbar: 'ms-navbar',
    bottomActions: '.bottom-actions',
    pageTitle: 'ms-playground-toolbar .page-title h1.mode-title, ms-toolbar .page-title h1.mode-title',
    toolbarRight: 'ms-playground-toolbar .toolbar-right, ms-toolbar .toolbar-right',
}

export class AIStudioAdapter implements PlatformAdapter {
    readonly platformName = 'AIStudio'
    readonly hostnames = ['aistudio.google.com']

    checkIfConversationStarted(): boolean {
        return !!this.getPromptIdFromUrl()
            && document.querySelectorAll(SELECTORS.chatTurn).length > 0
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const promptId = this.getPromptIdFromUrl() ?? `aistudio-${Date.now()}`
        const title = this.extractTitle()
        const nodes = this.extractMessagesFromDOM()

        if (nodes.length === 0) {
            throw new Error('[Exporter] No messages found on AI Studio page. The page may still be loading.')
        }

        return {
            id: promptId,
            title,
            model: 'Gemini',
            modelSlug: 'gemini-aistudio',
            createTime: Date.now() / 1000,
            updateTime: Date.now() / 1000,
            conversationNodes: nodes,
        }
    }

    async fetchRawData(): Promise<unknown> {
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
            console.error('[Exporter] Failed to get AI Studio avatar', e)
        }
        return defaultAvatar
    }

    injectUI(getContainer: () => HTMLElement): void {
        let injected = false

        const tryInject = () => {
            if (injected) return

            const navbar = document.querySelector<HTMLElement>(SELECTORS.navbar)
            if (!navbar) return

            const bottomActions = navbar.querySelector<HTMLElement>(SELECTORS.bottomActions)
            if (bottomActions) {
                injected = true
                const container = getContainer()
                container.setAttribute('data-exporter-compact', '')
                container.style.padding = '4px 8px'
                container.style.width = '100%'
                container.style.boxSizing = 'border-box'
                // Insert before the first interactive button, skipping disclaimer
                const anchor = bottomActions.querySelector('ms-updates, ms-api-key-button, ms-settings-menu, button')
                if (anchor) {
                    bottomActions.insertBefore(container, anchor)
                }
                else {
                    bottomActions.prepend(container)
                }
                console.warn('[Exporter] Injected into AI Studio sidebar bottom-actions')
                return
            }

            injected = true
            const container = getContainer()
            container.setAttribute('data-exporter-compact', '')
            container.style.padding = '4px 8px'
            container.style.width = '100%'
            container.style.boxSizing = 'border-box'
            navbar.appendChild(container)
            console.warn('[Exporter] Injected into AI Studio navbar fallback')
        }

        const interval = setInterval(() => {
            tryInject()
            if (injected) clearInterval(interval)
        }, 500)

        const observer = new MutationObserver(() => {
            if (!injected) tryInject()
            else observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- Private helpers ---

    private getPromptIdFromUrl(): string | null {
        // AI Studio URL: aistudio.google.com/prompts/{id}
        const match = location.pathname.match(/\/prompts\/([^/]+)/i)
        if (match && match[1] !== 'new_chat') return match[1]
        return null
    }

    private extractTitle(): string {
        const titleEl = document.querySelector<HTMLElement>(SELECTORS.pageTitle)
        if (titleEl?.textContent) {
            const text = titleEl.textContent.trim()
            if (text && text !== 'Playground') return text
        }
        return document.title.replace(/\s*[-|].*$/, '').trim() || 'AI Studio Conversation'
    }

    private extractMessagesFromDOM(): ConversationNode[] {
        const turns = Array.from(document.querySelectorAll(SELECTORS.chatTurn))
        const nodes: ConversationNode[] = []

        turns.forEach((turn, i) => {
            const userContainer = turn.querySelector(SELECTORS.userTurnContainer)
            const modelContainer = turn.querySelector(SELECTORS.modelTurnContainer)

            if (userContainer) {
                const text = this.extractTurnText(turn, 'user')
                if (text) {
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
            }

            if (modelContainer) {
                const text = this.extractTurnText(turn, 'model')
                if (text) {
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
            }
        })

        for (let i = 0; i < nodes.length - 1; i++) {
            nodes[i].children = [nodes[i + 1].id]
        }

        return nodes
    }

    private extractTurnText(turn: Element, type: 'user' | 'model'): string {
        if (type === 'user') {
            const raw = turn.querySelector(SELECTORS.rawText)
            if (raw?.textContent) return raw.textContent.trim()
            const cmark = turn.querySelector(SELECTORS.cmarkNode)
            if (cmark?.textContent) return cmark.textContent.trim()
            const turnContent = turn.querySelector(SELECTORS.turnContent)
            return turnContent?.textContent?.trim() ?? ''
        }

        // Model: collect from prompt chunks, excluding thought chunks
        const chunks = Array.from(turn.querySelectorAll(SELECTORS.promptChunk))
        const texts = chunks
            .filter(chunk => !chunk.querySelector(SELECTORS.thoughtChunk))
            .map((chunk) => {
                const raw = chunk.querySelector(SELECTORS.rawText)
                if (raw?.textContent) return raw.textContent.trim()
                return (chunk as HTMLElement).innerText?.trim() ?? ''
            })
            .filter(t => t)

        if (texts.length > 0) return texts.join('\n\n')

        // Fallback: clone turn content and strip thought chunks before extracting
        const turnContent = turn.querySelector(SELECTORS.turnContent)
        if (!turnContent) return ''
        const clone = turnContent.cloneNode(true) as Element
        clone.querySelectorAll(SELECTORS.thoughtChunk).forEach(el => el.remove())
        return clone.textContent?.trim() ?? ''
    }
}
