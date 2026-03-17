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
        const injectionMap = new Map<HTMLElement, HTMLElement>()

        const injectNavMenu = (nav: HTMLElement) => {
            if (injectionMap.has(nav)) return
            console.warn('[Exporter] Injecting nav', nav)

            const container = getContainer()
            injectionMap.set(nav, container)

            const chatList = nav.querySelector(':scope > div.sticky.bottom-0')
            if (chatList) {
                chatList.prepend(container)
            }
            else {
                container.style.backgroundColor = '#171717'
                container.style.position = 'sticky'
                container.style.bottom = '72px'
                nav.append(container)
            }
        }

        sentinel.on('nav', injectNavMenu)

        setInterval(() => {
            injectionMap.forEach((container, nav) => {
                if (!nav.isConnected) {
                    container.remove()
                    injectionMap.delete(nav)
                }
            })
            Array.from(document.querySelectorAll('nav'))
                .filter(nav => !injectionMap.has(nav))
                .forEach(injectNavMenu)
        }, 300)
    }
}
