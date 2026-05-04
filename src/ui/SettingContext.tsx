import { createContext, useContext } from 'preact/compat'
import { useCallback } from 'preact/hooks'
import {
    KEY_COPY_TEXT_INCLUDE_ATTACHMENTS,
    KEY_EXPORT_ALL_LIMIT,
    KEY_FILENAME_FORMAT,
    KEY_META_ENABLED,
    KEY_META_LIST,
    KEY_TIMESTAMP_24H,
    KEY_TIMESTAMP_ENABLED,
    KEY_TIMESTAMP_HTML,
    KEY_TIMESTAMP_MARKDOWN,
    KEY_USER_CONTENT_LIMIT,
} from '../constants'
import { useGMStorage } from '../hooks/useGMStorage'
import type { FC } from 'preact/compat'

const defaultFormat = '{platform}-{title}'
const defaultExportAllLimit = 1000
const defaultUserContentLimit = 0 // 0 = no limit

export interface ExportMeta {
    name: string
    value: string
}

const defaultExportMetaList: ExportMeta[] = [
    { name: 'title', value: '{title}' },
    { name: 'source', value: '{source}' },
]

const SettingContext = createContext({
    format: defaultFormat,
    setFormat: (_: string) => {},

    enableTimestamp: false,
    setEnableTimestamp: (_: boolean) => {},
    timeStamp24H: false,
    setTimeStamp24H: (_: boolean) => {},
    enableTimestampHTML: false,
    setEnableTimestampHTML: (_: boolean) => {},
    enableTimestampMarkdown: false,
    setEnableTimestampMarkdown: (_: boolean) => {},

    enableMeta: false,
    setEnableMeta: (_: boolean) => {},
    exportMetaList: defaultExportMetaList,
    setExportMetaList: (_: ExportMeta[]) => {},
    exportAllLimit: defaultExportAllLimit,
    setExportAllLimit: (_: number) => {},

    copyTextIncludeAttachments: false,
    setCopyTextIncludeAttachments: (_: boolean) => {},

    userContentLimit: defaultUserContentLimit,
    setUserContentLimit: (_: number) => {},

    resetDefault: () => {},
})

export const SettingProvider: FC = ({ children }) => {
    const [format, setFormat] = useGMStorage(KEY_FILENAME_FORMAT, defaultFormat)

    const [enableTimestamp, setEnableTimestamp] = useGMStorage(KEY_TIMESTAMP_ENABLED, false)
    const [timeStamp24H, setTimeStamp24H] = useGMStorage(KEY_TIMESTAMP_24H, false)
    const [enableTimestampHTML, setEnableTimestampHTML] = useGMStorage(KEY_TIMESTAMP_HTML, false)
    const [enableTimestampMarkdown, setEnableTimestampMarkdown] = useGMStorage(KEY_TIMESTAMP_MARKDOWN, false)

    const [enableMeta, setEnableMeta] = useGMStorage(KEY_META_ENABLED, false)

    const [exportMetaList, setExportMetaList] = useGMStorage(KEY_META_LIST, defaultExportMetaList)
    const [exportAllLimit, setExportAllLimit] = useGMStorage(KEY_EXPORT_ALL_LIMIT, defaultExportAllLimit)

    const [copyTextIncludeAttachments, setCopyTextIncludeAttachments] = useGMStorage(KEY_COPY_TEXT_INCLUDE_ATTACHMENTS, false)

    const [userContentLimit, setUserContentLimit] = useGMStorage(KEY_USER_CONTENT_LIMIT, defaultUserContentLimit)

    const resetDefault = useCallback(() => {
        setFormat(defaultFormat)
        setEnableTimestamp(false)
        setEnableMeta(false)
        setExportMetaList(defaultExportMetaList)
        setExportAllLimit(defaultExportAllLimit)
        setCopyTextIncludeAttachments(false)
        setUserContentLimit(defaultUserContentLimit)
    }, [
        setFormat,
        setEnableTimestamp,
        setEnableMeta,
        setExportMetaList,
        setExportAllLimit,
        setCopyTextIncludeAttachments,
        setUserContentLimit,
    ])

    return (
        <SettingContext.Provider
            value={{
                format,
                setFormat,

                enableTimestamp,
                setEnableTimestamp,
                timeStamp24H,
                setTimeStamp24H,
                enableTimestampHTML,
                setEnableTimestampHTML,
                enableTimestampMarkdown,
                setEnableTimestampMarkdown,

                enableMeta,
                setEnableMeta,
                exportMetaList,
                setExportMetaList,

                exportAllLimit,
                setExportAllLimit,

                copyTextIncludeAttachments,
                setCopyTextIncludeAttachments,

                userContentLimit,
                setUserContentLimit,

                resetDefault,
            }}
        >
            {children}
        </SettingContext.Provider>
    )
}

export const useSettingContext = () => useContext(SettingContext)
