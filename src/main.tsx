import { render } from 'preact'
import sentinel from 'sentinel-js'
import { fetchConversation, processConversation } from './api'
import { getChatIdFromUrl, isSharePage } from './page'
import { ChatGPTAdapter } from './platforms/chatgpt'
import { ClaudeAdapter } from './platforms/claude'
import { GeminiAdapter } from './platforms/gemini'
import { setActiveAdapter } from './platforms/service'
import { Menu } from './ui/Menu'
import { onloadSafe } from './utils/utils'

import './i18n'
import './styles/missing-tailwind.css'

main()

function main() {
    onloadSafe(() => {
        // --- Platform detection ---
        const hostname = location.hostname
        const allAdapters = [
            new ChatGPTAdapter(),
            new ClaudeAdapter(),
            new GeminiAdapter(),
        ]

        const adapter = allAdapters.find(a => a.hostnames.includes(hostname))
        if (!adapter) {
            console.warn('[Exporter] Unsupported platform:', hostname)
            return
        }

        setActiveAdapter(adapter)
        console.warn('[Exporter] Loaded for', hostname)

        // Set up the style sentinel container
        const styleEl = document.createElement('style')
        styleEl.id = 'sentinel-css'
        document.head.append(styleEl)

        // Inject the export menu using platform-specific UI injection
        adapter.injectUI(() => getMenuContainer())

        // Support for ChatGPT share pages (not applicable to Claude/Gemini)
        if (isSharePage()) {
            sentinel.on(`div[role="presentation"] > .w-full > div >.flex.w-full`, (target) => {
                target.prepend(getMenuContainer())
            })
        }

        // Insert timestamps on ChatGPT pages only (uses ChatGPT-specific data)
        if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') {
            injectChatGPTTimestamps()
        }
    })
}

// ChatGPT-only: inject per-message timestamps into the conversation UI
function injectChatGPTTimestamps() {
    let chatId = ''
    sentinel.on('[role="presentation"]', async () => {
        const currentChatId = getChatIdFromUrl()
        if (!currentChatId || currentChatId === chatId) return
        chatId = currentChatId

        const rawConversation = await fetchConversation(chatId, false)
        const { conversationNodes } = processConversation(rawConversation)

        const threadContents = Array.from(
            document.querySelectorAll('main [data-testid^="conversation-turn-"] [data-message-id]'),
        )
        if (threadContents.length === 0) return

        threadContents.forEach((thread, index) => {
            const createTime = conversationNodes[index]?.message?.create_time
            if (!createTime) return

            const date = new Date(createTime * 1000)
            const timestamp = document.createElement('time')
            timestamp.className = 'w-full text-gray-500 dark:text-gray-400 text-sm text-right'
            timestamp.dateTime = date.toISOString()
            timestamp.title = date.toLocaleString()

            const hour12 = document.createElement('span')
            hour12.setAttribute('data-time-format', '12')
            hour12.textContent = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            const hour24 = document.createElement('span')
            hour24.setAttribute('data-time-format', '24')
            hour24.textContent = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

            timestamp.append(hour12, hour24)
            thread.append(timestamp)
        })
    })
}

function getMenuContainer() {
    const container = document.createElement('div')
    container.style.zIndex = '99'
    render(<Menu container={container} />, container)
    return container
}
