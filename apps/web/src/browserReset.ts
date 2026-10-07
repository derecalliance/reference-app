// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { clearAllLocalData } from './localData'
import { postTabMessage } from './tabSync'

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') // e.g. "/reference-app"

/** What a reset needs from the vault manager. */
export interface Haltable {
  /** Stop every vault and resolve once none can write again. */
  haltAll(): Promise<void>
}

/**
 * Wipe this browser's DeRec data, in every tab, and start again.
 *
 * Storage is shared by every tab of the origin but each tab runs its own
 * vaults, so wiping it from one tab used to leave the others running on top of
 * nothing — writing keys back into the emptied storage and failing their next
 * command with an error about something else entirely. So the other tabs are
 * told first, and every tab, this one included, stops its vaults and waits for
 * their last write before clearing. Each tab clears after its *own* last write,
 * which is what guarantees nothing is left behind, whichever finishes first.
 */
export async function resetBrowserData(manager: Haltable): Promise<void> {
  postTabMessage({ kind: 'reset-started' })
  await stopClearAndReload(manager)
}

/** Another tab started a reset: do this tab's half of it. */
export async function followReset(manager: Haltable): Promise<void> {
  await stopClearAndReload(manager)
}

async function stopClearAndReload(manager: Haltable): Promise<void> {
  try {
    await manager.haltAll()
  } finally {
    clearAllLocalData()
    // Protocol instances and wizard state live outside localStorage, so a
    // reload is what actually guarantees a clean slate.
    window.location.replace(`${BASE_PATH}/`)
  }
}
