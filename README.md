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

Threads inside linked text channels can be bridged too. A bridged thread pair relays messages (send, edit and delete) in both directions and keeps the thread name in sync. Everything else about a thread (archive state, lock state, members, pins, reactions, …) is intentionally left alone; see [docs/THREAD_SYNC_FUTURE.md](docs/THREAD_SYNC_FUTURE.md) for what could be added later.

Commands below use the default prefix `!b `. The prefix is configurable with `BF_COMMAND_PREFIX`.

### Automatic thread bridging

Every channel link has an **auto-sync threads** toggle (off by default). When it is on, any new thread created in either linked channel gets a counterpart thread on the other side and the pair is linked immediately.

- `!b threads on` / `!b threads off` — run inside the linked channel or inside one of its threads. `!b threads` with no argument shows the current setting.
- In the web dashboard, each channel link row has an *Auto-sync threads* switch.

If the toggle is on and a message arrives in a thread that is not linked yet (for example a thread created before the toggle was switched on), the counterpart thread is created lazily on that first message.

### Manual thread bridging

With the toggle off, threads behave like channels: nothing is bridged until you link it.

- `!b link <threadId>` — run *inside* a thread of a linked channel, passing the ID of the thread on the other platform. Both threads must belong to the two channels of the same channel link. Confirm with `!b link confirm`.
- `!b unlink <threadId>` — removes a thread link by the other platform's thread ID. Confirm with `!b unlink confirm`.
- `!b list` — lists channel links and the threads bridged under each of them.
- In the web dashboard, use *Link thread* on a channel link row to pair two existing threads, or the trash button next to a bridged thread to unlink it.

### How it works

- Thread messages are posted through the **parent channel link's existing webhooks** with a thread target (`thread_id` on both Discord and Fluxer), so no extra webhooks are created per thread.
- When a thread is started from a message that was itself bridged, the counterpart thread is attached to the bridged copy of that message, so both threads hang off the same post. Otherwise a standalone thread is created in the linked channel.
- Threads created by the bridge are owned by the bot. The bridge recognises them by owner and never mirrors them back, so there are no create or rename loops.
- Deleting a thread on either side only removes the thread link; the counterpart thread is left untouched.

### Permissions

Besides the permissions the bot already needs for channel bridging, thread bridging requires **Create Public Threads**, **Manage Threads** (to rename the counterpart thread) and **Send Messages in Threads** on both platforms. The invite links logged at startup include these. Installations made before thread support was added must grant them to the bot's role manually or re-invite the bot.

### Database migration

Thread bridging ships as migration `00003-add-thread-links`, which adds `channel_links.autoSyncThreads`, a new `thread_links` table and nullable `threadLinkId` columns on `message_links` and `queued_messages`. Migrations run automatically on startup, so existing databases need no manual steps; existing channel links simply start with the toggle off.

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
