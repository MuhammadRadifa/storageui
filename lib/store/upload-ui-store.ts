"use client"

// Bridges the sidebar's "+ New" menu to the file browser.
// The browser owns the hidden upload <input>s and the FileSystem's new-folder
// dialog (plus the current folder); the sidebar just calls the registered
// openers synchronously within its click handler so the native file picker
// still counts as a user gesture. Not persisted.
import { create } from "zustand"

type UploadUiStore = {
  pickFiles: (() => void) | null
  pickFolder: (() => void) | null
  newFolder: (() => void) | null
  setPickFiles: (fn: (() => void) | null) => void
  setPickFolder: (fn: (() => void) | null) => void
  setNewFolder: (fn: (() => void) | null) => void
}

export const useUploadUiStore = create<UploadUiStore>((set) => ({
  pickFiles: null,
  pickFolder: null,
  newFolder: null,
  setPickFiles: (fn) => set({ pickFiles: fn }),
  setPickFolder: (fn) => set({ pickFolder: fn }),
  setNewFolder: (fn) => set({ newFolder: fn }),
}))
