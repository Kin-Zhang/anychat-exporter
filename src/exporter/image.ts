import * as htmlToImage from 'html-to-image'
import html2canvas from 'html2canvas'
import i18n from '../i18n'
import { getChatIdFromUrl } from '../page'
import { checkIfConversationStarted } from '../platforms/service'
import { downloadUrl, getFileNameWithFormat } from '../utils/download'
import { Effect } from '../utils/effect'
import { sleep } from '../utils/utils'

// https://github.com/niklasvh/html2canvas/issues/2792#issuecomment-1042948572
// Gemini uses custom elements with shadow roots that we still need to capture.
// html2canvas cannot handle Shadow DOM — we use html-to-image for Gemini instead.
const GEMINI_CAPTURE_TAGS = new Set(['conversation-turn', 'model-response', 'user-query', 'message-content'])
function fnIgnoreElements(el: any) {
    if (GEMINI_CAPTURE_TAGS.has(String(el.tagName).toLowerCase())) return false
    return typeof el.shadowRoot === 'object' && el.shadowRoot !== null
}

/**
 * Find the tightest container that wraps all Gemini conversation turns,
 * without climbing so high that we accidentally include the sidebar.
 *
 * Strategy (top-down, not bottom-up):
 *  1. Prefer the <infinite-scroller> or <ms-chat-turn-container> element —
 *     these are Gemini's dedicated scroll containers for the chat area.
 *  2. Fall back to the lowest common ancestor of all conversation-turn elements
 *     that is NOT wider than ~60 % of the viewport (sidebars are ~240 px wide,
 *     the chat column fills the rest).
 */
function findGeminiThread(): HTMLElement | null {
    // Gemini renders TWO <infinite-scroller> elements:
    //   [0] = sidebar conversation history list (no .conversation-container inside)
    //   [1] = the actual chat thread (contains .conversation-container turns)
    // We must pick the one that actually contains conversation turns.
    const allScrollers = Array.from(document.querySelectorAll<HTMLElement>('infinite-scroller'))
    const chatScroller = allScrollers.find(el => el.querySelector('.conversation-container, user-query, model-response') !== null)
    if (chatScroller) return chatScroller

    // Fallback: walk up from the first .conversation-container until we find
    // the tightest ancestor with real height that excludes the sidebar.
    const firstTurn = document.querySelector<HTMLElement>('.conversation-container, user-query')
    if (!firstTurn) return null

    let candidate: HTMLElement | null = firstTurn.parentElement
    let best: HTMLElement | null = firstTurn
    const maxWidth = window.innerWidth * 0.80
    while (candidate && candidate !== document.body) {
        const rect = candidate.getBoundingClientRect()
        if (rect.width > maxWidth) break
        if (rect.height > 0) best = candidate
        candidate = candidate.parentElement as HTMLElement | null
    }
    return best
}

/**
 * Find the container wrapping AI Studio chat turns (ms-chat-turn).
 *
 * IMPORTANT: We must avoid returning `ms-autoscroll-container` because it has
 * `container-type: size` (CSS Container Queries) which html2canvas cannot handle.
 * Target `.chat-session-content` instead — it directly holds all turns with safe CSS.
 */
function findAIStudioThread(): HTMLElement | null {
    // Best: the named container that directly wraps all turns
    const sessionContent = document.querySelector<HTMLElement>('.chat-session-content')
    if (sessionContent && sessionContent.querySelectorAll('ms-chat-turn').length > 0) {
        return sessionContent
    }

    // Fallback: walk up from first turn, avoiding container-type elements
    const firstTurn = document.querySelector<HTMLElement>('ms-chat-turn')
    if (!firstTurn) return null
    return firstTurn.parentElement || firstTurn
}

/**
 * Take screenshot of AI Studio chat. The DOM hierarchy is:
 *   ms-autoscroll-container (overflow:auto; height:100%; container-type:size)
 *     └── div
 *           └── div.chat-session-content  ← our target
 *                 └── ms-chat-turn × N
 *
 * We must temporarily expand ALL scroll ancestors to reveal the full content,
 * and also disable `container-type` which breaks html2canvas.
 * Uses html-to-image (better Angular rendering), then falls back to html2canvas.
 */
