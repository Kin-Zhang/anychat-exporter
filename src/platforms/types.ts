import type { ConversationResult } from '../api'

// Every platform adapter must implement this interface
export interface PlatformAdapter {
    // Human-readable platform name (e.g. 'ChatGPT', 'Claude', 'Gemini')
    readonly platformName: string

    // List of hostnames this adapter handles
    readonly hostnames: string[]

    // Check if a conversation is currently open and can be exported
    checkIfConversationStarted(): boolean

    // Fetch and process the current conversation into the shared format
    fetchCurrentConversation(): Promise<ConversationResult>

    // Fetch raw data (used for JSON export — returns platform-native format)
    fetchRawData(): Promise<unknown>

    // Whether this platform supports "Export All" conversations
    supportsExportAll(): boolean

    // Inject the export button into the page sidebar/nav
    injectUI(getContainer: () => HTMLElement): void

    // Get the user's avatar as a base64 data URL (for HTML export)
    getUserAvatar(): Promise<string>
}
