// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { helperFaultOption, type HelperFault } from '../helperFaults'

/**
 * The failure a provisioned helper is set to simulate, on an owner's row: the
 * node's choice, so what follows — rejected or invalid verifications, refused
 * shares — reads as the test it is rather than as a real fault.
 */
export function HelperFaultTag({ fault }: { fault: Exclude<HelperFault, 'none'> }) {
  const option = helperFaultOption(fault)
  return (
    <span className="status-tag fault" title={`Simulated on the node: ${option.description}`}>
      Simulated: {option.label}
    </span>
  )
}
