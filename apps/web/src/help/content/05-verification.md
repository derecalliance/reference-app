# Verification

Checking that helpers still hold the shares they confirmed, what each verification state means, whether a version is recoverable, and periodic verification.

## Verify Shares

On the **Secrets** tab, each version card has **Verify Shares**. It sends a challenge to every helper that confirmed that version and is still paired. Each helper answers with a proof that it holds its share, without revealing it.

The dialog, **Verifying Shares · vN**, stays on the version you challenged even if a new version is published while it is open.

## States

| State | Meaning |
| --- | --- |
| **Waiting…** | The challenge went out; no answer yet. |
| **Verified** | The helper proved it holds the share. |
| **Rejected** | The helper answered and refused the challenge. Its memo (or `status N`) follows the label. A helper that no longer holds that version answers this way too (`UNKNOWN_SHARE_VERSION`). |
| **Proof invalid** | The helper answered, but its proof does not match the share this vault sent. Unlike a refusal, an honest helper never answers this way: it points to a damaged or dishonest helper, and a warning says so. A version published before SDK 0.0.9 answers this way too — its shares were committed with the older hashing — so publish a new version and verify that one. |
| **Challenge not sent** | The challenge could not be dispatched to this helper, or the helper is no longer paired. |
| **Verification timed out** | No answer within the protocol timeout. |

A refusal or an invalid proof is an answer, so it resolves the row at once. Before SDK 0.0.7 a refusal produced no event and the row spun until the deadline. The challenge is used up either way: checking that helper again takes a new **Verify Shares**.

The summary reads *X of N verified · R rejected · I invalid proofs · F failed*, and the button changes from **Close** to **Done** when every row has resolved.

On the version card, *Helper Shares* keeps the result: ✓ verified, ✗ *Rejected verification: …*, ✗ *Failed verification: its proof does not match the share sent*, ○ not yet verified, with *X/N verified* beside the heading.

## Recoverable?

From SDK 0.0.9 each verified helper also reports how many subshares it holds for that version, and the version's own threshold. Under *Helper Shares* the card then says:

- *vN recoverable — X of T subshares verified*: the helpers that proved their share hold enough between them;
- *vN not recoverable from verified helpers alone — X of T*: they do not; helpers that did not answer may still hold the rest;
- *vN recoverability unknown*: the version was published before the counts were recorded, so the app does not guess.

## Periodic verification

Vault Settings → **Periodic verification** runs the same challenge automatically, every *amount* minutes, hours or days, on the current version. It runs while the vault is open in a tab; a run is skipped while another operation or verification is in flight, and for a version restored from recovery. Each run is logged in the Console.

## When Verify Shares is unavailable

The button is disabled, with the reason beneath it, when:

- a publishing round is still open: *Publishing vN is still in progress — verify once it completes.*
- the version was **restored from a recovered bag**. Restoring keeps no proof material for the helpers' shares, so it cannot be verified. Publish a new version (add or remove a secret) and verify that one.
- this device's **verification copies of the version were deleted**: the library deletes them for a version helpers were told to stop keeping, and **Clean up…** deletes them on request. The challenge is not sent, and each helper shows as failed with that reason.

A version whose verification copies were cleaned up (see [Protecting secrets](04-protecting-secrets.md#cleaning-up-verification-copies)) answers *no proof* and sends no challenge.

## A vault acting as a helper

When another vault challenges a share this vault holds, it answers automatically or shows **Incoming Verification Request**, depending on Settings → *Incoming verification requests*. Clicking **Reject** there is what the owner sees as *Rejected*.
