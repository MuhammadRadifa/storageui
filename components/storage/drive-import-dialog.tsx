"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  encodeRefHeader,
  REF_HEADER,
  toConnectionRef,
} from "@/lib/storage/connection-ref"
import type { Connection } from "@/lib/storage/connections"
import type { DriveImportEvent } from "@/lib/storage/drive-import"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? ""

type ImportPhase = "idle" | "resolving" | "downloading" | "uploading"

type StreamEvent = DriveImportEvent | { phase: "error"; message: string }

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Import a publicly shared Google Drive file into the current folder.
 * The download + upload run server-side via `/api/import/drive`, which
 * streams progress as server-sent events rendered below as a progress bar.
 */
export function DriveImportDialog({
  open,
  onOpenChangeAction,
  destPath,
  connection,
  onImportedAction,
}: {
  open: boolean
  onOpenChangeAction: (open: boolean) => void
  /** Current folder prefix (`""` is the bucket root). */
  destPath: string
  connection: Connection | null
  onImportedAction: () => void
}) {
  const t = useTranslations("DriveImport")
  const tc = useTranslations("Common")
  const [url, setUrl] = React.useState("")
  const [filename, setFilename] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<ImportPhase>("idle")
  const [loaded, setLoaded] = React.useState(0)
  const [total, setTotal] = React.useState<number | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  const isPending = phase !== "idle"

  React.useEffect(() => {
    if (open) {
      setUrl("")
      setFilename("")
      setError(null)
      setPhase("idle")
      setLoaded(0)
      setTotal(null)
    } else {
      // Closing mid-import cancels the request.
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [open])

  React.useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  const applyEvent = React.useCallback((event: StreamEvent): string | null => {
    if (event.phase === "error") return event.message
    if (event.phase === "done") return null
    if (event.phase === "resolving") {
      setPhase("resolving")
      return null
    }
    setPhase(event.phase)
    setLoaded(event.loaded)
    setTotal(event.total ?? null)
    return null
  }, [])

  const submit = React.useCallback(async () => {
    if (!connection || isPending) return
    if (!url.trim()) {
      setError(t("errorEmpty"))
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setPhase("resolving")
    setLoaded(0)
    setTotal(null)

    try {
      const response = await fetch(`${BASE_PATH}/api/import/drive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [REF_HEADER]: encodeRefHeader(toConnectionRef(connection)),
        },
        body: JSON.stringify({
          driveUrlOrId: url.trim(),
          destPrefix: destPath,
          filenameOverride: filename.trim() || undefined,
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const message = await response.text().catch(() => "")
        throw new Error(message || t("errorGeneric"))
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let importedName: string | null = null
      let failure: string | null = null

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue
            try {
              const event = JSON.parse(
                line.slice("data:".length).trim()
              ) as StreamEvent
              if (event.phase === "done") importedName = event.result.name
              else if (event.phase !== "error") applyEvent(event)
              else failure = applyEvent(event)
            } catch {
              // Skip malformed frames; the stream ends with done/error.
            }
          }
        }
        if (importedName || failure) {
          await reader.cancel().catch(() => {})
          break
        }
      }

      if (failure) throw new Error(failure)
      if (!importedName) throw new Error(t("errorGeneric"))
      toast.success(t("success", { name: importedName }))
      onImportedAction()
      onOpenChangeAction(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : t("errorGeneric"))
      setPhase("idle")
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [
    applyEvent,
    connection,
    destPath,
    filename,
    isPending,
    onImportedAction,
    onOpenChangeAction,
    t,
    url,
  ])

  const percent = total && total > 0 ? Math.round((loaded / total) * 100) : null
  const phaseLabel =
    phase === "downloading"
      ? t("phaseDownloading")
      : phase === "uploading"
        ? t("phaseUploading")
        : t("phaseResolving")
  const progressDetail =
    phase === "idle"
      ? null
      : total && total > 0
        ? t("progressOf", {
            loaded: formatMegabytes(loaded),
            total: formatMegabytes(total),
          })
        : t("progressLoaded", { loaded: formatMegabytes(loaded) })

  return (
    <Dialog open={open} onOpenChange={onOpenChangeAction}>
      {open ? (
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id="drive-import-form"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div className="grid gap-1.5">
                <label
                  htmlFor="drive-import-url"
                  className="text-sm font-medium"
                >
                  {t("urlLabel")}
                </label>
                <Input
                  id="drive-import-url"
                  autoFocus
                  value={url}
                  disabled={isPending}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t("urlPlaceholder")}
                  aria-invalid={error ? true : undefined}
                />
              </div>
              <div className="grid gap-1.5">
                <label
                  htmlFor="drive-import-name"
                  className="text-sm font-medium"
                >
                  {t("nameLabel")}
                </label>
                <Input
                  id="drive-import-name"
                  value={filename}
                  disabled={isPending}
                  onChange={(event) => setFilename(event.target.value)}
                  placeholder={t("namePlaceholder")}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("destination", { folder: destPath || "/" })}
              </p>
              <p className="text-xs text-muted-foreground">{t("publicNote")}</p>
              {isPending ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{phaseLabel}</span>
                    <span className="shrink-0 tabular-nums">
                      {percent !== null ? `${percent}% · ` : null}
                      {progressDetail}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    {percent !== null ? (
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-200"
                        style={{ width: `${percent}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                    )}
                  </div>
                </div>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChangeAction(false)}
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              form="drive-import-form"
              loading={isPending}
              disabled={!url.trim()}
            >
              {isPending ? t("importing") : t("import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
