import * as React from "react"
import {
  prepareFileTreeInput,
  type FileTreeSortComparator,
  type FileTreeSortEntry,
} from "@pierre/trees"
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react"
import { useTranslations } from "next-intl"

import { usePreferencesStore } from "@/lib/store/preferences-store"
import { cn } from "@/lib/utils"
import {
  compareEntriesBySort,
  DEFAULT_SORT,
  directoryPathsOf,
  escapeXmlAttribute,
  filePreviewUrls,
  FOLDER_GLYPH_DATA_URL,
  formatByteSize,
  formatTimestamp,
  normalizeFolderPath,
} from "@/components/explorer/internals"
import type {
  FileSystemEntry,
  FileSystemIndex,
  FileSystemSortKey,
  FileSystemSortState,
  FileSystemViewProps,
} from "@/components/explorer/types"
import {
  FileSystemEmptyState,
  isTypeAheadKey,
  useEntryTypeAhead,
} from "@/components/explorer/views/shared"
import {
  AppIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
} from "@/components/foundations/icons"

export function FileSystemListColumnHeader({
  className,
  label,
  onClickAction,
  sort,
  sortKey,
}: {
  className?: string
  label: string
  onClickAction: (key: FileSystemSortKey) => void
  sort: FileSystemSortState
  sortKey: FileSystemSortKey
}) {
  const isActive = sort.key === sortKey

  return (
    <button
      type="button"
      onClick={() => onClickAction(sortKey)}
      className={cn(
        "flex items-center gap-0.5 rounded-sm py-0.5 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        isActive && "text-foreground",
        className
      )}
    >
      {label}
      {isActive ? (
        <AppIcon
          icon={sort.direction === "asc" ? ArrowUp01Icon : ArrowDown01Icon}
          className="size-3 shrink-0"
        />
      ) : null}
    </button>
  )
}

export function FileSystemListView({
  currentPath,
  fileFilter,
  index,
  onOpen,
  onSelect,
  onSelectMany,
  onSortColumnClick,
  searchQuery,
  selectedPath,
  sort,
  treeExpansionRef,
}: FileSystemViewProps) {
  const t = useTranslations("Explorer")
  // Filters narrow the path list handed to the tree; the search query stays
  // out of it so the tree's own search session (with match highlighting)
  // keeps handling it without remounts per keystroke.
  const relativePaths = React.useMemo(() => {
    const paths = new Set<string>()

    for (const [path, file] of index.files) {
      if (currentPath === "" || path.startsWith(currentPath)) {
        const relativePath = path.slice(currentPath.length)

        if (!relativePath) continue
        if (fileFilter && !fileFilter(file)) continue
        paths.add(relativePath)
      }
    }

    // Object stores can return a folder prefix before any descendants have
    // been loaded. Add those explicit directory paths so the tree does not
    // depend on inferring every folder from an already-present file path.
    // With filters active, matching file paths infer only their ancestors.
    if (!fileFilter) {
      for (const path of index.folders.keys()) {
        if (path === currentPath) continue
        if (currentPath && !path.startsWith(currentPath)) continue

        const relativePath = path.slice(currentPath.length)

        if (relativePath) paths.add(relativePath)
      }
    }

    return [...paths].sort()
  }, [currentPath, fileFilter, index])

  if (relativePaths.length === 0) {
    return (
      <FileSystemEmptyState
        label={fileFilter ? t("emptyFiltered") : t("emptyFolder")}
      />
    )
  }

  return (
    <div className="flex size-full flex-col">
      {/* Paddings match the tree's row geometry: name text starts 46px in
          (16px tree padding + 30px icon lane), metadata ends 24px from the
          right (16px tree padding + 8px decoration inset). */}
      <div className="mb-1.5 flex shrink-0 items-center border-b py-1 pr-6 pl-11.5 text-xs font-medium text-muted-foreground">
        <FileSystemListColumnHeader
          className="flex-1 justify-start"
          label={t("sortName")}
          onClickAction={onSortColumnClick}
          sort={sort}
          sortKey="name"
        />
        <FileSystemListColumnHeader
          className="w-44 justify-start"
          label={t("sortUpdated")}
          onClickAction={onSortColumnClick}
          sort={sort}
          sortKey="updatedAt"
        />
        <FileSystemListColumnHeader
          className="w-20 justify-start"
          label={t("sortSize")}
          onClickAction={onSortColumnClick}
          sort={sort}
          sortKey="size"
        />
      </div>
      {/* Keyed by folder only: navigation remounts the tree, while filter,
          sort, and manifest changes update the mounted model in place so
          folder disclosure state survives them. */}
      <FileSystemPierreTree
        key={currentPath}
        currentPath={currentPath}
        hasActiveFilters={fileFilter !== null}
        index={index}
        initialSelectedPath={
          selectedPath?.startsWith(currentPath)
            ? selectedPath.slice(currentPath.length).replace(/\/$/, "")
            : null
        }
        onOpen={onOpen}
        onSelect={onSelect}
        onSelectMany={onSelectMany}
        relativePaths={relativePaths}
        searchQuery={searchQuery}
        sort={sort}
        treeExpansionRef={treeExpansionRef}
      />
    </div>
  )
}

