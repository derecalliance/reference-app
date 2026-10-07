# Verification

Checking that helpers still hold the shares they confirmed, and what each verification state means.

## Verify Shares

On the **Secrets** tab, each version card has **Verify Shares**. It sends a challenge to every helper that confirmed that version and is still paired. Each helper answers with a proof that it holds its share, without revealing it.

The dialog, **Verifying Shares · vN**, stays on the version you challenged even if a new version is published while it is open.

## States

| State | Meaning |
| --- | --- |
| **Waiting…** | The challenge went out; no answer yet. |
| **Verified** | The helper proved it holds the share. |
| **Rejected** | The helper answered and refused the challenge. Its memo (or `status N`) follows the label. A helper that no longer holds that version answers this way too (`UNKNOWN_SHARE_VERSION`). |
| **Challenge not sent** | The challenge could not be dispatched to this helper, or the helper is no longer paired. |
| **Verification timed out** | No answer within the protocol timeout. |

A refusal is an answer, so it resolves the row at once. Before SDK 0.0.7 a refusal produced no event and the row spun until the deadline. The challenge is used up either way: checking that helper again takes a new **Verify Shares**.

The summary reads *X of N verified · R rejected · F failed*, and the button changes from **Close** to **Done** when every row has resolved.

On the version card, *Helper Shares* keeps the result: ✓ verified, ✗ *Rejected verification: …*, ○ not yet verified, with *X/N verified* beside the heading.

## When Verify Shares is unavailable

The button is disabled, with the reason beneath it, when:

- a publishing round is still open: *Publishing vN is still in progress — verify once it completes.*
- the version was **restored from a recovered bag**. Restoring keeps no proof material for the helpers' shares, so it cannot be verified. Publish a new version (add or remove a secret) and verify that one.

## A vault acting as a helper

When another vault challenges a share this vault holds, it answers automatically or shows **Incoming Verification Request**, depending on Settings → *Incoming verification requests*. Clicking **Reject** there is what the owner sees as *Rejected*.
