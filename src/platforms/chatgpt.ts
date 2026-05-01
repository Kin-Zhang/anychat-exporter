import sentinel from 'sentinel-js'
import {
    fetchConversation,
    getCurrentChatId,
    processConversation,
} from '../api'
import {
    checkIfConversationStarted as checkChatGPT,
    getUserAvatar as getChatGPTAvatar,
} from '../page'
import type { PlatformAdapter } from './types'
import type { ApiConversationWithId, ConversationResult } from '../api'

export class ChatGPTAdapter implements PlatformAdapter {
    readonly platformName = 'ChatGPT'
    readonly hostnames = ['chat.openai.com', 'chatgpt.com', 'new.oaifree.com']

    checkIfConversationStarted(): boolean {
        return checkChatGPT()
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const chatId = await getCurrentChatId()
        const raw = await fetchConversation(chatId, true)
        return processConversation(raw)
    }

    async fetchRawData(): Promise<unknown> {
        const chatId = await getCurrentChatId()
        const raw = await fetchConversation(chatId, false)
        return [raw] as ApiConversationWithId[]
    }

    supportsExportAll(): boolean {
        return true
    }

    async getUserAvatar(): Promise<string> {
        return getChatGPTAvatar()
    }

    injectUI(getContainer: () => HTMLElement): void {
        // Layout (current ChatGPT, late 2025):
        //   <div sidebar-wrapper>
        //     <nav aria-label="Chat history">  ← chat list, projects, recents, …
        //     <div>                            ← profile/account block at bottom
        //       <div data-testid="accounts-profile-button">…</div>
        //     </div>
        //   </div>
        // We want the export button as a SIBLING of the nav, sitting immediately
        // before the profile container — i.e. docked above the user/Plus block,
        // below the chat history.
        let container: HTMLElement | null = null

        const findProfileContainer = (): HTMLElement | null => {
            // The account button might be either the inner div or a sibling tiny-bar
            // copy. Pick the one that's actually visible and inside the sidebar
            // wrapper (a flex column whose first major child is the chat-history nav).
            const candidates = Array.from(document.querySelectorAll<HTMLElement>(
                '[data-testid="accounts-profile-button"], [data-testid="profile-button"]',
            ))
            for (const btn of candidates) {
                const rect = btn.getBoundingClientRect()
                if (rect.width === 0 || rect.height === 0) continue
                // Walk up: the profile container is the ancestor of the button
                // whose previous sibling is the chat-history <nav>.
                let el: HTMLElement | null = btn
                while (el && el.parentElement) {
                    const prev = el.previousElementSibling
                    if (prev && prev.tagName === 'NAV') return el
                    el = el.parentElement
                }
            }
            return null
        }

        const reconcile = () => {
            const profileContainer = findProfileContainer()
            if (!profileContainer || !profileContainer.parentElement) {
                // Sidebar (or profile area) not mounted yet. Wait for the next
                // tick rather than dropping the button somewhere wrong.
                return
            }
            const parent = profileContainer.parentElement

            if (!container || !container.isConnected) {
                container = getContainer()
                container.setAttribute('data-anychat-exporter', '')
            }

            const alreadyPlaced = container.parentElement === parent
                && container.nextElementSibling === profileContainer
            if (alreadyPlaced) return

            parent.insertBefore(container, profileContainer)
        }

        sentinel.on('nav', reconcile)
        setInterval(reconcile, 300)
    }
}
