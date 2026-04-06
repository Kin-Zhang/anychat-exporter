import type { PlatformAdapter } from './types'
import type { ConversationResult } from '../api'

let activeAdapter: PlatformAdapter | null = null

// Set the adapter for the current platform (called once in main.tsx)
export function setActiveAdapter(adapter: PlatformAdapter) {
    activeAdapter = adapter
}

export function getActiveAdapter(): PlatformAdapter {
    if (!activeAdapter) throw new Error('[Exporter] No platform adapter registered')
    return activeAdapter
}

// Get the platform name (e.g. 'ChatGPT', 'Claude', 'Gemini')
export function getPlatformName(): string {
    return activeAdapter?.platformName ?? 'Chat'
}

// Whether the current platform supports export-all functionality
export function supportsExportAll(): boolean {
    return activeAdapter?.supportsExportAll() ?? false
}

// Check if a conversation is open and can be exported
export function checkIfConversationStarted(): boolean {
    return activeAdapter?.checkIfConversationStarted() ?? false
}

// Fetch the current conversation as the shared ConversationResult type
export async function fetchCurrentConversation(): Promise<ConversationResult> {
    return getActiveAdapter().fetchCurrentConversation()
}

// Fetch raw data for JSON export (platform-native format)
export async function fetchRawData(): Promise<unknown> {
    return getActiveAdapter().fetchRawData()
}

// Get user avatar (for HTML export)
export async function getUserAvatar(): Promise<string> {
    return getActiveAdapter().getUserAvatar()
}
