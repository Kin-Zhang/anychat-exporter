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
    cmarkNode: 'ms-text-chunk ms-cmark-node',
    promptChunk: '.turn-content > ms-prompt-chunk',
    thoughtChunk: 'ms-thought-chunk',
    navbar: 'ms-navbar-v2, ms-navbar',
    bottomActions: '.bottom-actions',
    pageTitle: 'ms-playground-toolbar .page-title, ms-toolbar .page-title',
    toolbarRight: 'ms-playground-toolbar .toolbar-right, ms-toolbar .toolbar-right',
}

export class AIStudioAdapter implements PlatformAdapter {
    readonly platformName = 'AIStudio'
    readonly hostnames = ['aistudio.google.com']

    checkIfConversationStarted(): boolean {
        return location.pathname.includes('/prompts/')
            && document.querySelectorAll(SELECTORS.chatTurn).length > 0
    }

    async fetchCurrentConversation(): Promise<ConversationResult> {
        const promptId = this.getPromptIdFromUrl() ?? `aistudio-${Date.now()}`
        const title = this.extractTitle()
        const nodes = await this.extractMessagesFromDOM()

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
        if (titleEl) {
            // Skip the incognito/temporary chat indicator ("Temporary chat" is not a real title)
            if (!titleEl.querySelector('ms-incognito-mode-indicator')) {
                const text = titleEl.textContent?.trim()
                if (text && text !== 'Playground') return text
            }
        }
        return document.title.replace(/\s*[-|].*$/, '').trim() || 'AI Studio Conversation'
    }

