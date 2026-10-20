# Thread sync: possible future features

Bifröst currently bridges threads in a deliberately narrow way:

- **What is synced:** messages inside a bridged thread pair (send, edit, delete) and the thread name.
- **What is not synced:** everything else. This document lists the features that could be added later, with the reasoning for leaving them out so far and the main thing to watch when implementing them.

## Current limitations

- Only threads whose parent is a **plain text channel** are bridged. Threads under forum, media and announcement channels are ignored.
- Counterpart threads created by auto-sync are created **by the bot**, so their owner on the other platform is the bot, not the user who started the original thread.
- A thread is linked at most once; there is no re-linking after a thread link is removed other than linking it again manually.
- Thread links are not shown in the stats command, metrics or the admin dashboard counters.

## Candidate features

### Mirror archive / unarchive and lock state

*Rationale:* When a thread is archived on one side, the other side stays active and keeps accepting messages that will then unarchive the first side again (both platforms unarchive a thread on new activity).
*Consideration:* Thread update events fire for many unrelated changes, so the handler must diff `archived` and `locked` explicitly and compare against the counterpart's current state to avoid ping-pong, the same way renames are de-duplicated by comparing names today. Locked threads require Manage Threads to unarchive.

### Mirror thread deletion

*Rationale:* Today a deleted thread only drops its link and leaves an orphaned counterpart.
*Consideration:* Deletion is destructive and irreversible; it should probably be opt-in per channel link (like the auto-sync toggle) and must distinguish a deleted thread from a thread the bot merely lost access to.

### Auto-archive duration and slowmode updates

*Rationale:* The auto-archive duration is copied when the counterpart is created, but later changes to it, and slowmode (`rateLimitPerUser`), are not mirrored.
*Consideration:* Both platforms use the same minute values (60 / 1440 / 4320 / 10080) for auto-archive, so this is a direct copy; slowmode must be clamped to 0–21600 and needs Manage Channels / Manage Threads.

### Forum and media channels

*Rationale:* Forum posts are threads, so most of the machinery already applies.
*Consideration:* Posts need a starter message and optional applied tags; webhooks can create a post with `thread_name` (and `applied_tags`) instead of `thread_id`. Tags would need a name-based mapping between the two forums, and the dashboard currently only lists text channels as linkable.

### Announcement channels and announcement threads

*Rationale:* Announcement channels are text-like and support threads on both platforms.
*Consideration:* The linking code checks for the plain text channel class on both SDKs; it would have to accept announcement channels and create `AnnouncementThread` typed threads on Fluxer. Crossposting/follower webhooks must not be bridged twice.

### Private threads and member sync

*Rationale:* Private threads are invisible unless the bot is a member, and membership changes (`join`, `leave`, `invitable`) are not mirrored.
*Consideration:* The bot would need to be added to private threads on both sides, and member sync requires a user-identity mapping between Discord and Fluxer that Bifröst does not have. Mirroring `invitable` is simple; mirroring members is not.

### Autolink existing threads by name

*Rationale:* `autolink` matches channels by name similarity; the same could pair already-existing active threads under a linked channel when auto-sync is switched on.
*Consideration:* Thread names are far less unique than channel names, so this should be a preview-and-confirm flow (like `autolink`) rather than automatic, and should consider creation time as a tiebreaker.

### Backfill thread history on link

*Rationale:* Threads that are linked manually (or lazily by the first message) start with an empty counterpart.
*Consideration:* Backfilling means replaying messages through the webhook with the original author names and timestamps lost (webhook messages carry no original timestamp). It also interacts with rate limits (Fluxer: 5 messages per 2 s per webhook) and with the message-link table growing quickly.

### Pins and reactions inside threads

*Rationale:* Neither pins nor reactions are bridged anywhere in Bifröst today; threads would inherit whatever channel-level support is added.
*Consideration:* Reactions need an emoji mapping (custom emojis must match by name, as for message content) and a way to attribute reactions without impersonation; pins need Manage Messages on both sides.

### Thread starter message editing

*Rationale:* When a thread is created from a bridged message, the starter message of the counterpart thread is the webhook copy. Edits to the original already propagate through the normal edit path, but the starter message shown at the top of a Fluxer thread is a separate `ThreadStarterMessage` system message that may not refresh.
*Consideration:* Verify how each platform renders the starter message after the referenced message is edited or deleted; a deleted starter leaves a dangling thread on both sides.

### Per-guild default for the auto-sync toggle

*Rationale:* Servers with many channels have to switch the toggle on per channel link.
*Consideration:* A `guild_links.autoSyncThreadsDefault` column applied at channel-link creation time (and an `autolink` option) would cover this without changing per-link semantics.

### Stats and metrics for thread links

*Rationale:* `stats`, the Prometheus metrics and the admin dashboard report channel and message link counts but not thread links.
*Consideration:* `ThreadLinkRepository.getThreadLinksCount()` already exists; wiring it into `DbStatsService`, the stats command handlers, `MetricsService` and `AdminStatsResponse` is straightforward. A per-direction counter for thread creations would help spot loops.
