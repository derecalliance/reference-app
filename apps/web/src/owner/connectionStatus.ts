import type { ParticipantConnectionStatus } from '../types'

export function connectionStatusLabel(status: ParticipantConnectionStatus): string {
  switch (status) {
    case 'paired':    return 'Paired'
    case 'available': return 'Available'
  }
}
