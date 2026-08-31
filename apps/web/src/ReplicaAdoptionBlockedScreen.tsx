import { Alert, AlertTitle, Container, Paper, Stack, Typography } from '@mui/material'
import { AppMuiTheme } from './AppMuiTheme'
import type { RestoreFailure } from './replicaFlows'

/**
 * Terminal screen for a wipe-and-adopt that erased this device's vault and then
 * failed.
 *
 * `adoptReplicaSecret` clears the namespace before it can reject, so a rejection
 * leaves the page holding a protocol instance bound to stores that no longer
 * exist. Continuing to render the owner page would let the user add secrets to,
 * and poll for, a vault whose channels are gone — so the page stops here
 * instead.
 *
 * There is deliberately no retry and no "continue anyway": `restore`'s
 * preconditions reject *before* touching a store, which means a second attempt
 * would run against half-adopted state. The library's own words are reproduced
 * verbatim, `channel_ids` included, because they are the only evidence of what
 * the device is now in.
 *
 * The block is persisted (see `replicaAdoptionBlock.ts`), so reloading does not
 * escape it — the persisted owner envelope survives the wipe and would
 * otherwise put the user back in front of a roster of helpers whose stores are
 * gone. Only the app-wide "Reset browser data" action clears it.
 */

export interface ReplicaAdoptionBlockedScreenProps {
  failure: RestoreFailure
  /** Whose vault this device was holding before the wipe. */
  ownerName: string
}

export function ReplicaAdoptionBlockedScreen({
  failure,
  ownerName,
}: ReplicaAdoptionBlockedScreenProps) {
  return (
    <AppMuiTheme>
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'left' }}>
          <Stack spacing={2.5}>
            <Stack spacing={0.5}>
              <Typography variant="h5" component="h1">
                This device is no longer usable
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {ownerName}’s vault on this device was erased to make room for a mirrored
                copy, and installing that copy did not complete.
              </Typography>
            </Stack>

            <Alert severity="error">
              <AlertTitle>The restore was rejected</AlertTitle>
              <Typography
                variant="body2"
                component="p"
                sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
              >
                {failure.text}
              </Typography>
            </Alert>

            <Typography variant="body2">
              {failure.wipeDidNotTake
                ? 'This rejection can only happen when the erase did not take effect, so this device is in a state no retry can improve.'
                : 'The erase completed but the mirrored vault was not installed, so this device now holds nothing.'}{' '}
              Nothing will be retried, and no further protocol activity runs here: polling
              has stopped and secrets cannot be added. Reloading will not change that — this
              screen is recorded in the browser and comes back with it.
            </Typography>

            <Typography variant="body2" color="text.secondary">
              Inspect this device’s storage before doing anything else. Your helpers still
              hold the shares they were given, and the device that sent the mirrored copy
              is unaffected. When you are done, “Reset browser data” erases this browser’s
              DeRec state — including this block — and starts over.
            </Typography>
          </Stack>
        </Paper>
      </Container>
    </AppMuiTheme>
  )
}
