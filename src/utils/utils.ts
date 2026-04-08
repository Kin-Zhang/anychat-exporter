export function noop() {}

export function nonNullable<T>(x: T): x is NonNullable<T> {
    return x != null
}

export function onloadSafe(fn: () => void) {
    if (document.readyState === 'complete') {
        fn()
    }
    else {
        window.addEventListener('load', fn)
    }
}

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function dateStr(date: Date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function timestamp() {
    return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
}

export function getColorScheme(): 'light' | 'dark' {
    const html = document.documentElement
    const body = document.body

    // 1. Inline color-scheme CSS property (ChatGPT sets this)
    const inlineScheme = html.style.getPropertyValue('color-scheme')
    if (inlineScheme === 'dark') return 'dark'
    if (inlineScheme === 'light') return 'light'

    // 2. Class-based dark mode (.dark, .dark-theme — ChatGPT, Claude)
    if (html.classList.contains('dark') || html.classList.contains('dark-theme')
        || body.classList.contains('dark') || body.classList.contains('dark-theme')) {
        return 'dark'
    }

    // 3. data-theme attribute (Gemini, some other sites)
    const dataTheme = html.getAttribute('data-theme') || body.getAttribute('data-theme')
    if (dataTheme === 'dark') return 'dark'
    if (dataTheme === 'light') return 'light'

    // 4. Computed background color heuristic (works for AI Studio and others
    //    that change the background without using a recognised attribute)
    const bg = window.getComputedStyle(body).backgroundColor
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (match) {
        const luminance = 0.299 * +match[1] + 0.587 * +match[2] + 0.114 * +match[3]
        if (luminance < 80) return 'dark'
    }

    // 5. System preference fallback
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function unixTimestampToISOString(timestamp: number) {
    if (!timestamp) return ''
    return (new Date(timestamp * 1000)).toISOString()
}

export function jsonlStringify(list: any[]): string {
    // This _has_ to be stringified without adding any indentation
    return list.map((msg: any) => JSON.stringify(msg)).join('\n')
}
