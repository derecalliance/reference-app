// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

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