    private async extractMessagesFromDOM(): Promise<ConversationNode[]> {
        const turns = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.chatTurn))
        const nodes: ConversationNode[] = []

        for (const [i, turn] of turns.entries()) {
            // AI Studio uses Angular virtual scroll: turns scrolled off-screen have empty
            // turn-content. Scroll each turn into view so Angular re-renders it before
            // we try to extract text.
            const turnContent = turn.querySelector('[data-turn-role] .turn-content')
            if (!turnContent || !turnContent.textContent?.trim()) {
                turn.scrollIntoView({ block: 'nearest', behavior: 'instant' })
                await new Promise<void>(resolve => setTimeout(resolve, 150))
            }

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
        }

        for (let i = 0; i < nodes.length - 1; i++) {
            nodes[i].children = [nodes[i + 1].id]
        }

        return nodes
    }

    private extractTurnText(turn: Element, type: 'user' | 'model'): string {
        if (type === 'user') {
            // New UI: content lives inside [data-turn-role="User"] container
            const userContainer = turn.querySelector('[data-turn-role="User"]')
            if (userContainer) {
                const cmark = userContainer.querySelector(SELECTORS.cmarkNode)
                if (cmark) return this.htmlToMarkdown(cmark)
                const tc = userContainer.querySelector(SELECTORS.turnContent)
                if (tc) return this.htmlToMarkdown(tc)
            }
            // Fallback: any ms-cmark-node or .turn-content in the turn element
            const cmark = turn.querySelector(SELECTORS.cmarkNode)
            if (cmark) return this.htmlToMarkdown(cmark)
            const turnContent = turn.querySelector(SELECTORS.turnContent)
            return turnContent ? this.htmlToMarkdown(turnContent) : ''
        }

        // Model: collect from prompt chunks, stripping thought chunk content from each
        const chunks = Array.from(turn.querySelectorAll(SELECTORS.promptChunk))
        const texts = chunks
            .map(chunk => this.htmlToMarkdown(chunk))
            .filter(t => t)

        if (texts.length > 0) return texts.join('\n\n')

        // Fallback: turn content with thought chunks stripped
        const turnContent = turn.querySelector(SELECTORS.turnContent)
        return turnContent ? this.htmlToMarkdown(turnContent) : ''
    }

    // Convert AI Studio's rendered Angular DOM into Markdown.
    //
    // The previous implementation used `textContent` / `innerText`, which:
    //   - lost paragraph, heading, list, and code-block structure
    //   - duplicated every KaTeX expression because KaTeX renders both a
    //     hidden <span class="katex-mathml"> (with the LaTeX source inside
    //     <annotation>) and a visible <span class="katex-html"> (with the
    //     rendered glyphs); textContent concatenates both.
    //
    // We walk the DOM ourselves and emit Markdown, treating <ms-cmark-node>
    // as a transparent wrapper, pulling LaTeX out of <annotation>, and
    // emitting fenced blocks for <ms-code-block>.
    private htmlToMarkdown(root: Element): string {
        interface Ctx { listStack: { ordered: boolean; index: number }[] }

        function renderChildren(el: Node, ctx: Ctx): string {
            let out = ''
            for (const child of Array.from(el.childNodes)) out += render(child, ctx)
            return out
        }

        function render(node: Node, ctx: Ctx): string {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
            if (node.nodeType !== Node.ELEMENT_NODE) return ''
            const el = node as Element
            const tag = el.tagName

            // Skip the model's internal "thinking" content.
            if (tag === 'MS-THOUGHT-CHUNK') return ''

            // KaTeX: extract the LaTeX source from the MathML annotation.
            // Wrap inline expressions in $...$ and display ones in $$...$$.
            if (tag === 'MS-KATEX') {
                const tex = el.querySelector('annotation[encoding="application/x-tex"]')
                    ?.textContent?.trim() ?? ''
                if (!tex) return ''
                const isInline = el.classList.contains('inline')
                    || el.querySelector('.katex-display') === null
                return isInline ? `$${tex}$` : `\n\n$$${tex}$$\n\n`
            }

            // Fenced code blocks (LaTeX, Python, etc.)
            if (tag === 'MS-CODE-BLOCK') {
                const lang = el.getAttribute('data-test-language') ?? ''
                const code = el.querySelector('pre code')?.textContent
                    ?? el.querySelector('pre')?.textContent
                    ?? ''
                return `\n\n\`\`\`${lang}\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`
            }

            // Inline code spans rendered by Angular cmark.
            if (tag === 'SPAN' && el.classList.contains('inline-code')) {
                return `\`${el.textContent ?? ''}\``
            }

            // Transparent wrappers Angular inserts around real content.
            if (
                tag === 'MS-CMARK-NODE'
                || tag === 'MS-TEXT-CHUNK'
                || tag === 'MS-PROMPT-CHUNK'
                || tag === 'SPAN'
            ) {
                return renderChildren(el, ctx)
            }

            switch (tag) {
                case 'P':
                    return `\n\n${renderChildren(el, ctx).trim()}\n\n`
                case 'BR':
                    return '\n'
                case 'STRONG':
                case 'B':
                    return `**${renderChildren(el, ctx)}**`
                case 'EM':
                case 'I':
                    return `*${renderChildren(el, ctx)}*`
                case 'CODE':
                    return `\`${el.textContent ?? ''}\``
                case 'A': {
                    const href = el.getAttribute('href') ?? ''
                    const text = renderChildren(el, ctx)
                    return href ? `[${text}](${href})` : text
                }
                case 'H1': return `\n\n# ${renderChildren(el, ctx).trim()}\n\n`
                case 'H2': return `\n\n## ${renderChildren(el, ctx).trim()}\n\n`
                case 'H3': return `\n\n### ${renderChildren(el, ctx).trim()}\n\n`
                case 'H4': return `\n\n#### ${renderChildren(el, ctx).trim()}\n\n`
                case 'H5': return `\n\n##### ${renderChildren(el, ctx).trim()}\n\n`
                case 'H6': return `\n\n###### ${renderChildren(el, ctx).trim()}\n\n`
                case 'HR': return '\n\n---\n\n'
                case 'BLOCKQUOTE': {
                    const inner = renderChildren(el, ctx).trim()
                    if (!inner) return ''
                    const quoted = inner.split('\n').map(l => l ? `> ${l}` : '>').join('\n')
                    return `\n\n${quoted}\n\n`
                }
                case 'UL':
                case 'OL': {
                    const ordered = tag === 'OL'
                    ctx.listStack.push({ ordered, index: 0 })
                    const items: string[] = []
                    for (const child of Array.from(el.children)) {
                        if (child.tagName !== 'LI') continue
                        const frame = ctx.listStack[ctx.listStack.length - 1]
                        frame.index += 1
                        const indent = '  '.repeat(ctx.listStack.length - 1)
                        const prefix = ordered ? `${frame.index}. ` : '- '
                        const inner = renderChildren(child, ctx).trim()
                        const lines = inner.split('\n')
                        const first = lines.shift() ?? ''
                        const rest = lines.map(l => l ? `${indent}  ${l}` : '').join('\n')
                        items.push(`${indent}${prefix}${first}${rest ? `\n${rest}` : ''}`)
                    }
                    ctx.listStack.pop()
                    return `\n\n${items.join('\n')}\n\n`
                }
                case 'LI':
                    return renderChildren(el, ctx)
                case 'PRE': {
                    const code = el.textContent ?? ''
                    return `\n\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`
                }
                default:
                    return renderChildren(el, ctx)
            }
        }

        const out = render(root, { listStack: [] })
        // Collapse runs of 3+ newlines to exactly 2.
        return out.replace(/\n{3,}/g, '\n\n').trim()
    }
}
