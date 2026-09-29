import { faker } from '@faker-js/faker'

/**
 * A plausible human name for a newly provisioned participant.
 *
 * The backend takes candidate names on `POST /helpers/ensure` and uses only as
 * many as it has to create, so these are suggestions rather than assignments.
 * Real-looking names beat `helper-3` here: the whole point of the pool is to
 * stand in for people holding shares, and a fingerprint dialog comparing codes
 * with "Kaia Gorczany" reads like the thing it is simulating.
 */
export function randomParticipantName(): string {
  return `${faker.person.firstName()} ${faker.person.lastName()}`
}
