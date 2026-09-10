import type { FilesClient } from "@/lib/storage/files-client"

/**
 * Import a publicly shared Google Drive file into the active storage
 * connection (v1: single files only, no folders, no Google Docs export).
 *
 * This module is isomorphic: it must stay free of `"use server"`,
 * `"server-only"`, and any `files-sdk` *value* import (types only), mirroring
 * `file-operations.ts`. Only the `id` extracted from the user's input ever
 * reaches the network — the raw input is never fetched — so a crafted link
 * cannot turn the server into a proxy for an arbitrary host (SSRF).
 */

export type DriveImportResult = {
  key: string
  name: string
  size?: number
  contentType?: string
}

/**
 * Progress events emitted while an import runs. `total` is omitted when the
 * size is unknown (Drive sent no `content-length`, or the storage adapter
 * reports stream progress without a length).
 */
export type DriveImportEvent =
  | { phase: "resolving" }
  | { phase: "downloading"; loaded: number; total?: number }
  | { phase: "uploading"; loaded: number; total?: number }
  | { phase: "done"; result: DriveImportResult }

const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/

/** Default ceiling for one import; override with `DRIVE_IMPORT_MAX_BYTES`. */
export const DEFAULT_DRIVE_IMPORT_MAX_BYTES = 500 * 1024 * 1024

/**
 * Extract a Drive file id from the common public-link shapes, or from a bare
 * id pasted on its own. Returns `null` when nothing looks like a file id.
 *
 * Accepted: `/file/d/<id>/…`, `open?id=<id>`, `uc?id=<id>…`,
 * `docs.google.com/…/d/<id>/…`, and a bare `<id>`.
 */
export function parseDriveFileId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (DRIVE_ID_PATTERN.test(trimmed)) return trimmed

  let url: URL
  try {
    // Bare ids with no scheme fail here and are handled below; anything else
    // must parse as a URL on a Google host.
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (
    url.hostname !== "drive.google.com" &&
    !url.hostname.endsWith(".drive.google.com") &&
    url.hostname !== "docs.google.com" &&
    !url.hostname.endsWith(".docs.google.com") &&
    url.hostname !== "drive.usercontent.google.com"
  ) {
    return null
  }

  const fromPath = /\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1]
  if (fromPath) return fromPath

  for (const key of ["id", "ids"]) {
    const candidate = url.searchParams.get(key)
    if (candidate && DRIVE_ID_PATTERN.test(candidate)) return candidate
  }

  return null
}

