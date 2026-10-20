# Thread sync: possible future features

Bifröst currently bridges threads in a deliberately narrow way:

- **What is synced:** messages inside a link (send, edit, delete) for any combination of channel and thread sides, the thread name when both sides are threads, and (for links created by a category link) the Discord channel name onto the Fluxer thread.
- **What is not synced:** everything else. This document lists the features that could be added later, with the reasoning for leaving them out so far and the main thing to watch when implementing them.

## Current limitations

- Only threads whose parent is a **plain text channel** are bridged. Threads under forum, media and announcement channels are ignored.
- Counterpart threads created by auto-sync are created **by the bot**, so their owner on the other platform is the bot, not the user who started the original thread.
- Auto-sync only exists on channel↔channel links and only produces thread↔thread links under them. Channel↔thread links are created manually or by a category link.
- Category links only work in one direction: Discord category → threads in one Fluxer channel. A thread created in the hosting Fluxer channel is not turned into a Discord channel, thread renames are not mirrored back to the channel, and deleting a bridged Discord channel only drops its link (the Fluxer thread stays).
- A channel and every thread link under it share **one webhook per platform** on the (parent) channel. That webhook is deleted together with the last link that uses it, so nothing is left behind, but it also means all bridged traffic for a channel and its threads goes through a single webhook's rate limit.
- A location (channel or thread) is linked at most once; after a link is removed it has to be linked again manually.
- Thread links are not distinguished in the stats command, metrics or the admin dashboard counters (they count as channel links).

## Candidate features

### Mirror archive / unarchive and lock state

*Rationale:* When a thread is archived on one side, the other side stays active and keeps accepting messages that will then unarchive the first side again (both platforms unarchive a thread on new activity).
*Consideration:* Thread update events fire for many unrelated changes, so the handler must diff `archived` and `locked` explicitly and compare against the counterpart's current state to avoid ping-pong, the same way renames are de-duplicated by comparing names today. Locked threads require Manage Threads to unarchive.

### Rename mirroring for channel↔thread links

*Rationale:* Names are only mirrored when both sides are threads, plus channel → thread for links created by a category link. For a manually created channel↔thread link, a thread rename could be mirrored onto the channel name (or the channel rename onto the thread).
*Consideration:* Channel names have stricter rules than thread names (lowercase, no spaces on Discord) and renaming a channel needs Manage Channels, which the bot does not request today. The channel → thread half could reuse the category-link rename path; the thread → channel half has the same echo problem described under category links below. Deliberately left out until there is a clear use case.

### Mirror thread deletion

*Rationale:* Today a deleted thread only drops its link (and the shared webhook if unused) and leaves an orphaned counterpart.
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

### Category links: reverse direction (Fluxer thread → Discord channel)

*Rationale:* A category link only flows from Discord to Fluxer: channels created in the category get a thread, but a thread started in the hosting Fluxer channel gets nothing on Discord. Servers that mostly live on Fluxer would want a new thread there to appear as a channel in the category.
*Consideration:* Creating channels needs Manage Channels, which the bot does not request today, and Discord caps a category at 50 channels, so the handler needs a clear failure mode once the category is full. Threads created by the bridge itself (the ones a category link makes for Discord channels) must be excluded by owner, as thread auto-sync already does, or every bridged channel would get a second, reverse-created channel. Threads are also far cheaper to create than channels, so this should probably be opt-in per category link, and an archived or deleted thread should not leave a dangling channel behind.

### Category links: mirror thread renames back to the channel

*Rationale:* Channel renames are mirrored onto the Fluxer thread, but renaming the thread does nothing on Discord, so the two drift apart as soon as someone renames the thread.
*Consideration:* Discord normalises channel names (lowercase, spaces and most punctuation become hyphens), so a naive mirror renames the thread again with the normalised name and the two sides ping-pong. The handler would have to apply the same normalisation before comparing (treat "Bug Reports" and "bug-reports" as equal), only rename the channel when the normalised names differ, and accept that the thread name ends up normalised too. Renaming a channel needs Manage Channels. Keeping the Discord side authoritative is simpler and is what the one-way mirror does today.

### Category links: mirror channel deletion to thread archival

*Rationale:* Deleting a bridged Discord channel (or moving it out of the category) only removes its link, leaving an active Fluxer thread that looks bridged but no longer is. Archiving the thread would signal that the channel is gone without destroying its history.
*Consideration:* Archival is reversible, so it is safer than deleting the thread, but it still needs Manage Threads and must not fire when the bot merely lost access to the channel. A moved channel is a weaker signal than a deleted one (it may come back, in which case the bridge would create a second thread rather than reuse the archived one), so the two cases probably want different handling. This overlaps with the archive/unarchive mirroring candidate above.

### Category links: per-category naming templates

*Rationale:* Threads are named exactly after the channel, so a Fluxer channel that hosts several categories, or one that also has its own threads, has no way to tell them apart.
*Consideration:* A `category_links.threadNameTemplate` (for example `{category}/{channel}` or a fixed prefix) applied when the thread is created and when a channel rename is mirrored. The rename path compares the thread's current name with the normalised channel name to skip no-op edits, so the comparison must go through the same template, and changing the template later should either re-render every thread name or only apply to new threads. Thread names are limited to 100 characters, so long prefixes need truncation.

### Stats and metrics for thread links

*Rationale:* `stats`, the Prometheus metrics and the admin dashboard report channel and message link counts but not thread links.
*Consideration:* Thread links are rows in `channel_links` with a thread ID set, so a count filtered on `discordThreadId IS NOT NULL OR fluxerThreadId IS NOT NULL` is all that is needed; wiring it into `DbStatsService`, the stats command handlers, `MetricsService` and `AdminStatsResponse` is straightforward. A per-direction counter for thread creations would help spot loops.
