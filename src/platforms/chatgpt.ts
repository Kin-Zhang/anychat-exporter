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
        //     <nav id="stage-sidebar-tiny-bar" inert opacity-0>   ← collapsed-rail copy
        //     <div opacity-100>                                    ← expanded sidebar
        //       <h2>Chat history</h2>
        //       <div flex-col>
        //         <nav aria-label="Chat history">                  ← chat list
        //         <div bg-sidebar-surface-primary>                 ← profile/account block
        //           <button data-testid="accounts-profile-button">
        //
        // Goal: dock our container as the immediate next sibling of the visible
        // chat-history <nav>, i.e. just above the profile container. The tiny-
        // bar nav has its own profile button so we must NOT match against it.
        //
        // Pitfall: once we insert ourselves, the profile container's
        // previousElementSibling becomes our own div, not the nav. Any matching
        // logic must therefore skip elements marked data-anychat-exporter.
        let container: HTMLElement | null = null

        const skipOurs = (el: Element | null, dir: 'prev' | 'next'): Element | null => {
            while (el && (el as HTMLElement).matches?.('[data-anychat-exporter]')) {
                el = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling
            }
            return el
        }

        const isInteractive = (el: HTMLElement) => {
            if (el.hasAttribute('inert')) return false
            const styles = getComputedStyle(el)
            if (Number.parseFloat(styles.opacity) < 0.5) return false
            if (styles.visibility === 'hidden' || styles.display === 'none') return false
            return true
        }

        const isVisible = (el: HTMLElement) => {
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
        }

        // Find the chat-history nav: a tall, interactive <nav> whose immediate
        // (non-ours) next sibling contains a visible profile button.
        const findChatNav = (): HTMLElement | null => {
            const navs = Array.from(document.querySelectorAll<HTMLElement>('nav'))
            let best: { nav: HTMLElement; height: number } | null = null
            for (const nav of navs) {
                if (!isInteractive(nav)) continue
                const navRect = nav.getBoundingClientRect()
                if (navRect.height < 200) continue
                const sibling = skipOurs(nav.nextElementSibling, 'next') as HTMLElement | null
                if (!sibling) continue
                const profileBtn = sibling.querySelector<HTMLElement>(
                    '[data-testid="accounts-profile-button"], [data-testid="profile-button"]',
                )
                if (!profileBtn || !isVisible(profileBtn)) continue
                if (!best || navRect.height > best.height) {
                    best = { nav, height: navRect.height }
                }
            }
            return best?.nav ?? null
        }

        const reconcile = () => {
            const chatNav = findChatNav()
            if (!chatNav?.parentElement) {
                // Sidebar isn't in the right state yet (collapsed, loading, etc).
                // Wait for the next tick rather than dropping the button somewhere wrong.
                return
            }

            if (!container || !container.isConnected) {
                container = getContainer()
                container.setAttribute('data-anychat-exporter', '')
            }

            const correctlyPlaced = container.parentElement === chatNav.parentElement
                && container.previousElementSibling === chatNav
            if (correctlyPlaced) return

            chatNav.insertAdjacentElement('afterend', container)
        }

        sentinel.on('nav', reconcile)
        setInterval(reconcile, 300)
    }
}
