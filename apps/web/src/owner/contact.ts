import type { ContactMessage } from '@derec-alliance/web'

import type { ContactMessageDto } from '../api'
import { contactMessageToDto, dtoToContactMessage } from '../contactDto'

/** QR/clipboard payload — same wire form as the signaling DTO. */
export function serializeContact(contact: ContactMessage): string {
  return JSON.stringify(contactMessageToDto(contact))
}

export function deserializeContact(payload: string): ContactMessage {
  return dtoToContactMessage(JSON.parse(payload) as ContactMessageDto)
}
