<p align="center">
  <img height="100px" width="100px" src="./.github/readme-assets/logo_readme.svg" alt="logo">
  <h1 align="center"><b>Bifröst - A Fluxer Discord Bridge</b></h3>

  <p align="center" >Bifröst is a Discord and Fluxer Bot that allows you bridge your Discord and Fluxer server</p>
</p>

## Features

- Link channels between Discord and Fluxer
- Sync messages between linked channels
- Support for messages, replies, attachments, emojis¹, stickers, embeds, join messages and polls
- Bridge messages using webhooks
- Easy setup using our hosted bot or self-hosting with Docker
- Customizable bot prefix and settings

¹ Emoji support is limited to custom emojis from the linked Discord server and standard Unicode emojis. Emojis from the servers must have matching names to be replaced correctly.

## Threads

Threads can be bridged like channels. A link always pairs two *locations*, and each side can be a text channel or a thread inside one, so channel↔channel, thread↔thread, channel↔thread and thread↔channel links are all possible. A thread does **not** have to belong to a linked channel to be linked itself. A link relays messages (send, edit and delete) in both directions; when both sides are threads, the thread name is kept in sync too. Everything else about a thread (archive state, lock state, members, pins, reactions, …) is intentionally left alone; see [docs/THREAD_SYNC_FUTURE.md](docs/THREAD_SYNC_FUTURE.md) for what could be added later.

Commands below use the default prefix `!b `. The prefix is configurable with `BF_COMMAND_PREFIX`.

### Automatic thread bridging

Every channel↔channel link has an **auto-sync threads** toggle (off by default). When it is on, any new thread created in either linked channel gets a counterpart thread in the other channel and the two threads are linked immediately as a thread↔thread link.

- `!b threads on` / `!b threads off` — run inside the linked channel or inside one of its threads. `!b threads` with no argument shows the current setting.
- In the web dashboard, each channel↔channel row has an *Auto-sync threads* switch (it is disabled for links that involve a thread).

If the toggle is on and a message arrives in a thread that is not linked yet (for example a thread created before the toggle was switched on), the counterpart thread is created lazily on that first message.

### Manual linking

With the toggle off, nothing is bridged until you link it. Linking a thread works exactly like linking a channel:

- `!b link <id>` — run inside the channel *or thread* you want to bridge, passing the ID of a channel or thread on the other platform. Any combination is allowed (channel↔channel, thread↔thread, channel↔thread). Confirm with `!b link confirm`.
- `!b unlink <id>` — removes a link by the other platform's channel or thread ID. Confirm with `!b unlink confirm`.
- `!b list` — lists every link in the server, one line per link, marking thread sides with 🧵.
- In the web dashboard, the *Link* dialog offers both channels and active threads on each side, and every row has an unlink button.

### Category links

A **category link** bridges a whole Discord category at once: every text channel in the category becomes a thread inside one Fluxer channel. The bridge creates a Fluxer thread named after each channel and links the two as an ordinary channel↔thread link, tagged with the category link so it can be managed (and removed) together with it. The mapping is kept current afterwards:

- A text channel created in or moved into the category is bridged automatically.
- A channel moved out of the category loses its link; the Fluxer thread stays.
- Renaming a channel renames its thread. Thread renames are **not** mirrored back (Discord normalises channel names to lowercase-with-hyphens, so the echo would rename the thread again).
- Deleting the category removes only the mapping; the links it created keep working on their own. Deleting a bridged Discord channel removes its link. Deleting the hosting Fluxer channel removes its own link and every category link targeting it (the threads died with the channel).

Commands, from Discord (run inside any channel of the category):

- `!b category <fluxerChannelId>` — shows a preview of the channels that would be bridged (and which are already linked elsewhere). Confirm with `!b category confirm`.
- `!b category unlink` — removes the mapping and every link it created; the Fluxer threads are left in place. Confirm with `!b category confirm`.
- `!b category` — shows the status of the category's link.

From Fluxer (run inside the hosting channel):

- `!b category <discordCategoryId>` — preview, then `!b category confirm`.
- `!b category unlink <discordCategoryId>` — then `!b category confirm`.

In the web dashboard, the *Link category* dialog creates a category link and the *Categories* block lists existing ones with an unlink button; rows created by a category link carry a *category* badge. `!b list` shows category links first, followed by the individual links. The command requires **Manage Webhooks**, and the bot needs the thread permissions listed under [Permissions](#permissions).

### How it works

- Webhooks only exist on channels, never on threads, so every link posts through a webhook on its (parent) channel, with the thread as target (`thread_id` on both Discord and Fluxer). A channel and all thread links under it **share one webhook per platform**; it is created with the first link that needs it and deleted with the last one. That also keeps well clear of Discord's per-channel webhook limit.
- When auto-sync creates a counterpart for a thread that was started from a bridged message, the counterpart is attached to the bridged copy of that message, so both threads hang off the same post. Otherwise a standalone thread is created in the linked channel.
- Threads created by the bridge are owned by the bot. The bridge recognises them by owner and never mirrors them back, so there are no create or rename loops.
- Renames are mirrored only for thread↔thread links. Channel↔thread links relay messages but leave names alone.
- Deleting a thread on either side only removes its link (and the shared webhook, if nothing else uses it). The counterpart thread or channel is left untouched.

### Permissions

Besides the permissions the bot already needs for channel bridging, thread bridging requires **Create Public Threads**, **Manage Threads** (to rename the counterpart thread) and **Send Messages in Threads** on both platforms. The invite links logged at startup include these. Installations made before thread support was added must grant them to the bot's role manually or re-invite the bot.

### Database migration

Thread bridging ships as three migrations. `00003-add-thread-links` adds `channel_links.autoSyncThreads` and a `thread_links` table (the first iteration of the feature). `00004-location-links` adds the nullable `channel_links.discordThreadId` / `fluxerThreadId` columns, replaces the unique indexes on the channel ID columns with partial ones (a channel can be linked once as a channel and still own any number of thread links), converts any existing `thread_links` rows into links of their own (inheriting the parent link's webhooks and keeping their message links), and drops `thread_links`. `00005-category-links` adds the `category_links` table (one row per linked Discord category) and the nullable `channel_links.categoryLinkId` column that tags the links a category link creates. Migrations run automatically on startup, so existing databases need no manual steps; existing channel links are unchanged and simply start with the toggle off.

## Community

Join out community Fluxer server for support, updates and to share your feedback: https://bifrost-bot.com/community/fluxer

## Docs

You can find the docs here: https://bifrost-bot.com/

## Getting Started

### Hosted Bot

You can find a guide on how to use the hosted bot here: https://bifrost-bot.com/docs/getting-started/

> [!NOTE]  
> You can check the uptime of the hosted instance [here](https://status.bifrost-bot.com)

### Self-Hosting with Docker

You can find a guide on how to self-host the bot using Docker here: https://bifrost-bot.com/docs/self-hosting/

## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for details.
