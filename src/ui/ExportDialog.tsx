import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useTranslation } from 'react-i18next'
import { archiveConversation, deleteConversation, fetchAllConversations, fetchConversation, fetchProjects } from '../api'
import { exportAllToHtml } from '../exporter/html'
import { exportAllToJson, exportAllToOfficialJson } from '../exporter/json'
import { exportAllToMarkdown } from '../exporter/markdown'
import { useColorScheme } from '../hooks/useColorScheme'
import { RequestQueue } from '../utils/queue'
import { CheckBox } from './CheckBox'
import { IconCross, IconLoading, IconUpload } from './Icons'
import { useSettingContext } from './SettingContext'
import type { ApiConversationItem, ApiConversationWithId, ApiProjectInfo } from '../api'
import type { FC } from '../type'
import type { ChangeEvent } from 'preact/compat'

interface ProjectSelectProps {
    projects: ApiProjectInfo[]
    selected: ApiProjectInfo | null | undefined
    setSelected: (selected: ApiProjectInfo | null) => void
    disabled: boolean
}

const ProjectSelect: FC<ProjectSelectProps> = ({ projects, selected, setSelected, disabled }) => {
    const { t } = useTranslation()

    const value = selected === undefined ? '__unselected__' : (selected?.id || '')

    return (
        <div className="flex items-center text-gray-600 dark:text-gray-300 flex justify-between mb-3">
            {t('Select Project')}
            <select
                disabled={disabled}
                className="Select"
                value={value}
                onChange={(e) => {
                    const projectId = e.currentTarget.value
                    const project = projects.find(p => p.id === projectId)
                    setSelected(project || null)
                }}
            >
                {selected === undefined && (
                    <option value="__unselected__" disabled>{t('Select Project')}...</option>
                )}
                <option value="">{t('(no project)')}</option>
                {projects.map(project => (
                    <option key={project.id} value={project.id}>{project.display.name}</option>
                ))}
            </select>
        </div>
    )
}

const EXPORT_LIMIT = 100

interface ConversationSelectProps {
    conversations: ApiConversationItem[]
    selected: ApiConversationItem[]
    setSelected: (selected: ApiConversationItem[]) => void
    disabled: boolean
    loading: boolean
    error: string
}

