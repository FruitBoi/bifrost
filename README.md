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
- Bridge a Discord voice channel with a Fluxer voice channel (optional, see [Voice](#voice))

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

- `!b link <id>` — run inside the channel *or thread* you want to bridge, passing the ID of a channel or thread on the other platform. Any combination is allowed (channel↔channel, thread↔thread, channel↔thread). The link is created immediately, no confirmation step.
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

- `!b category <fluxerChannelId>` — bridges every text channel of the category immediately and reports which channels were linked, which were skipped (already linked elsewhere) and which failed.
- `!b category unlink` — removes the mapping and every link it created; the Fluxer threads are left in place. Confirm with `!b category confirm`.
- `!b category` — shows the status of the category's link.

From Fluxer (run inside the hosting channel):

- `!b category <discordCategoryId>` — bridges immediately, same report.
- `!b category unlink <discordCategoryId>` — removes the mapping and every link it created. Confirm with `!b category confirm`.

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

## Voice

A **voice link** bridges a Discord voice channel with a Fluxer voice channel. While the bridge is live, the bot sits in both channels and plays the mixed audio of each side into the other, so each side hears everyone on the other side as one extra participant. Voice bridging is **off by default** and is switched on with `BF_ENABLE_VOICE_BRIDGE=true`; without it the voice packages are never loaded and the commands below report that the feature is disabled.

Two constraints follow from how both platforms work:

- A bot can be in **one voice channel per server** on either platform, so a linked server pair can have many voice links but only **one live bridge at a time**. If a second linked channel gets visitors while a bridge is live, it is left alone until the first one ends.
- The bot cannot speak as individual users. Discord shows one participant for the whole Fluxer side and vice versa.

### Lifecycle

- The bridge joins both channels as soon as a person (not a bot) is in either linked channel, and leaves both after they have been empty for `BF_VOICE_LEAVE_GRACE_MS` (default 30 seconds).
- Users who self-mute or deafen are left out of the mix for the other side; everyone else is mixed in as they speak.
- If either voice connection drops while people are still present, the bridge leaves the other side too and rejoins with a short backoff. After a few failed attempts it gives up until someone joins again.
- Disabling or removing a voice link while its bridge is live disconnects the bridge immediately.

### Commands

From either platform (the first ID is a voice channel on the platform you run the command on, the second one is on the other platform):

- `!b voice <voiceChannelId> <otherPlatformVoiceChannelId>` — shows a preview with both channel names. Confirm with `!b voice confirm`.
- `!b voice unlink <voiceChannelId>` — removes the link. Confirm with `!b voice confirm`.
- `!b voice on <voiceChannelId>` / `!b voice off <voiceChannelId>` — enables or disables a link without removing it.
- `!b voice` — lists the server's voice links and whether they are enabled. `!b list` shows them too, marked with 🔊.

In the web dashboard, the *Link voice* dialog pairs two voice channels and the *Voice* block lists existing links with an enable switch and an unlink button.

### Permissions

On top of the permissions listed above, voice bridging requires **Connect**, **Speak** and **Use Voice Activity** in the linked voice channels on both platforms, and the Discord bot needs the *Guild Voice States* gateway intent (requested automatically). The invite links logged at startup include the extra permissions; installations made before voice support was added must grant them manually or re-invite the bot.

### Self-hosting notes

The audio path uses native modules (`@discordjs/opus`, `sodium-native`, `@snazzah/davey` for Discord's DAVE end-to-end encryption, and `@livekit/rtc-node` pulled in by `@fluxerjs/voice`). The container needs outbound UDP to Discord's voice servers and to the Fluxer instance's LiveKit media server. Each live bridge costs roughly one CPU core-fraction for Opus decoding, mixing and encoding in both directions. The voice packages declare Node 22 as their minimum while the image ships Node 20; the stack was verified to load and run its tests on Node 20, but moving the image to `node:22-slim` is recommended before relying on voice in production.

Fluxer currently runs voice on LiveKit and has announced it will replace it with its own end-to-end encrypted voice server. The Fluxer side of the bridge is isolated behind a small transport interface so it can be swapped when that happens; see [docs/VOICE_BRIDGE_FUTURE.md](docs/VOICE_BRIDGE_FUTURE.md) and [docs/VOICE_SPIKE.md](docs/VOICE_SPIKE.md).

### Database migration

Voice links ship as migration `00006-voice-links`, which adds the `voice_links` table (one row per pair of voice channels, with an `enabled` flag). It runs automatically on startup.

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