async function takeAIStudioScreenshot(threadEl: HTMLElement, isDarkMode: boolean): Promise<string | null> {
    // Pre-render: Angular virtual scroll empties off-screen turns. Scroll each
    // virtualized turn into view so it renders before we capture the DOM.
    const allTurns = Array.from(document.querySelectorAll<HTMLElement>('ms-chat-turn'))
    for (const turn of allTurns) {
        const content = turn.querySelector('[data-turn-role] .turn-content')
        if (!content?.children.length) {
            turn.scrollIntoView({ block: 'nearest', behavior: 'instant' })
            await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
    }

    const ratio = window.devicePixelRatio || 1
    const scale = ratio * 2
    const bg = getComputedStyle(document.body).backgroundColor || (isDarkMode ? '#1b1b1f' : '#ffffff')

    // Save target element's original styles
    const savedTarget = {
        width: threadEl.style.width,
        minWidth: threadEl.style.minWidth,
        maxWidth: threadEl.style.maxWidth,
        margin: threadEl.style.margin,
    }
    // Force the target to render at its natural max-width (1000px), not squeezed by sidebar
    threadEl.style.width = '1000px'
    threadEl.style.minWidth = '1000px'
    threadEl.style.margin = '0'

    // Expand ALL scroll ancestors so the full conversation is visible
    const saved: Array<{ el: HTMLElement; ov: string; h: string; mh: string; ct: string; w: string; mw: string }> = []
    let anc: HTMLElement | null = threadEl.parentElement
    while (anc && anc !== document.body) {
        const cs = getComputedStyle(anc)
        const needsExpand = cs.overflow !== 'visible' || cs.overflowY !== 'visible'
            || (cs as any).containerType !== 'normal'
        // Also expand width on all ancestors to accommodate wider content
        saved.push({
            el: anc,
            ov: anc.style.overflow,
            h: anc.style.height,
            mh: anc.style.maxHeight,
            ct: anc.style.getPropertyValue('container-type'),
            w: anc.style.width,
            mw: anc.style.minWidth,
        })
        if (needsExpand) {
            anc.style.overflow = 'visible'
            anc.style.height = 'auto'
            anc.style.maxHeight = 'none'
            anc.style.setProperty('container-type', 'normal')
        }
        anc.style.width = 'auto'
        anc.style.minWidth = '1000px'
        anc = anc.parentElement
    }

    await new Promise(r => requestAnimationFrame(r))

    const fullWidth = threadEl.scrollWidth
    const fullHeight = threadEl.scrollHeight
    let dataUrl: string | null = null

    // Try html-to-image first — preserves Angular rendered output better
    try {
        const url = await htmlToImage.toPng(threadEl, {
            pixelRatio: scale,
            backgroundColor: bg,
            width: fullWidth,
            height: fullHeight,
            skipFonts: true,
            filter: (node: Node) => {
                if (!(node instanceof Element)) return true
                const tag = node.tagName.toLowerCase()
                if (tag === 'ms-thought-chunk') return false
                const cls = node.classList
                if (cls.contains('bottom-overlay') || cls.contains('chat-bottom-overlay')) return false
                return true
            },
        })
        if (url && url !== 'data:,') {
            dataUrl = url.replace(/^data:image\/[^;]+/, 'data:application/octet-stream')
        }
    }
    catch (e) {
        console.warn('[Exporter] html-to-image failed for AI Studio', e)
    }

    // Fallback: html2canvas (container-type is already neutralised)
    if (!dataUrl) {
        console.warn('[Exporter] Trying html2canvas fallback for AI Studio')
        const passLimit = 5
        const tryCanvas = async (additionalScale = 1, pass = 1): Promise<string | null> => {
            try {
                const canvas = await html2canvas(threadEl, {
                    scale: ratio * 2 * additionalScale,
                    useCORS: true,
                    scrollX: -window.scrollX,
                    scrollY: -window.scrollY,
                    windowWidth: fullWidth,
                    windowHeight: fullHeight,
                    ignoreElements: fnIgnoreElements,
                })
                const url = canvas?.toDataURL('image/png', 1)
                    ?.replace(/^data:image\/[^;]+/, 'data:application/octet-stream')
                if (url && url !== 'data:,') return url
            }
            catch (e) {
                console.warn(`[Exporter] html2canvas pass ${pass} failed`, e)
            }
            if (pass >= passLimit) return null
            return tryCanvas(additionalScale / 1.4, pass + 1)
        }
        dataUrl = await tryCanvas()
    }

    // Restore target element styles
    threadEl.style.width = savedTarget.width
    threadEl.style.minWidth = savedTarget.minWidth
    threadEl.style.maxWidth = savedTarget.maxWidth
    threadEl.style.margin = savedTarget.margin

    // Restore all ancestor styles
    for (const { el, ov, h, mh, ct, w, mw } of saved) {
        el.style.overflow = ov
        el.style.height = h
        el.style.maxHeight = mh
        el.style.width = w
        el.style.minWidth = mw
        if (ct) el.style.setProperty('container-type', ct)
        else el.style.removeProperty('container-type')
    }

    return dataUrl
}

/**
 * Use html-to-image for Gemini — it handles Shadow DOM and custom elements
 * that html2canvas cannot render, which caused the export to freeze/hang.
 *
 * We temporarily make the element "unclipped" so html-to-image can render
 * the full scrollable height, not just the visible viewport slice.
 */
async function takeGeminiScreenshot(threadEl: HTMLElement, isDarkMode: boolean): Promise<string | null> {
    const ratio = window.devicePixelRatio || 1
    const scale = ratio * 2

    const bg = getComputedStyle(document.body).backgroundColor || (isDarkMode ? '#1e1f20' : '#ffffff')

    // Temporarily expand overflow so html-to-image sees the full content height
    const prevOverflow = threadEl.style.overflow
    const prevHeight = threadEl.style.height
    const prevMaxHeight = threadEl.style.maxHeight
    threadEl.style.overflow = 'visible'
    threadEl.style.height = 'auto'
    threadEl.style.maxHeight = 'none'

    // Give the browser one frame to reflow
    await new Promise(r => requestAnimationFrame(r))

    const fullWidth = threadEl.scrollWidth
    const fullHeight = threadEl.scrollHeight

    try {
        const dataUrl = await htmlToImage.toPng(threadEl, {
            pixelRatio: scale,
            backgroundColor: bg,
            canvasWidth: fullWidth,
            canvasHeight: fullHeight,
            width: fullWidth,
            height: fullHeight,
            // Skip UI chrome elements
            filter: (node: Node) => {
                if (!(node instanceof Element)) return true
                const tag = node.tagName.toLowerCase()
                const skipTags = ['input-area-v2', 'toolbox-drawer', 'message-actions']
                if (skipTags.includes(tag)) return false
                const skipClasses = [
                    'input-area-container',
                    'action-buttons',
                    'regenerate-button',
                    'scroll-to-bottom-button',
                    'bottom-of-page-button',
                ]
                if (skipClasses.some(cls => node.classList.contains(cls))) return false
                return true
            },
        })
        return dataUrl.replace(/^data:image\/[^;]+/, 'data:application/octet-stream')
    }
    catch (error) {
        console.error('[Exporter] html-to-image failed for Gemini', error)
        return null
    }
    finally {
        // Restore original styles
        threadEl.style.overflow = prevOverflow
        threadEl.style.height = prevHeight
        threadEl.style.maxHeight = prevMaxHeight
    }
}

export async function exportToPng(fileNameFormat: string) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    const effect = new Effect()

    // ChatGPT: the element that directly parents all turns is wide (full viewport),
    // so we look one level deeper — the turns' own parent element — which is the
    // narrower content column. Fall back to the wider container if needed.
    let thread: Element | null = null
    {
        const firstTurn = document.querySelector<HTMLElement>('[data-testid="conversation-turn-1"]')
        if (firstTurn) {
            // Prefer the first turn's direct parent (narrower content column).
            // Only use it if it actually contains multiple turns (not a single-turn wrapper).
            const directParent = firstTurn.parentElement
            if (directParent && directParent.querySelectorAll('[data-testid^="conversation-turn-"]').length > 0) {
                thread = directParent
            }
            else {
                thread = document.querySelector('#thread div:has(> [data-testid="conversation-turn-1"])')
            }
        }
    }
    let isClaude = false
    let isGemini = false
    let isAIStudio = false

    if (!thread) {
        const claudeMessages = document.querySelectorAll('[data-test-render-count]')
        if (claudeMessages.length > 0) {
            thread = claudeMessages[0].parentElement
            isClaude = true
        }
    }

    // AI Studio: ms-chat-turn custom elements
    if (!thread) {
        const aiStudioThread = findAIStudioThread()
        if (aiStudioThread) {
            thread = aiStudioThread
            isAIStudio = true
        }
    }

    // Gemini: use focused selector logic that avoids grabbing the sidebar
    if (!thread) {
        const geminiThread = findGeminiThread()
        if (geminiThread) {
            thread = geminiThread
            isGemini = true
        }
    }

    if (!thread || thread.children.length === 0) {
        alert(i18n.t('Failed to export to PNG. Failed to find the element node.'))
        return false
    }

    const isDarkMode = document.documentElement.classList.contains('dark')
        || document.documentElement.getAttribute('data-mode') === 'dark'
        || document.body.classList.contains('dark-theme')

    effect.add(() => {
        const style = document.createElement('style')

        if (isAIStudio) {
            const bg = getComputedStyle(document.body).backgroundColor || (isDarkMode ? '#1b1b1f' : '#ffffff')
            style.textContent = `
                ms-chat-turn, .chunk-editor-main {
                    background-color: ${bg};
                }
                ms-thought-chunk,
                .bottom-overlay,
                .input-area,
                .chat-bottom-overlay {
                    display: none !important;
                }
                img {
                    display: initial !important;
                }
            `
        }
        else if (isGemini) {
            // For Gemini we use html-to-image which handles Shadow DOM natively.
            // We still inject a minimal style to stabilise backgrounds.
            const bg = getComputedStyle(document.body).backgroundColor || (isDarkMode ? '#1e1f20' : '#ffffff')
            style.textContent = `
                /* stable background for screenshot */
                chat-window-content,
                infinite-scroller,
                .conversation-container {
                    background-color: ${bg};
                }

                /* hide input bar, toolbar, action buttons */
                input-area-v2,
                .input-area-container,
                toolbox-drawer,
                message-actions,
                .action-buttons,
                .regenerate-button,
                .scroll-to-bottom-button,
                .bottom-of-page-button {
                    display: none !important;
                }

                img {
                    display: initial !important;
                }
            `
        }
        else if (isClaude) {
            style.textContent = `
                /* ensure background is not transparent */
                div:has(> [data-test-render-count]) {
                    background-color: ${getComputedStyle(document.body).backgroundColor || (isDarkMode ? '#2d2d2d' : '#f9f9f9')};
                }
                
                /* hide action bar */
                div[aria-label="Message actions"] {
                    display: none;
                }
            `
        }
        else {
            // ChatGPT: remove horizontal padding/centering from the thread container
            // so the captured image has no empty side margins.
            const chatBg = isDarkMode ? '#212121' : '#fff'
            const chatFg = isDarkMode ? '#ececec' : '#0d0d0d'
            style.textContent = `
                #thread div:has(> [data-testid="conversation-turn-1"]),
                #thread [data-testid^="conversation-turn-"] {
                    color: ${chatFg};
                    background-color: ${chatBg};
                }

                /* Remove horizontal padding from the container and turns to eliminate
                   empty side margins in the captured image */
                #thread div:has(> [data-testid="conversation-turn-1"]) {
                    padding-left: 0 !important;
                    padding-right: 0 !important;
                }
                #thread [data-testid^="conversation-turn-"] > * {
                    max-width: 100% !important;
                    margin-left: 0 !important;
                    margin-right: 0 !important;
                    padding-left: 16px !important;
                    padding-right: 16px !important;
                }

                /* https://github.com/niklasvh/html2canvas/issues/2775#issuecomment-1204988157 */
                img {
                    display: initial !important;
                }

                pre {
                    margin-top: 8px !important;
                }

                pre > div > div > span {
                    margin-top: -12px;
                    padding-bottom: 2px;
                }

                #page-header,
                #thread-bottom-container,
                /* any other elements that are not conversation turns */
                #thread div:has(> [data-testid="conversation-turn-1"]) > :not([data-testid^="conversation-turn-"]),
                /* hide back to top button */
                button.absolute,
                /* question button */
                .group.absolute > button {
                    display: none;
                }

                /* conversation action bar */
                .group\\/conversation-turn > div > div.absolute,
                /* code block buttons */
                #thread pre button {
                    visibility: hidden;
                }
            `
        }

        thread!.appendChild(style)
        return () => style.remove()
    })

    const threadEl = thread as HTMLElement

    effect.run()

    await sleep(100)

    let dataUrl: string | null = null

    const takeHtml2canvasScreenshot = async (el: HTMLElement): Promise<string | null> => {
        const passLimit = 10
        const take = async (width: number, height: number, additionalScale = 1, currentPass = 1): Promise<string | null> => {
            const ratio = window.devicePixelRatio || 1
            const scale = ratio * 2 * additionalScale

            let canvas: HTMLCanvasElement | null = null
            try {
                canvas = await html2canvas(el, {
                    scale,
                    useCORS: true,
                    scrollX: -window.scrollX,
                    scrollY: -window.scrollY,
                    windowWidth: width,
                    windowHeight: height,
                    ignoreElements: fnIgnoreElements,
                })
            }
            catch (error) {
                console.warn(`[Exporter] html2canvas pass ${currentPass} failed`, error)
            }

            const context = canvas?.getContext('2d')
            if (context) context.imageSmoothingEnabled = false

            const url = canvas?.toDataURL('image/png', 1)
                .replace(/^data:image\/[^;]+/, 'data:application/octet-stream')

            if (!canvas || !url || url === 'data:,') {
                if (currentPass > passLimit) return null
                return take(width, height, additionalScale / 1.4, currentPass + 1)
            }

            return url
        }
        return take(el.scrollWidth, el.scrollHeight)
    }

    if (isAIStudio) {
        dataUrl = await takeAIStudioScreenshot(threadEl, isDarkMode)
    }
    else if (isGemini) {
        dataUrl = await takeGeminiScreenshot(threadEl, isDarkMode)
    }
    else {
        // For ChatGPT (and fallback): constrain the container to the actual content
        // width (measured from the first turn's inner element) so the screenshot
        // doesn't include empty side margins left by the centering layout.
        const savedWidth = threadEl.style.width
        const savedMaxWidth = threadEl.style.maxWidth
        const savedMargin = threadEl.style.margin
        const firstInner = threadEl.querySelector<HTMLElement>(
            '[data-testid^="conversation-turn-"] > *',
        )
        if (firstInner) {
            const contentWidth = firstInner.scrollWidth
            if (contentWidth > 400 && contentWidth < threadEl.scrollWidth) {
                threadEl.style.width = `${contentWidth}px`
                threadEl.style.maxWidth = `${contentWidth}px`
                threadEl.style.margin = '0'
                await new Promise(r => requestAnimationFrame(r))
            }
        }
        dataUrl = await takeHtml2canvasScreenshot(threadEl)
        threadEl.style.width = savedWidth
        threadEl.style.maxWidth = savedMaxWidth
        threadEl.style.margin = savedMargin
    }

    effect.dispose()

    if (!dataUrl) {
        alert('Failed to export to PNG. This might be caused by the size of the conversation. Please try to export a smaller conversation.')
        return false
    }

    let chatId = getChatIdFromUrl()
    if (!chatId && isClaude) {
        chatId = location.pathname.match(/\/chat\/([a-z0-9-]+)/i)?.[1] || null
    }
    if (!chatId && isGemini) {
        chatId = location.pathname.match(/\/app\/([a-z0-9]+)/i)?.[1] || null
    }
    if (!chatId && isAIStudio) {
        chatId = location.pathname.match(/\/prompts\/([^/]+)/i)?.[1] || null
    }

    const fileName = getFileNameWithFormat(fileNameFormat, 'png', { chatId: chatId || undefined })
    downloadUrl(fileName, dataUrl)
    window.URL.revokeObjectURL(dataUrl)

    return true
}
