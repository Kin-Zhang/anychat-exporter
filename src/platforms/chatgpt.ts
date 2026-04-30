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
        // We don't trust any single ChatGPT sidebar selector — they've changed
        // the DOM several times. Try multiple anchors in priority order on every
        // tick, and never fall back to a floating overlay that can sit on top
        // of the chat list.
        interface Slot {
            // Where the container should currently live; recomputed each tick.
            parent: HTMLElement
            // Sibling to insert before (null = append).
            before: HTMLElement | null
        }

        const injectionMap = new Map<HTMLElement, HTMLElement>()

        const findSlot = (nav: HTMLElement): Slot | null => {
            // 1. Bottom user/profile area: prefer placing right above it so the
            //    export button shares the sidebar footer with the account menu.
            const profileButton = nav.querySelector<HTMLElement>(
                'button[data-testid="profile-button"], '
                + 'button[data-testid="accounts-profile-button"], '
                + 'button[aria-label*="account" i], '
                + 'button[aria-label*="profile" i]',
            )
            if (profileButton) {
                // Walk up to the row container (a direct child of nav or aside)
                // so the button isn't trapped inside the profile button itself.
                let row: HTMLElement | null = profileButton
                while (row && row.parentElement && row.parentElement !== nav && !row.parentElement.matches('aside, [class*="sidebar"]')) {
                    row = row.parentElement
                }
                if (row?.parentElement) {
                    return { parent: row.parentElement, before: row }
                }
            }

            // 2. Legacy sticky bottom container.
            const stickyBottom = nav.querySelector<HTMLElement>(':scope > div.sticky.bottom-0, :scope aside div.sticky.bottom-0')
            if (stickyBottom) {
                return { parent: stickyBottom, before: stickyBottom.firstElementChild as HTMLElement | null }
            }

            // 3. Any descendant with computed position: sticky in the lower half of the nav.
            const candidates = Array.from(nav.querySelectorAll<HTMLElement>('div, aside'))
            const navRect = nav.getBoundingClientRect()
            for (const el of candidates) {
                if (getComputedStyle(el).position !== 'sticky') continue
                const rect = el.getBoundingClientRect()
                if (rect.top >= navRect.top + navRect.height / 2) {
                    return { parent: el, before: el.firstElementChild as HTMLElement | null }
                }
            }

            // 4. Fallback: top of the nav, as a regular block. Never float.
            return { parent: nav, before: nav.firstElementChild as HTMLElement | null }
        }

        const reconcile = (nav: HTMLElement) => {
            let container = injectionMap.get(nav)
            if (!container) {
                container = getContainer()
                injectionMap.set(nav, container)
                console.warn('[Exporter] Tracking nav for injection', nav)
            }

            const slot = findSlot(nav)
            if (!slot) return
            // Don't reparent into our own container.
            if (slot.parent === container || container.contains(slot.parent)) return

            const alreadyPlaced = container.parentElement === slot.parent
                && container.nextElementSibling === slot.before
            if (alreadyPlaced) return

            slot.parent.insertBefore(container, slot.before)
        }

        sentinel.on('nav', reconcile)

        setInterval(() => {
            injectionMap.forEach((container, nav) => {
                if (!nav.isConnected) {
                    container.remove()
                    injectionMap.delete(nav)
                }
            })
            Array.from(document.querySelectorAll<HTMLElement>('nav')).forEach(reconcile)
        }, 300)
    }
}
