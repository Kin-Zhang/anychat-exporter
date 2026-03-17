import html2canvas from 'html2canvas'
import i18n from '../i18n'
import { getChatIdFromUrl } from '../page'
import { checkIfConversationStarted } from '../platforms/service'
import { downloadUrl, getFileNameWithFormat } from '../utils/download'
import { Effect } from '../utils/effect'
import { sleep } from '../utils/utils'

// https://github.com/niklasvh/html2canvas/issues/2792#issuecomment-1042948572
function fnIgnoreElements(el: any) {
    return typeof el.shadowRoot === 'object' && el.shadowRoot !== null
}

export async function exportToPng(fileNameFormat: string) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    const effect = new Effect()

    let thread = document.querySelector('#thread div:has(> [data-testid="conversation-turn-1"])')
    let isClaude = false

    if (!thread) {
        const claudeMessages = document.querySelectorAll('[data-test-render-count]')
        if (claudeMessages.length > 0) {
            thread = claudeMessages[0].parentElement
            isClaude = true
        }
    }

    if (!thread || thread.children.length === 0 || thread.scrollHeight < 50) {
        alert(i18n.t('Failed to export to PNG. Failed to find the element node.'))
        return false
    }

    const isDarkMode = document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-mode') === 'dark'

    effect.add(() => {
        const style = document.createElement('style')

        if (isClaude) {
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
            style.textContent = `
                #thread div:has(> [data-testid="conversation-turn-1"]),
                #thread [data-testid^="conversation-turn-"] {
                    color: ${isDarkMode ? '#ececec' : '#0d0d0d'};
                    background-color: ${isDarkMode ? '#212121' : '#fff'};
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

    const passLimit = 10
    const takeScreenshot = async (width: number, height: number, additionalScale = 1, currentPass = 1): Promise<string | null> => {
        const ratio = window.devicePixelRatio || 1
        const scale = ratio * 2 * additionalScale // scale up to 2x to avoid blurry images

        let canvas: HTMLCanvasElement | null = null
        try {
            canvas = await html2canvas(threadEl, {
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
            // eslint-disable-next-line no-console
            console.warn(`ChatGPT Exporter:takeScreenshot with height=${height} width=${width} scale=${scale}`)
            console.error('Failed to take screenshot', error)
        }

        const context = canvas?.getContext('2d')
        if (context) context.imageSmoothingEnabled = false

        const dataUrl = canvas?.toDataURL('image/png', 1)
            .replace(/^data:image\/[^;]/, 'data:application/octet-stream')

        /**
         * corrupted image
         * meaning we might hit on the canvas size limit
         * See https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas#maximum_canvas_size
         * Chromium will not throw, we can only get an empty canvas
         * Firefox will throw "DOMException: CanvasRenderingContext2D.scale: Canvas exceeds max size."
         */
        if (!canvas || !dataUrl || dataUrl === 'data:,') {
            if (currentPass > passLimit) return null

            // 1.4 ^ 5 ~= 5.37, should be enough for most cases
            return takeScreenshot(width, height, additionalScale / 1.4, currentPass + 1)
        }

        return dataUrl
    }

    const dataUrl = await takeScreenshot(thread.scrollWidth, thread.scrollHeight)
    effect.dispose()

    if (!dataUrl) {
        alert('Failed to export to PNG. This might be caused by the size of the conversation. Please try to export a smaller conversation.')
        return false
    }

    let chatId = getChatIdFromUrl()
    if (!chatId && isClaude) {
        chatId = location.pathname.match(/\/chat\/([a-z0-9-]+)/i)?.[1] || null
    }

    const fileName = getFileNameWithFormat(fileNameFormat, 'png', { chatId: chatId || undefined })
    downloadUrl(fileName, dataUrl)
    window.URL.revokeObjectURL(dataUrl)

    return true
}
