-- The failure a provisioned helper simulates (`HelperFault`), beside the
-- offline switch in `disabled_helpers`. Same portability rules as 0001. A row
-- names the fault; absence means the helper behaves normally, so the share
-- store's per-read lookup finds no row on the hot path.
CREATE TABLE helper_faults (
    actor_id TEXT NOT NULL,
    fault TEXT NOT NULL,
    PRIMARY KEY (actor_id)
);
