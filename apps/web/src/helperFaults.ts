// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * A failure a provisioned helper simulates — `PUT /api/v1/helpers/{id}/fault`.
 * A property of the helper, seen by every owner it holds shares for.
 */
export type HelperFault = 'none' | 'lost_shares' | 'corrupted_shares' | 'refuses_new_shares' | 'refuses_verification'

export interface HelperFaultOption {
  id: HelperFault
  /** Short, for a select and an owner's status tag. */
  label: string
  /** What owners will see, for a tooltip or helper text. */
  description: string
}

export const HELPER_FAULTS: readonly HelperFaultOption[] = [
  { id: 'none', label: 'Healthy', description: 'Behaves normally.' },
  {
    id: 'lost_shares',
    label: 'Lost shares',
    description:
      'Answers as though its storage were wiped: verification is rejected (unknown share version), recovery is refused, discovery lists nothing.',
  },
  {
    id: 'corrupted_shares',
    label: 'Corrupted shares',
    description:
      'Hands out its shares with one byte flipped: verification reports an invalid proof, and recovery sets its share aside as corrupted.',
  },
  {
    id: 'refuses_new_shares',
    label: 'Refuses new shares',
    description: 'Refuses every share it is asked to store, so a publish counts it as refused.',
  },
  {
    id: 'refuses_verification',
    label: 'Refuses verification',
    description: 'Rejects every verification challenge while still holding its shares; recovery still works.',
  },
]

export function helperFaultOption(fault: HelperFault): HelperFaultOption {
  return HELPER_FAULTS.find(f => f.id === fault) ?? HELPER_FAULTS[0]
}
