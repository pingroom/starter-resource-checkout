# PingRoom resource checkout

Keep a local custody ledger for shared equipment. Borrowers B/C tap **Borrow Camera** or **Return Camera** in a dedicated PingRoom room. A collector connected as a different observer account A records one holder per asset and accepts returns only from that holder.

**A tap submits a request. Consult the local report or its operator before taking equipment.** This starter sends no confirmation and cannot enforce physical possession or access. PingRoom's wait API excludes the connecting account's own notifications, so observer A cannot use this connection to check out equipment for themselves.

Requires Node.js 22+. The demo and tests need no account or credentials:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real `@pingroom/sdk` with a local mock transport and a synthetic clock. It shows an accepted borrow, a conflicting borrow, a rejected return by someone else, and a valid return. Temporary demo files are removed afterward. Installation requires npm access; the demo and tests make no network calls.

## Connect a shared room

1. Install [PingRoom](https://pingroom.io/i). Create a dedicated **standard private room** containing observer A and the people who will borrow equipment. Verify that all equipment is available before starting a new ledger.
2. Run `npm run connect`. Approve the displayed browser link as observer A and grant the shared room. Pairing is the only command that creates remote resources; the ledger uses read APIs only. Keep the link private.
3. Run `npm run inspect` to see that room's member UUIDs. Identify borrowers B/C in the app and copy their exact UUIDs into the configuration. Display names help identify people but do not establish identity; use neither a public User ID nor an agent ID.
4. Copy and edit the configuration:

   ```sh
   cp config.example.json config.json
   ```

   Replace the example borrower UUIDs. Keep observer A out of the borrower list. Choose 1–2 assets and 1–8 borrowers; `initiallyAvailable: true` is your declaration that every asset starts available. Use unique asset IDs, names, and action slots. Names use 1–20 printable ASCII characters with no surrounding spaces.
5. In the room's app settings, manually configure the selected quick actions as plain buttons with no input and no acknowledgement requirement. For the example:

   | Slot | Exact label |
   | --- | --- |
   | 1 | Borrow Camera |
   | 2 | Return Camera |
   | 3 | Borrow Tripod |
   | 4 | Return Tripod |

   Labels must be `Borrow <asset name>` and `Return <asset name>`. The starter never creates, edits, or triggers actions. Slots 1–4 fit the standard four-slot room layout.
6. Run `npm start` **before** borrowers send requests. This first run saves the current feed head and records all assets as available. It deliberately skips existing history, including earlier Borrow/Return taps. Wait for that run to finish before using the buttons.

Subsequent `npm start` calls process at most 50 visible notifications in one poll, waiting up to 20 seconds when none are ready. Run it again to drain queued requests. Use a single local scheduler or service to invoke this command serially; overlapping runs fail rather than competing for the ledger. Respect PingRoom's API rate limits and back off after errors.

```sh
npm start          # Read one batch and commit its results
npm run status    # Show the last committed ledger, offline
npm run report    # Also write .checkout/report.json, offline
```

The report shows each asset's recorded holder and every accepted or declined request. `lastCheckedAt` is the local scan time, not a claim that the feed is current. Repeated borrows by the holder and returns of an available asset are recorded as no-ops. A competing borrow is `unavailable`; a return by another person is `not_holder`. There is no timeout or automatic release of a recorded holder.

## Credentials and adaptation

Pairing saves a project-local `.pingroom/credentials.json`. To use an existing observer registration, set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM` in the environment or copy `.env.example` to `.env` and replace its placeholders. Room codes are normalized to uppercase. Defining either variable externally selects that entire pair; blank or partial pairs fail rather than borrowing values from `.env` or saved credentials. Keep the same registration and room for the life of the ledger.

The registration needs `pingroom:rooms:read` and `pingroom:notifications:read`, plus access to the chosen room. `rooms.list` supplies metadata without the notification read-state side effect of `rooms.get`.

Adapt `config.json` before bootstrap, then keep it unchanged. The saved ledger binds the canonical configuration hash, credential hash, room UUID/code, and selected action IDs/labels. A changed borrower list, asset, room, credential, or action identity stops processing. The selected actions are checked before and after each poll. Other actions and their events are ignored.

For another application, import `step` from `src/checkout.js` and consume `localReport`, or read the exported report as a single JSON snapshot. Keep the same lock, validation, and atomic cursor commit. Never map incoming message text or `data` to shell commands or assets; this starter uses only the fixed slot mapping.

## Recovery and limits

- **Observed requests, not a complete reservation system.** Only notifications visible to the observer's current grants, membership, and audience are available. The connecting account's own events are excluded. Bootstrap skips old events; retention, deleted notifications, visibility changes, and late publication can leave gaps. Do not infer physical availability from missing events. UUID order defines the order processed locally, not the order people took equipment.
- **Explicit human provenance.** A row must match the configured room, borrower UUID, and slot, with `trigger_source: "manual"`, `origin_agent: null`, `question: null`, and `is_handoff: false`. Missing provenance fields are ignored. Message text, structured payloads, attachments, and sender display names are never executed or persisted.
- **Keep the room layout fixed.** Notifications include a slot number but no quick-action ID. Before/after checks cannot prove which historical layout produced an event or detect a change that was later undone. There is no server compare-and-swap, distributed reservation, or protection against another independent collector. Use one dedicated room and one authoritative local ledger.
- **Atomic batches.** State, outcomes, holders, and cursor are written together through a private temporary file, file sync, rename, and directory sync. A malformed, duplicate, old, unordered, oversized, or mismatched-cursor batch fails without a new checkpoint. A read or pre-commit write failure preserves the earlier state. If an error occurs after rename, `status` shows whether the new state committed; retry reads that checkpoint. No remote writes need replaying.
- **Bounded local use.** Each ledger retains at most 500 eligible requests, including no-ops and conflicts, in a state file capped at 512 KiB. Every update rewrites it. Feed bodies are capped at 512 KiB; ordinary requests have a five-second deadline, feed reads a 30-second deadline, and each CLI scan a 50-second deadline. Raw bodies must be valid UTF-8. No records are silently pruned. At capacity, stop requests, physically reconcile and return all assets, then archive the complete ledger and deliberately establish a new one. Never delete state to bypass an outstanding holder.
- **Restore rather than guess.** Malformed/null state, scope drift, removed members, and missing actions stop processing. Restore a valid backup and the original configuration/actions; replacing an action creates a new identity and does not restore it. If restoration is impossible, stop using the room, reconcile every asset with the operator, retain the old ledger, and start a separate ledger only when all assets are available. Events missing from the visible feed cannot be reconstructed reliably.
- **Locks and cancellation.** SIGINT/SIGTERM stop requests and avoid committing an unfinished batch. If a crash leaves `.checkout/.lock` or `.pingroom/.lock`, first confirm the prior process is stopped, then remove only that stale lock directory. Never run two machines against the same room ledger or network-shared state.
- **Pairing uncertainty.** `connect` journals an intent before registration/pairing and reuses a saved live pairing link. A lost creation response or expired pairing requires inspecting Connected Agents and resolving/revoking the prior robot before intentionally archiving `.pingroom/pairing.json`. It never blindly creates another registration. A saved credential is not overwritten.

Ignored `.pingroom`, `.checkout`, `.env`, and `config.json` stay local. Files use mode `0600` and directories `0700` on POSIX. On Windows, use an account-private directory with appropriate ACLs. Reports contain borrower identifiers and custody history; handle them as private. Raw API errors and credentials are suppressed in CLI failure output.

Built against the published [PingRoom SDK 0.6.0](https://www.npmjs.com/package/@pingroom/sdk/v/0.6.0), pinned with a lockfile and a 14-day npm minimum release age. Related templates: [room action runner](https://github.com/pingroom/starter-room-action-runner) for a fixed local report command, and [room blueprint](https://github.com/pingroom/starter-room-blueprint) for explicitly applying action configuration. MIT licensed.
