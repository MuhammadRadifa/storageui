import { isRequestAuthorized } from "@/lib/auth/core"
import { REF_HEADER, type ConnectionRef } from "@/lib/storage/connection-ref"
import {
  assertConnectionWritable,
  resolveFiles,
} from "@/lib/storage/connections-server"
import {
  importDriveFile,
  type DriveImportEvent,
} from "@/lib/storage/drive-import"
import { normalizeError } from "@/lib/storage/file-operations"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ClientEvent = DriveImportEvent | { phase: "error"; message: string }

/**
 * Import a public Google Drive file, streaming progress as server-sent
 * events (`resolving → downloading → uploading → done`, or `error`).
 *
 * Server actions can't push progress, so this route exists alongside
 * `importDriveFileAction`. The connection rides a header (never the URL) and
 * the import parameters ride a small JSON body. Like `/api/upload` this route
 * checks the session itself instead of leaning on the global proxy.
 */
export async function POST(request: Request) {
  if (!(await isRequestAuthorized(request))) {
    return new Response("Unauthorized.", { status: 401 })
  }

  const refHeader = request.headers.get(REF_HEADER)
  if (!refHeader) {
    return new Response("Invalid request.", { status: 400 })
  }

  let ref: ConnectionRef
  try {
    ref = JSON.parse(
      Buffer.from(refHeader, "base64").toString("utf8")
    ) as ConnectionRef
  } catch {
    return new Response("Invalid request.", { status: 400 })
  }

  let body: {
    driveUrlOrId?: string
    destPrefix?: string
    filenameOverride?: string
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response("Invalid request.", { status: 400 })
  }

  const driveUrlOrId = body.driveUrlOrId?.trim()
  if (!driveUrlOrId) {
    return new Response("Paste a Google Drive link first.", { status: 400 })
  }

  let files
  try {
    files = resolveFiles(ref)
  } catch (error) {
    return new Response(normalizeError(error).message, { status: 404 })
  }

  try {
    assertConnectionWritable(ref)
  } catch (error) {
    return new Response(normalizeError(error).message, { status: 403 })
  }

  const destPrefix = body.destPrefix ?? ""
  const filenameOverride = body.filenameOverride?.trim() || undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ClientEvent) => {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
        )
      }
      try {
        await importDriveFile(
          files,
          driveUrlOrId,
          destPrefix,
          filenameOverride,
          send
        )
      } catch (error) {
        send({ phase: "error", message: normalizeError(error).message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
