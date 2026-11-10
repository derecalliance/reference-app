// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { RecoveredSecret, RecoveredSecretReplica } from '../types'

/**
 * The members of a recovered secret's replica group this device could join: the
 * destinations. The source is the device that published the recovered version
 * — normally the one that was lost, which is why recovery was needed.
 */
export function joinableMembers(recovered: RecoveredSecret): RecoveredSecretReplica[] {
  return (recovered.snapshot.replicas?.members ?? []).filter(m => m.role === 'Destination')
}
