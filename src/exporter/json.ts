import JSZip from 'jszip'
import { processConversation } from '../api'
import i18n from '../i18n'
import { checkIfConversationStarted, fetchCurrentConversation, fetchRawData } from '../platforms/service'
import { convertToOoba, convertToTavern } from '../utils/conversion'
import { buildZipFileName, downloadFile, getFileNameWithFormat, normalizeProjectName } from '../utils/download'
import type { ApiConversationWithId } from '../api'
import type { ExportMeta } from '../ui/SettingContext'

export async function exportToJson(fileNameFormat: string) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    // fetchRawData returns the platform-native format (ChatGPT API shape, or Claude API shape, etc.)
    const rawData = await fetchRawData()
    const conversation = await fetchCurrentConversation()

    const fileName = getFileNameWithFormat(fileNameFormat, 'json', {
        title: conversation.title,
        chatId: conversation.id,
    })
    const content = JSON.stringify(rawData)
    downloadFile(fileName, 'application/json', content)

    return true
}

export async function exportToTavern(fileNameFormat: string) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    const conversation = await fetchCurrentConversation()
    const fileName = getFileNameWithFormat(`${fileNameFormat}.tavern`, 'jsonl', {
        title: conversation.title,
        chatId: conversation.id,
    })
    const content = convertToTavern(conversation)
    downloadFile(fileName, 'application/json-lines', content)

    return true
}

export async function exportToOoba(fileNameFormat: string) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    const conversation = await fetchCurrentConversation()
    const fileName = getFileNameWithFormat(`${fileNameFormat}.ooba`, 'json', {
        title: conversation.title,
        chatId: conversation.id,
    })
    const content = convertToOoba(conversation)
    downloadFile(fileName, 'application/json', content)

    return true
}

export async function exportAllToOfficialJson(_fileNameFormat: string, apiConversations: ApiConversationWithId[], _metaList?: ExportMeta[], projectName?: string) {
    const content = conversationToJson(apiConversations)
    const baseName = projectName
        ? `chatgpt-export-project-${normalizeProjectName(projectName)}`
        : 'chatgpt-export'
    downloadFile(`${baseName}.json`, 'application/json', content)

    return true
}

export async function exportAllToJson(fileNameFormat: string, apiConversations: ApiConversationWithId[], _metaList?: ExportMeta[], projectName?: string) {
    const zip = new JSZip()
    const filenameMap = new Map<string, number>()
    const conversations = apiConversations.map(x => ({
        conversation: processConversation(x),
        rawConversation: x,
    }))
    conversations.forEach(({ conversation, rawConversation }) => {
        let fileName = getFileNameWithFormat(fileNameFormat, 'json', {
            title: conversation.title,
            chatId: conversation.id,
            createTime: conversation.createTime,
            updateTime: conversation.updateTime,
        })
        if (filenameMap.has(fileName)) {
            const count = filenameMap.get(fileName) ?? 1
            filenameMap.set(fileName, count + 1)
            fileName = `${fileName.slice(0, -5)} (${count}).json`
        }
        else {
            filenameMap.set(fileName, 1)
        }
        const content = conversationToJson(rawConversation)
        zip.file(fileName, content)
    })

    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
            level: 9,
        },
    })
    downloadFile(buildZipFileName('json', projectName), 'application/zip', blob)

    return true
}

function conversationToJson(conversation: ApiConversationWithId | ApiConversationWithId[]) {
    return JSON.stringify(conversation)
}
