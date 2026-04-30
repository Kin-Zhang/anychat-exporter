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
        // ChatGPT's sidebar DOM has changed several times. Rather than relying on
        // a brittle fixed selector, we find the structural "bottom block" of the
        // sidebar — the row that holds the user/profile button — and insert our
        // container right before it. That keeps the export button docked next
        // to the account menu instead of floating in the chat list or sitting
        // at the very top.
        interface Slot {
            parent: HTMLElement
            before: HTMLElement | null
        }
        const EXPORTER_MARK = 'data-anychat-exporter'
        const injectionMap = new Map<HTMLElement, HTMLElement>()

        const isVisible = (el: HTMLElement) => {
            if (!el.isConnected) return false
            // offsetParent is null for display:none and for fixed elements off-screen,
            // but our siblings here are normal flow elements.
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
        }

        // Pick the deepest container in the sidebar whose direct children are
        // the top-level sidebar sections (history list, footer/user block, etc.).
        // ChatGPT sometimes wraps the sidebar in an extra <aside>.
        const findSidebarRoot = (nav: HTMLElement): HTMLElement => {
            const aside = nav.querySelector<HTMLElement>(':scope > aside')
            if (aside) return aside
            // If the nav has a single wrapper child that itself holds the layout, use that.
            const onlyChild = nav.children.length === 1 ? nav.firstElementChild as HTMLElement : null
            if (onlyChild && onlyChild.children.length >= 2) return onlyChild
            return nav
        }

        // The user/profile block is the last visible direct child of the sidebar
        // root, ignoring our own injected container.
        const findFooterRow = (root: HTMLElement, container: HTMLElement): HTMLElement | null => {
            for (let i = root.children.length - 1; i >= 0; i--) {
                const el = root.children[i] as HTMLElement
                if (el === container) continue
                if (el.contains(container)) continue
                if (!isVisible(el)) continue
                return el
            }
            return null
        }

        const findSlot = (nav: HTMLElement, container: HTMLElement): Slot | null => {
            const root = findSidebarRoot(nav)
            const footer = findFooterRow(root, container)
            if (footer) {
                return { parent: root, before: footer }
            }
            // Sidebar isn't ready yet — don't inject anywhere visible. Returning
            // null means "wait for the next tick" rather than dropping the button
            // at the top of the sidebar.
            return null
        }

        const reconcile = (nav: HTMLElement) => {
            let container = injectionMap.get(nav)
            if (!container) {
                container = getContainer()
                container.setAttribute(EXPORTER_MARK, '')
                injectionMap.set(nav, container)
            }

            const slot = findSlot(nav, container)
            if (!slot) {
                // Detach if we're currently in a stale slot.
                return
            }
            if (slot.parent === container || container.contains(slot.parent)) return

            const alreadyPlaced = container.parentElement === slot.parent
                && container.nextElementSibling === slot.before
            if (alreadyPlaced) return

            slot.parent.insertBefore(container, slot.before)
        }

        sentinel.on('nav', reconcile)

        const isSidebarNav = (nav: HTMLElement) => {
            // Sidebar nav fills most of the viewport height; header / breadcrumb
            // navs are short. This avoids injecting into the wrong <nav>.
            const rect = nav.getBoundingClientRect()
            return rect.height >= Math.min(400, window.innerHeight * 0.5)
        }

        setInterval(() => {
            injectionMap.forEach((container, nav) => {
                if (!nav.isConnected) {
                    container.remove()
                    injectionMap.delete(nav)
                }
            })
            Array.from(document.querySelectorAll<HTMLElement>('nav'))
                .filter(isSidebarNav)
                .forEach(reconcile)
        }, 300)
    }
}