const ConversationSelect: FC<ConversationSelectProps> = ({
    conversations,
    selected,
    setSelected,
    disabled,
    loading,
    error,
}) => {
    const { t } = useTranslation()
    const [query, setQuery] = useState('')
    const lastClickedIndex = useRef<number>(-1)

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return conversations
        return conversations.filter(c => c.title.toLowerCase().includes(q))
    }, [conversations, query])

    const atCap = selected.length >= EXPORT_LIMIT
    const allFilteredSelected = filtered.length > 0
        && filtered.slice(0, EXPORT_LIMIT).every(c => selected.some(x => x.id === c.id))

    return (
        <>
            <input
                type="search"
                className="SelectSearch"
                placeholder={t('Search')}
                value={query}
                onInput={(e) => {
                    lastClickedIndex.current = -1
                    setQuery(e.currentTarget.value)
                }}
            />
            <div className="SelectToolbar">
                <CheckBox
                    label={t('Select All')}
                    disabled={disabled}
                    checked={allFilteredSelected}
                    onCheckedChange={(checked) => {
                        lastClickedIndex.current = -1
                        setSelected(checked ? filtered.slice(0, EXPORT_LIMIT) : [])
                    }}
                />
                <div className="flex items-center gap-2 ml-auto">
                    {loading && conversations.length > 0 && (
                        <span className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                            <IconLoading className="w-3 h-3" />
                            {t('Loading')}... ({conversations.length})
                        </span>
                    )}
                    <button
                        className="Button neutral"
                        disabled={disabled || conversations.length === 0}
                        onClick={() => setSelected(conversations.slice(0, EXPORT_LIMIT))}
                    >
                        {t('Last 100')}
                    </button>
                    <span className={`text-sm font-medium tabular-nums ${atCap ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                        {selected.length}/{EXPORT_LIMIT}
                    </span>
                </div>
            </div>
            <ul className="SelectList">
                {loading && conversations.length === 0 && <li className="SelectItem">{t('Loading')}...</li>}
                {error && <li className="SelectItem">{t('Error')}: {error}</li>}
                {filtered.map((c, index) => {
                    const isSelected = selected.some(x => x.id === c.id)
                    const itemDisabled = disabled || (atCap && !isSelected)
                    return (
                        <li
                            className="SelectItem"
                            key={c.id}
                            onClickCapture={(e: MouseEvent) => {
                                if (itemDisabled) return
                                if (e.shiftKey && lastClickedIndex.current !== -1) {
                                    e.preventDefault()
                                    const start = Math.min(lastClickedIndex.current, index)
                                    const end = Math.max(lastClickedIndex.current, index)
                                    const rangeItems = filtered.slice(start, end + 1)
                                    const newSelected = [...selected]
                                    for (const item of rangeItems) {
                                        if (!newSelected.some(x => x.id === item.id)) {
                                            if (newSelected.length >= EXPORT_LIMIT) break
                                            newSelected.push(item)
                                        }
                                    }
                                    setSelected(newSelected)
                                    return
                                }
                                lastClickedIndex.current = index
                            }}
                        >
                            <CheckBox
                                label={c.title}
                                disabled={itemDisabled}
                                checked={isSelected}
                                onCheckedChange={(checked) => {
                                    if (checked && atCap) return
                                    setSelected(checked
                                        ? [...selected, c]
                                        : selected.filter(x => x.id !== c.id),
                                    )
                                }}
                            />
                        </li>
                    )
                })}
                {!loading && !error && filtered.length === 0 && conversations.length > 0 && (
                    <li className="SelectItem text-gray-400 dark:text-gray-500">{t('No results')}</li>
                )}
            </ul>
        </>
    )
}

type ExportSource = 'API' | 'Local'

interface DialogContentProps {
    format: string
}

const DialogContent: FC<DialogContentProps> = ({ format }) => {
    const { t } = useTranslation()
    const { enableMeta, exportMetaList, exportAllLimit } = useSettingContext()
    const metaList = useMemo(() => enableMeta ? exportMetaList : [], [enableMeta, exportMetaList])

    const exportAllOptions = useMemo(() => [
        { label: 'Markdown', callback: exportAllToMarkdown },
        { label: 'HTML', callback: exportAllToHtml },
        { label: 'JSON', callback: exportAllToOfficialJson },
        { label: 'JSON (ZIP)', callback: exportAllToJson },
    ], [])

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [exportSource, setExportSource] = useState<ExportSource>('API')
    const [apiConversations, setApiConversations] = useState<ApiConversationItem[]>([])
    const [localConversations, setLocalConversations] = useState<ApiConversationWithId[]>([])
    const conversations = exportSource === 'API' ? apiConversations : localConversations
    const [projects, setProjects] = useState<ApiProjectInfo[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [processing, setProcessing] = useState(false)
    const [selectedProject, setSelectedProject] = useState<ApiProjectInfo | null | undefined>(undefined)

    const [selected, setSelected] = useState<ApiConversationItem[]>([])
    const [exportType, setExportType] = useState(exportAllOptions[0].label)
    const disabled = processing || !!error || selected.length === 0

    const requestQueue = useMemo(() => new RequestQueue<ApiConversationWithId>(200, 1600), [])
    const archiveQueue = useMemo(() => new RequestQueue<boolean>(200, 1600), [])
    const deleteQueue = useMemo(() => new RequestQueue<boolean>(200, 1600), [])
    const [progress, setProgress] = useState({
        total: 0,
        completed: 0,
        currentName: '',
        currentStatus: '',
    })

    const onUpload = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const file = (e.target as HTMLInputElement)?.files?.[0]
        if (!file) return

        const fileReader = new FileReader()
        fileReader.onload = () => {
            let data: unknown
            try {
                data = JSON.parse(fileReader.result as string)
            }
            catch {
                alert(t('Invalid File Format'))
                return
            }
            if (!Array.isArray(data)) {
                alert(t('Invalid File Format'))
                return
            }
            setSelected([])
            setExportSource('Local')
            setLocalConversations(data)
        }
        fileReader.readAsText(file)
    }, [t, setExportSource, setLocalConversations])

    useEffect(() => {
        const off = requestQueue.on('progress', (progress) => {
            setProcessing(true)
            setProgress(progress)
        })

        return () => off()
    }, [requestQueue])

    useEffect(() => {
        const off = archiveQueue.on('progress', (progress) => {
            setProcessing(true)
            setProgress(progress)
        })

        return () => off()
    }, [archiveQueue])

    useEffect(() => {
        const off = deleteQueue.on('progress', (progress) => {
            setProcessing(true)
            setProgress(progress)
        })

        return () => off()
    }, [deleteQueue])

    useEffect(() => {
        const off = requestQueue.on('done', (results) => {
            setProcessing(false)
            const callback = exportAllOptions.find(o => o.label === exportType)?.callback
            if (callback) callback(format, results, metaList, selectedProject?.display.name)
        })
        return () => off()
    }, [requestQueue, exportAllOptions, exportType, format, metaList, selectedProject])

    useEffect(() => {
        const off = archiveQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(apiConversations.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Archived Message'))
        })
        return () => off()
    }, [archiveQueue, apiConversations, selected, t])

    useEffect(() => {
        const off = deleteQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(apiConversations.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Deleted Message'))
        })
        return () => off()
    }, [deleteQueue, apiConversations, selected, t])

    const exportAllFromApi = useCallback(() => {
        if (disabled) return

        requestQueue.clear()

        selected.forEach(({ id, title }) => {
            requestQueue.add({
                name: title,
                request: () => fetchConversation(id, exportType !== 'JSON'),
            })
        })

        requestQueue.start()
    }, [disabled, selected, requestQueue, exportType])

    const exportAllFromLocal = useCallback(() => {
        if (disabled) return

        const results = localConversations.filter(c => selected.some(s => s.id === c.id))
        const callback = exportAllOptions.find(o => o.label === exportType)?.callback
        if (callback) callback(format, results, metaList, selectedProject?.display.name)
    }, [
        disabled,
        selected,
        localConversations,
        exportAllOptions,
        exportType,
        format,
        metaList,
        selectedProject,
    ])

    const exportAll = useMemo(() => {
        return exportSource === 'API' ? exportAllFromApi : exportAllFromLocal
    }, [exportSource, exportAllFromApi, exportAllFromLocal])

    const deleteAll = useCallback(() => {
        if (disabled) return

        const result = confirm(t('Conversation Delete Alert'))
        if (!result) return

        deleteQueue.clear()

        selected.forEach(({ id, title }) => {
            deleteQueue.add({
                name: title,
                request: () => deleteConversation(id),
            })
        })

        deleteQueue.start()
    }, [disabled, selected, deleteQueue, t])

    const archiveAll = useCallback(() => {
        if (disabled) return

        const result = confirm(t('Conversation Archive Alert'))
        if (!result) return

        archiveQueue.clear()

        selected.forEach(({ id, title }) => {
            archiveQueue.add({
                name: title,
                request: () => archiveConversation(id),
            })
        })

        archiveQueue.start()
    }, [disabled, selected, archiveQueue, t])

    useEffect(() => {
        fetchProjects()
            .then(setProjects)
            .catch(err => setError(err.toString()))
    }, [])

    useEffect(() => {
        if (selectedProject === undefined) return
        setSelected([])
        setApiConversations([])
        setLoading(true)
        fetchAllConversations(
            selectedProject?.id ?? null,
            exportAllLimit,
            batch => setApiConversations(prev => [...prev, ...batch]),
        )
            .catch((err) => {
                console.error('Error fetching conversations:', err)
                setError(err.message || 'Failed to load conversations')
            })
            .finally(() => setLoading(false))
    }, [selectedProject, exportAllLimit])

    return (
        <>
            <Dialog.Title className="DialogTitle">{t('Export Dialog Title')}</Dialog.Title>
            <div className="flex items-center text-gray-600 dark:text-gray-300 flex justify-between border-b-[1px] pb-3 mb-3 dark:border-gray-700">
                {t('Export from official export file')} (conversations.json)&nbsp;
                {exportSource === 'API' && (
                    <button className="btn relative btn-neutral" onClick={() => fileInputRef.current?.click()}>
                        <IconUpload className="w-4 h-4" />
                    </button>
                )}
            </div>
            <input
                type="file"
                accept="application/json"
                className="hidden"
                ref={fileInputRef}
                onChange={onUpload}
            />
            {exportSource === 'API' && (
                <div className="flex items-center text-gray-600 dark:text-gray-300 flex justify-between mb-3">
                    {t('Export from API')}
                </div>
            )}
            <ProjectSelect projects={projects} selected={selectedProject} setSelected={setSelectedProject} disabled={processing} />
            {selectedProject === undefined
                ? (
                    <div className="SelectList flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                        {t('Select a source to load conversations')}
                    </div>
                    )
                : (
                    <ConversationSelect
                        key={selectedProject?.id ?? 'no-project'}
                        conversations={conversations}
                        selected={selected}
                        setSelected={setSelected}
                        disabled={processing}
                        loading={loading}
                        error={error}
                    />
                    )}
            <div className="flex mt-6" style={{ justifyContent: 'space-between' }}>
                <select className="Select" disabled={processing} value={exportType} onChange={e => setExportType(e.currentTarget.value)}>
                    {exportAllOptions.map(({ label }) => (
                        <option key={t(label)} value={label}>{label}</option>
                    ))}
                </select>
                <div className="flex flex-grow"></div>
                <button className="Button red" disabled={disabled || exportSource === 'Local'} onClick={archiveAll}>
                    {t('Archive')}
                </button>
                <button className="Button red ml-4" disabled={disabled || exportSource === 'Local'} onClick={deleteAll}>
                    {t('Delete')}
                </button>
                <button className="Button green ml-4" disabled={disabled} onClick={exportAll}>
                    {t('Export')}
                </button>
            </div>
            {processing && (
                <>
                    <div className="mt-2 mb-1 justify-between flex">
                        <span className="truncate mr-8">{progress.currentName}</span>
                        <span>{`${progress.completed}/${progress.total}`}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4 dark:bg-gray-700">
                        <div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${Math.round((progress.completed / (progress.total || 1)) * 100)}%` }} />
                    </div>
                </>
            )}
            <Dialog.Close asChild>
                <button className="IconButton CloseButton" aria-label="Close">
                    <IconCross />
                </button>
            </Dialog.Close>
        </>
    )
}

interface ExportDialogProps {
    format: string
    open: boolean
    onOpenChange: (value: boolean) => void
}

export const ExportDialog: FC<ExportDialogProps> = ({ format, open, onOpenChange, children }) => {
    const isDark = useColorScheme() === 'dark'
    return (
        <Dialog.Root
            open={open}
            onOpenChange={onOpenChange}
        >
            <Dialog.Trigger asChild>
                {children}
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="DialogOverlay" />
                <Dialog.Content className={`DialogContent${isDark ? ' dark' : ''}`}>
                    <div className={isDark ? 'dark' : undefined}>
                        {open && <DialogContent format={format} />}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
