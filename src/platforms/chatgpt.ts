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
        // Track the container we created for each <nav>, plus when we first saw the nav
        // so we can defer the floating fallback until ChatGPT clearly isn't going to render
        // the sticky bottom container.
        interface Injection {
            container: HTMLElement
            firstSeen: number
            anchored: boolean
        }
        const injectionMap = new Map<HTMLElement, Injection>()
        const FALLBACK_DELAY_MS = 2000

        const applyFloatingStyles = (container: HTMLElement) => {
            container.style.backgroundColor = '#171717'
            container.style.position = 'sticky'
            container.style.bottom = '72px'
        }

        const clearFloatingStyles = (container: HTMLElement) => {
            container.style.backgroundColor = ''
            container.style.position = ''
            container.style.bottom = ''
        }

        const reconcile = (nav: HTMLElement) => {
            let entry = injectionMap.get(nav)
            if (!entry) {
                entry = { container: getContainer(), firstSeen: Date.now(), anchored: false }
                injectionMap.set(nav, entry)
                console.warn('[Exporter] Tracking nav for injection', nav)
            }
            const { container } = entry

            const chatList = nav.querySelector<HTMLElement>(':scope > div.sticky.bottom-0')
            if (chatList) {
                if (container.parentElement !== chatList || chatList.firstElementChild !== container) {
                    clearFloatingStyles(container)
                    chatList.prepend(container)
                }
                entry.anchored = true
                return
            }

            // Sticky container not present yet. Wait briefly before falling back to the
            // floating placement so a normal cold load never shows the floating state.
            if (entry.anchored) return
            if (container.parentElement) return
            if (Date.now() - entry.firstSeen < FALLBACK_DELAY_MS) return

            applyFloatingStyles(container)
            nav.append(container)
        }

        sentinel.on('nav', reconcile)

        setInterval(() => {
            injectionMap.forEach((entry, nav) => {
                if (!nav.isConnected) {
                    entry.container.remove()
                    injectionMap.delete(nav)
                }
            })
            Array.from(document.querySelectorAll<HTMLElement>('nav')).forEach(reconcile)
        }, 300)
    }
}
