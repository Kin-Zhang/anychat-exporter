import { useEffect, useState } from 'preact/hooks'
import { getColorScheme } from '../utils/utils'

/**
 * Reactively tracks the page's dark/light mode.
 * Works across all supported platforms (ChatGPT, Claude, Gemini, AI Studio)
 * even when they don't use the standard `.dark` class convention.
 */
export function useColorScheme(): 'light' | 'dark' {
    const [scheme, setScheme] = useState<'light' | 'dark'>(getColorScheme)

    useEffect(() => {
        const update = () => setScheme(getColorScheme())

        // Watch for class / attribute changes on <html> and <body>
        const observer = new MutationObserver(update)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] })

        // Watch system preference changes
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        mq.addEventListener('change', update)

        return () => {
            observer.disconnect()
            mq.removeEventListener('change', update)
        }
    }, [])

    return scheme
}