// Embedded thumbnail symbols grow the sprite injected into the tree's shadow
// DOM (data-URL covers can run hundreds of KB each); past this many the
// remaining files fall back to the built-in file-type icons alone.
export const TREE_THUMBNAIL_SPRITE_LIMIT = 400

export function FileSystemPierreTree({
  currentPath,
  hasActiveFilters,
  index,
  initialSelectedPath,
  onOpen,
  onSelect,
  onSelectMany,
  relativePaths,
  searchQuery,
  sort,
  treeExpansionRef,
}: {
  currentPath: string
  hasActiveFilters: boolean
  index: FileSystemIndex
  initialSelectedPath: string | null
  onOpen: (entry: FileSystemEntry) => void
  onSelect: (entry: FileSystemEntry | null) => void
  onSelectMany: (entries: FileSystemEntry[]) => void
  relativePaths: string[]
  searchQuery: string
  sort: FileSystemSortState
  treeExpansionRef: React.RefObject<Map<string, readonly string[]>>
}) {
  const timeFormat = usePreferencesStore((state) => state.timeFormat)
  // The tree's comparator receives whole paths, not siblings, so it walks
  // the shared segments and applies the active sort at the first level the
  // two paths diverge — keeping directories first per level, the tree's
  // default convention. Lookups go through the index maps, which are stable
  // across search keystrokes.
  const indexFiles = index.files
  const indexFolders = index.folders
  const sortComparator = React.useMemo<
    "default" | FileTreeSortComparator
  >(() => {
    if (
      sort.key === DEFAULT_SORT.key &&
      sort.direction === DEFAULT_SORT.direction
    ) {
      return "default"
    }

    const entryAtDepth = (sortEntry: FileTreeSortEntry, depth: number) => {
      const isDirectory =
        depth < sortEntry.segments.length - 1 || sortEntry.isDirectory
      const absolutePath = `${currentPath}${sortEntry.segments
        .slice(0, depth + 1)
        .join("/")}${isDirectory ? "/" : ""}`

      return isDirectory
        ? indexFolders.get(absolutePath)
        : indexFiles.get(absolutePath)
    }

    return (left, right) => {
      const sharedDepth = Math.min(left.segments.length, right.segments.length)

      for (let depth = 0; depth < sharedDepth; depth += 1) {
        if (left.segments[depth] === right.segments[depth]) continue

        const leftIsDirectory =
          depth < left.segments.length - 1 || left.isDirectory
        const rightIsDirectory =
          depth < right.segments.length - 1 || right.isDirectory

        if (leftIsDirectory !== rightIsDirectory) {
          return leftIsDirectory ? -1 : 1
        }

        const leftEntry = entryAtDepth(left, depth)
        const rightEntry = entryAtDepth(right, depth)

        if (leftEntry && rightEntry) {
          return compareEntriesBySort(leftEntry, rightEntry, sort)
        }
        return left.segments[depth] < right.segments[depth] ? -1 : 1
      }
      return left.segments.length - right.segments.length
    }
  }, [currentPath, indexFiles, indexFolders, sort])
  const preparedInput = React.useMemo(
    () => prepareFileTreeInput(relativePaths, { sort: sortComparator }),
    [relativePaths, sortComparator]
  )
  // Inject per-file thumbnails into the tree's shadow DOM as sprite symbols
  // wrapping an <image>, remapped onto rows by file basename. Files without
  // a thumbnail resolve through the built-in complete icon set instead — the
  // same colored file-type icons the other views use. The chevron is
  // remapped to a Tabler-style arrow so it matches the rest of the component;
  // the tree's rotation CSS keys off data-icon-name, which remapping keeps.
  const icons = React.useMemo(() => {
    const byFileName: Record<string, { name: string; viewBox: string }> = {}
    const symbols: string[] = [
      `<symbol id="file-system-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6l6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></symbol>`,
    ]

    let thumbnailCount = 0

    for (const relativePath of relativePaths) {
      if (thumbnailCount >= TREE_THUMBNAIL_SPRITE_LIMIT) break

      const file = index.files.get(`${currentPath}${relativePath}`)
      const coverUrl = file ? filePreviewUrls(file)[0] : undefined

      if (!file || !coverUrl) continue

      const baseName = file.name.toLowerCase()

      if (byFileName[baseName]) continue

      const symbolId = `file-system-thumbnail-${symbols.length}`

      symbols.push(
        `<symbol id="${symbolId}" viewBox="0 0 16 16"><clipPath id="${symbolId}-clip"><rect width="16" height="16" rx="2.5"/></clipPath><image href="${escapeXmlAttribute(coverUrl)}" width="16" height="16" preserveAspectRatio="xMidYMid slice" clip-path="url(#${symbolId}-clip)"/></symbol>`
      )
      byFileName[baseName] = { name: symbolId, viewBox: "0 0 16 16" }
      thumbnailCount += 1
    }

    return {
      byFileName,
      colored: true,
      remap: {
        "file-tree-icon-chevron": {
          name: "file-system-chevron",
          viewBox: "0 0 24 24",
        },
      },
      set: "complete" as const,
      spriteSheet: `<svg data-icon-sprite aria-hidden="true" width="0" height="0">${symbols.join("")}</svg>`,
    }
  }, [currentPath, index, relativePaths])
  const { model } = useFileTree({
    flattenEmptyDirectories: false,
    icons,
    initialExpansion: "closed",
    // Remounts (folder changes, manifest updates) keep the active filter.
    initialSearchQuery: searchQuery || null,
    initialSelectedPaths: initialSelectedPath ? [initialSelectedPath] : [],
    itemHeight: 28,
    overscan: 12,
    preparedInput,
    renderRowDecoration: ({ row }) => {
      const entry =
        row.kind === "file"
          ? index.files.get(`${currentPath}${row.path}`)
          : index.folders.get(normalizeFolderPath(`${currentPath}${row.path}`))

      if (!entry) return null

      // The decoration lane renders one <span title>; CSS splits it into
      // aligned Date Modified (::before from title) and Size columns.
      const dateColumn =
        formatTimestamp(entry.updatedAt ?? entry.createdAt, timeFormat) ?? "—"

      if (entry.kind === "folder") {
        const childCount = index.children.get(entry.path)?.length

        return {
          text:
            childCount === undefined
              ? "—"
              : `${childCount} ${childCount === 1 ? "item" : "items"}`,
          title: dateColumn,
        }
      }

      return { text: formatByteSize(entry.size) ?? "—", title: dateColumn }
    },
    unsafeCSS: `
      button[data-type='item']:not([data-item-selected]):hover {
        background: color-mix(in oklab, var(--color-accent) 50%, transparent);
      }
      button[data-type='item'][data-item-selected] {
        background: var(--color-primary);
        color: var(--color-primary-foreground);
        /* The primary surface is the opposite of the mode's background, so
           the row's light-dark() icon colors resolve against the opposite
           scheme — light-palette icons on the light pill in dark mode and
           vice versa. */
        color-scheme: var(--fs-selected-color-scheme, normal);
      }
      button[data-type='item'][data-item-selected] *:not([data-icon-token]):not([data-icon-token] *),
      button[data-type='item'][data-item-selected] [data-item-section]::before {
        color: var(--color-primary-foreground) !important;
      }
      [data-item-section='decoration'] > span {
        display: grid;
        grid-template-columns: 11rem 5rem;
        white-space: nowrap;
        /* The size cell is the span's anonymous text item, so alignment
           rides on text-align: the span's right applies to it while the
           date cell (::before) overrides back to left. */
        text-align: right;
      }
      [data-item-section='decoration'] > span::before {
        content: attr(title);
        text-align: left;
      }
      button[data-type='item'][data-item-type='folder'] [data-item-section='content'] {
        display: flex;
        align-items: center;
        min-width: 0;
      }
      button[data-type='item'][data-item-type='folder'] [data-item-section='content']::before {
        content: "";
        flex: none;
        width: 18px;
        height: 14px;
        margin-right: 4px;
        background: url("${FOLDER_GLYPH_DATA_URL}") center / contain no-repeat;
      }
    `,
    onSelectionChange: (selectedPaths) => {
      // The tree owns Cmd/Shift selection and reports the full set; mirror it
      // into the central model (order preserved so the last is the anchor).
      const entries = selectedPaths
        .map((relativePath) => {
          const absolutePath = `${currentPath}${relativePath}`
          return (
            index.files.get(absolutePath) ??
            index.folders.get(normalizeFolderPath(absolutePath)) ??
            null
          )
        })
        .filter((entry): entry is FileSystemEntry => entry !== null)

      onSelectMany(entries)
    },
  })

  // Thumbnails can resolve after mount (e.g. generated client-side); push
  // sprite updates into the existing model instead of remounting the tree.
  React.useEffect(() => {
    model.setIcons(icons)
  }, [icons, model])

  // The folders currently expanded in the mounted model, derived from the
  // given path list (the model knows the rows; the paths name the
  // directories to ask about).
  const collectExpandedDirectories = React.useCallback(
    (paths: readonly string[]) => {
      const expandedPaths: string[] = []

      for (const directoryPath of directoryPathsOf(paths)) {
        const item =
          model.getItem(directoryPath) ?? model.getItem(`${directoryPath}/`)

        if (item && "isExpanded" in item && item.isExpanded()) {
          expandedPaths.push(directoryPath)
        }
      }
      return expandedPaths
    },
    [model]
  )

  // Opens every given folder on the mounted model (no-ops on the already
  // open ones).
  const expandDirectories = React.useCallback(
    (directoryPaths: Iterable<string>) => {
      for (const directoryPath of directoryPaths) {
        const item =
          model.getItem(directoryPath) ?? model.getItem(`${directoryPath}/`)

        if (item && "isExpanded" in item && !item.isExpanded()) {
          item.toggle()
        }
      }
    },
    [model]
  )

  // Sort and filter changes swap the prepared input in place — remounting
  // would reset every folder's disclosure. The folders expanded in the
  // outgoing path list, the selection, and the active search query are
  // captured first and handed back to the reset.
  const appliedPreparedInputRef = React.useRef(preparedInput)
  // Filter bookkeeping: the latest prop (for unmount-time decisions), the
  // state at the last applied reset (for transition detection), and the
  // disclosure to restore once the filters clear.
  const hasActiveFiltersRef = React.useRef(hasActiveFilters)
  const filteredAtLastResetRef = React.useRef(hasActiveFilters)
  const preFilterExpansionRef = React.useRef<readonly string[] | null>(null)

  React.useEffect(() => {
    hasActiveFiltersRef.current = hasActiveFilters
  })

  React.useEffect(() => {
    const previousPreparedInput = appliedPreparedInputRef.current

    if (previousPreparedInput === preparedInput) return
    appliedPreparedInputRef.current = preparedInput

    const wasFiltered = filteredAtLastResetRef.current

    filteredAtLastResetRef.current = hasActiveFilters

    // Filters reveal their matches the way the search session does: every
    // folder on the way to a match opens. The disclosure from just before
    // filtering is kept aside and comes back when the filters clear.
    let expandedPaths: readonly string[]

    if (hasActiveFilters) {
      if (!wasFiltered) {
        preFilterExpansionRef.current = collectExpandedDirectories(
          previousPreparedInput.paths
        )
      }
      expandedPaths = [...directoryPathsOf(preparedInput.paths)]
    } else if (wasFiltered) {
      expandedPaths = preFilterExpansionRef.current ?? []
      preFilterExpansionRef.current = null
    } else {
      expandedPaths = collectExpandedDirectories(previousPreparedInput.paths)
    }

    const searchValue = model.getSearchValue()

    // Must use the options-only overload: passing `paths` too makes resetPaths
    // re-prepare them with the comparator the model was CREATED with and
    // reject the differently-ordered prepared input.
    model.resetPaths({
      initialExpandedPaths: expandedPaths,
      preparedInput,
    })
    if (searchValue) model.setSearch(searchValue)
  }, [collectExpandedDirectories, hasActiveFilters, model, preparedInput])

  // View switches and navigation unmount the tree; remember which folders
  // were left expanded and reopen them on the next mount of this folder
  // (before paint, so the restored disclosure never flashes closed). While
  // filters are active their matches are revealed instead, and the
  // remembered disclosure is the pre-filter one.
  React.useLayoutEffect(() => {
    const expansionStore = treeExpansionRef.current
    const savedExpansion = expansionStore.get(currentPath) ?? []

    if (hasActiveFiltersRef.current) {
      preFilterExpansionRef.current = savedExpansion
      expandDirectories(directoryPathsOf(appliedPreparedInputRef.current.paths))
    } else {
      expandDirectories(savedExpansion)
    }

    return () => {
      expansionStore.set(
        currentPath,
        hasActiveFiltersRef.current
          ? (preFilterExpansionRef.current ?? [])
          : collectExpandedDirectories(appliedPreparedInputRef.current.paths)
      )
    }
  }, [
    collectExpandedDirectories,
    currentPath,
    expandDirectories,
    treeExpansionRef,
  ])

  // The toolbar search drives the tree's own search session, which filters
  // rows with hide-non-matches semantics and highlights the matched text.
  React.useEffect(() => {
    model.setSearch(searchQuery || null)
  }, [model, searchQuery])

  // The tree's arrow keys move focus and only select on click/Enter; mirror
  // focus into the (single) selection so arrowing selects like Finder. Shift
  // ranges keep the focused row selected, so they pass through untouched.
  React.useEffect(() => {
    let lastFocusedPath = model.getFocusedPath()

    return model.subscribe(() => {
      const focusedPath = model.getFocusedPath()

      if (focusedPath === lastFocusedPath) return

      lastFocusedPath = focusedPath

      if (!focusedPath) return

      const item = model.getItem(focusedPath)

      if (!item || item.isSelected()) return

      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect()
      }
      item.select()
    })
  }, [model])

  // Rows live in the tree's shadow DOM; composedPath surfaces the row
  // element behind a pointer or keyboard event so it can resolve to a
  // manifest entry.
  const entryFromEvent = (event: React.SyntheticEvent) => {
    for (const target of event.nativeEvent.composedPath()) {
      if (!(target instanceof HTMLElement)) continue

      const relativePath = target.dataset?.itemPath

      if (!relativePath) continue

      const absolutePath = `${currentPath}${relativePath}`

      return (
        index.files.get(absolutePath) ??
        index.folders.get(normalizeFolderPath(absolutePath)) ??
        null
      )
    }
    return null
  }

  // The tree exposes rows by relative path; directory ids may or may not
  // carry the trailing slash depending on the call site.
  const resolveTreeItem = (relativePath: string) =>
    model.getItem(relativePath) ??
    model.getItem(
      relativePath.endsWith("/")
        ? relativePath.slice(0, -1)
        : `${relativePath}/`
    )

  // The tree's rows in display order — folders first per level, recursing
  // only into expanded folders — so type-ahead cycles exactly what's on
  // screen. Virtualization keeps this off the DOM; the index and the item
  // handles carry the same information.
  const collectVisibleEntries = () => {
    const visibleEntries: FileSystemEntry[] = []
    const walk = (folderPath: string) => {
      const children = index.children.get(folderPath) ?? []

      for (const child of children) {
        if (child.kind !== "folder") continue

        const item = resolveTreeItem(child.path.slice(currentPath.length))

        if (!item) continue
        visibleEntries.push(child)
        if ("isExpanded" in item && item.isExpanded()) walk(child.path)
      }
      for (const child of children) {
        if (child.kind === "file") visibleEntries.push(child)
      }
    }

    walk(currentPath)
    return visibleEntries
  }

  const typeAhead = useEntryTypeAhead()

  return (
    <PierreFileTree
      model={model}
      className="block min-h-0 flex-1"
      // Finder semantics: double-clicking a folder navigates into it and
      // double-clicking a file opens it; a single click still only toggles
      // the folder's disclosure.
      onDoubleClick={(event) => {
        const entry = entryFromEvent(event)

        if (entry) onOpen(entry)
      }}
      // Enter mirrors the other views: navigate into the focused folder or
      // open the focused file. Printable keys run the shared type-ahead
      // over the visible rows.
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const entry = entryFromEvent(event)

          if (entry) {
            event.preventDefault()
            onOpen(entry)
          }
          return
        }

        if (!isTypeAheadKey(event)) return

        const visibleEntries = collectVisibleEntries()
        const focusedPath = model.getFocusedPath()?.replace(/\/$/, "") ?? null
        const focusedIndex = visibleEntries.findIndex(
          (entry) =>
            entry.path.slice(currentPath.length).replace(/\/$/, "") ===
            focusedPath
        )
        const match = typeAhead(event, visibleEntries, focusedIndex)

        if (!match) return

        const item = resolveTreeItem(match.path.slice(currentPath.length))

        if (item) {
          model.scrollToPath(item.getPath())
          item.focus()
        }
      }}
      style={
        {
          "--trees-bg-override": "transparent",
          "--trees-border-color-override": "var(--color-border)",
          "--trees-fg-override": "var(--color-foreground)",
          // Selection is communicated by its background, without an
          // additional focus ring around the active row.
          "--trees-focus-ring-width-override": "0px",
          "--trees-selected-bg-override": "var(--color-primary)",
          "--trees-selected-focused-border-color-override": "transparent",
        } as React.CSSProperties
      }
    />
  )
}