/** Server-side download URL for a public file (`confirm=t` skips the virus-scan interstitial). */
export function buildDriveDownloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`
}

/** Remove path separators, control characters, and trailing dots/spaces. */
export function sanitizeDriveFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[/\\]+/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/[. ]+$/g, "")
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return cleaned.slice(0, 255)
}

function extensionFor(contentType: string | null): string {
  if (!contentType) return ""
  const type = contentType.split(";")[0].trim().toLowerCase()
  const common: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/json": ".json",
    "application/xml": ".xml",
    "audio/mpeg": ".mp3",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
  }
  return common[type] ?? ""
}

/** Prefer `filename*=` (RFC 5987), then `filename=`, from a Content-Disposition value. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)?.[1]
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended.trim().replace(/^"|"$/g, ""))
      if (decoded) return decoded
    } catch {
      // Fall through to the plain filename below.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim()
  return plain || null
}

async function keyTaken(files: FilesClient, key: string): Promise<boolean> {
  try {
    await files.head(key)
    return true
  } catch {
    return false
  }
}

/** Append ` (n)` before the extension until the key is free. */
async function uniqueKey(
  files: FilesClient,
  prefix: string,
  name: string
): Promise<string> {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  let candidate = `${prefix}${name}`
  for (let copy = 1; await keyTaken(files, candidate); copy += 1) {
    candidate = `${prefix}${stem} (${copy})${extension}`
  }
  return candidate
}

function maxImportBytes(): number {
  const raw = process.env.DRIVE_IMPORT_MAX_BYTES
  const parsed = raw ? Number(raw) : Number.NaN
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  return DEFAULT_DRIVE_IMPORT_MAX_BYTES
}

/**
 * Download a public Drive file server-side and store it under `destPrefix`.
 * Streams the response body straight into storage (S3-family adapters
 * multipart-upload unknown-length streams natively); the WebDAV adapter has
 * no streaming upload, so it takes the buffered path. Progress is reported
 * through `onEvent` when provided (used by the SSE route).
 */
export async function importDriveFile(
  files: FilesClient,
  driveUrlOrId: string,
  destPrefix: string,
  filenameOverride?: string,
  onEvent?: (event: DriveImportEvent) => void
): Promise<DriveImportResult> {
  onEvent?.({ phase: "resolving" })
  const fileId = parseDriveFileId(driveUrlOrId)
  if (!fileId) {
    throw new Error(
      "That doesn’t look like a Google Drive file link. Paste a public “Anyone with the link” file link or its file ID."
    )
  }

  const prefix = destPrefix.trim().replace(/^\/+/, "")
  const normalizedPrefix =
    !prefix || prefix.endsWith("/") ? prefix : `${prefix}/`

  let response: Response
  try {
    response = await fetch(buildDriveDownloadUrl(fileId), {
      headers: {
        // Drive sometimes answers a bare fetch with 403; a browser UA avoids it.
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      redirect: "follow",
    })
  } catch {
    throw new Error("Could not reach Google Drive. Check your connection.")
  }

  if (response.status === 404) {
    throw new Error(
      "Google Drive returned 404. Make sure the link is shared as “Anyone with the link”."
    )
  }
  if (response.status === 403) {
    throw new Error(
      "Google Drive refused the download. Make sure the link is shared as “Anyone with the link”."
    )
  }
  if (!response.ok || !response.body) {
    throw new Error(
      `Google Drive download failed (${response.status}). Try again later.`
    )
  }

  const contentType =
    response.headers.get("content-type")?.split(";")[0].trim() ||
    "application/octet-stream"
  // Native Google Docs/Sheets/Slides ids serve an HTML viewer page, not the
  // document — exporting those needs the Drive API and is out of scope for v1.
  if (contentType === "text/html") {
    throw new Error(
      "This looks like a Google Docs, Sheets, or Slides file. Exporting those isn’t supported — only directly uploaded files (PDFs, images, videos, …) can be imported."
    )
  }

  const declaredSize = response.headers.get("content-length")
  const size = declaredSize ? Number(declaredSize) : Number.NaN
  const limit = maxImportBytes()
  if (Number.isSafeInteger(size) && size > limit) {
    await response.body.cancel().catch(() => {})
    throw new Error(
      `This file is too large to import (${(size / 1024 / 1024).toFixed(0)} MB; limit ${(limit / 1024 / 1024).toFixed(0)} MB).`
    )
  }

  const fallbackName = `drive-${fileId}${extensionFor(contentType)}`
  const detectedName =
    filenameFromDisposition(response.headers.get("content-disposition")) ??
    fallbackName
  const override = filenameOverride?.trim()
  const name = sanitizeDriveFileName(
    override || detectedName,
    sanitizeDriveFileName(fallbackName, `drive-${fileId}`)
  )
  const key = await uniqueKey(files, normalizedPrefix, name)

  // Count Drive bytes as they arrive so the download leg can report progress.
  // Events are throttled to one per 128 KiB (plus the final chunk) to keep
  // the SSE stream small.
  let downloaded = 0
  let lastEmitted = 0
  const emitDownloading = (done: boolean) => {
    if (!done && downloaded - lastEmitted < 128 * 1024) return
    lastEmitted = downloaded
    onEvent?.({
      phase: "downloading",
      loaded: downloaded,
      ...(Number.isSafeInteger(size) ? { total: size } : {}),
    })
  }
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        downloaded += chunk.byteLength
        emitDownloading(false)
        controller.enqueue(chunk)
      },
      flush() {
        emitDownloading(true)
      },
    })
  )

  // Duck-typed like `file-operations.ts`: this module stays free of sdk value
  // imports, and the adapter's own `upload` applies the root for WebDAV.
  const adapter = (files as { adapter?: { name?: string } }).adapter
  try {
    if (adapter?.name === "webdav") {
      const bytes = new Uint8Array(await new Response(counted).arrayBuffer())
      if (bytes.byteLength > limit) {
        throw new Error(
          `This file is too large to import (limit ${(limit / 1024 / 1024).toFixed(0)} MB).`
        )
      }
      onEvent?.({
        phase: "uploading",
        loaded: 0,
        total: bytes.byteLength,
      })
      await files.upload(key, bytes, { contentType })
      onEvent?.({
        phase: "uploading",
        loaded: bytes.byteLength,
        total: bytes.byteLength,
      })
    } else {
      onEvent?.({
        phase: "uploading",
        loaded: 0,
        ...(Number.isSafeInteger(size) ? { total: size } : {}),
      })
      await files.upload(key, counted, {
        contentType,
        onProgress: ({ loaded }) => {
          onEvent?.({
            phase: "uploading",
            loaded,
            ...(Number.isSafeInteger(size) ? { total: size } : {}),
          })
        },
      })
    }
  } catch (error) {
    if (error instanceof Error && /too large to import/.test(error.message)) {
      throw error
    }
    throw new Error(
      error instanceof Error
        ? `Import failed: ${error.message}`
        : "Import failed."
    )
  }

  const result = {
    key,
    name,
    size: Number.isSafeInteger(size) ? size : undefined,
    contentType,
  }
  onEvent?.({ phase: "done", result })
  return result
}
