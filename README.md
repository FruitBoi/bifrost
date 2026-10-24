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
- Bridge reactions: reacting to a bridged message adds the same emoji to its counterpart on the other platform (see [Reactions](#reactions))
- Easy setup using our hosted bot or self-hosting with Docker
- Customizable bot prefix and settings
- Bridge a Discord voice channel with a Fluxer voice channel (optional, see [Voice](#voice))
- Meows back when someone meows at it on Fluxer (see [Cat chat](#cat-chat))
- Copy a Discord server's custom emojis and stickers to the linked Fluxer server with one command (see [Emoji and sticker transfer](#emoji-and-sticker-transfer))
- Map a Fluxer account to a Discord account so pings reach the same person on both sides, and role pings reach the same-named role (see [Identity mapping](#identity-mapping))
- Reminders: `?remindme 1h30min take the pizza out` pings you back in that channel (see [Reminders](#reminders))
- Mass-delete messages for moderators: `?clean 20 -bots` (see [Moderation](#moderation))
- Copy a linked channel's message history to the other platform, in the style of bridged messages: `!b history 500` (see [History transfer](#history-transfer))
- File a GitHub issue for Claude straight from chat: `!b clauderequest make the bot meow louder` (see [Claude requests](#claude-requests))
- See how many lines of code Claude has written for the bot: `!b lines` (see [Lines](#lines))

¹ Emoji support is limited to custom emojis from the linked Discord server and standard Unicode emojis. Emojis from the servers must have matching names to be replaced correctly. `!b expressions` creates the matching-name emojis on Fluxer for you (see [Emoji and sticker transfer](#emoji-and-sticker-transfer)).

## Threads

Threads can be bridged like channels. A link always pairs two *locations*, and each side can be a text channel or a thread inside one, so channel↔channel, thread↔thread, channel↔thread and thread↔channel links are all possible. A thread does **not** have to belong to a linked channel to be linked itself. A link relays messages (send, edit and delete) in both directions; when both sides are threads, the thread name is kept in sync too. Everything else about a thread (archive state, lock state, members, pins, …) is intentionally left alone; reactions on messages in a linked thread are bridged like anywhere else (see [Reactions](#reactions)); see [docs/THREAD_SYNC_FUTURE.md](docs/THREAD_SYNC_FUTURE.md) for what could be added later.

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
- A channel moved out of the category loses its link; the Fluxer thread stays. Set `categories.unlinkWhenChannelLeaves: false` in the [configuration file](#configuration-file) to keep the link instead.
- Renaming a channel renames its thread (switch off with `categories.mirrorChannelRenames: false`). Thread renames are **not** mirrored back (Discord normalises channel names to lowercase-with-hyphens, so the echo would rename the thread again).
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
- Renames are mirrored only for thread↔thread links (switch off with `threads.mirrorRenames: false` in the [configuration file](#configuration-file)). Channel↔thread links relay messages but leave names alone. Without Manage Threads the bot can only rename threads it owns; see [Permissions](#permissions).
- Deleting a thread on either side only removes its link (and the shared webhook, if nothing else uses it). The counterpart thread or channel is left untouched unless `threads.mirrorDeletes` is enabled, in which case a counterpart *thread* is deleted too (a counterpart channel never is).

### Permissions

Besides the permissions the bot already needs for channel bridging (including **Add Reactions** for [reaction bridging](#reactions)), thread bridging requires **Create Public Threads** and **Send Messages in Threads** on both platforms. The invite links logged at startup include these. Installations made before thread support was added must grant them to the bot's role manually or re-invite the bot.

**Manage Threads** is *not* requested by default. Without it the bot can rename only the threads it created itself (the counterpart threads it made for auto-sync and category links, which it owns), and it cannot delete or archive any thread. That covers the common case: a rename on the user-created side is mirrored onto the bot-created counterpart, while a rename of the bot-created thread cannot be mirrored back onto a thread the bot does not own. `threads.mirrorDeletes` needs Manage Threads and does nothing without it.

To opt in, set `permissions.manageThreads: true` in the [configuration file](#configuration-file) and restart. The invite links then include Manage Threads; re-invite the bot with the new link or grant the permission to the bot's role on both platforms by hand. Thread rename mirroring (`threads.mirrorRenames`) and the category-link behaviours (`categories.mirrorChannelRenames`, `categories.unlinkWhenChannelLeaves`) are switches in the same file; see [config.example.yml](config.example.yml).

### Database migration

Thread bridging ships as three migrations. `00003-add-thread-links` adds `channel_links.autoSyncThreads` and a `thread_links` table (the first iteration of the feature). `00004-location-links` adds the nullable `channel_links.discordThreadId` / `fluxerThreadId` columns, replaces the unique indexes on the channel ID columns with partial ones (a channel can be linked once as a channel and still own any number of thread links), converts any existing `thread_links` rows into links of their own (inheriting the parent link's webhooks and keeping their message links), and drops `thread_links`. `00005-category-links` adds the `category_links` table (one row per linked Discord category) and the nullable `channel_links.categoryLinkId` column that tags the links a category link creates. Migrations run automatically on startup, so existing databases need no manual steps; existing channel links are unchanged and simply start with the toggle off.

## Reactions

When someone reacts to a bridged message, the bot adds the same reaction to the counterpart message on the other platform. This works in both directions, on the original message as well as on its webhook copy, and in channels and threads alike (any message the bridge has linked).

- **One reaction from the bot.** Webhooks cannot react, so the mirrored reaction is always the bot's own: the other side sees a single reaction from the bot per emoji, not one per person and no counts. It stays as long as at least one person on the source side still has that emoji; when the last one removes it (or a moderator clears that emoji or all reactions), the bot removes its reaction from the counterpart. The bot's own reactions are never bridged back, so nothing loops.
- **Emojis.** Standard Unicode emojis are mirrored as-is. A custom emoji is mirrored only when the other server has a custom emoji with the **same name** (the same rule as for emojis inside messages); otherwise that reaction is simply not bridged.
- **Toggle.** Reaction bridging is on by default; turn it off with `reactions.enabled: false` in the [configuration file](#configuration-file).
- **Permissions.** The bot needs **Add Reactions** (and **Read Message History**, which bridging already requires) on both platforms. The invite links logged at startup include it; installations made before reaction bridging was added must grant it to the bot's role manually or re-invite the bot. On Discord the bot also needs the *Guild Message Reactions* gateway intent, which is requested automatically (it is not privileged).

## Voice

A **voice link** bridges a Discord voice channel with a Fluxer voice channel. While the bridge is live, the bot sits in both channels and plays the mixed audio of each side into the other, so each side hears everyone on the other side as one extra participant. **You link a pair of channels once**: the link is stored in the database and the bot joins both channels on its own once there are people in both of them, so nobody has to run a command before a voice chat. Voice bridging is **off by default** and is switched on with `BF_ENABLE_VOICE_BRIDGE=true`; without it the voice packages are never loaded and the commands below report that the feature is disabled.

Two constraints follow from how both platforms work:

- A bot can be in **one voice channel per server** on either platform, so a linked server pair can have many voice links but only **one live bridge at a time**. If a second linked channel pair has people on both sides while a bridge is live, it is left alone until the first one ends.
- The bot cannot speak as individual users. Discord shows one participant for the whole Fluxer side and vice versa.

### Lifecycle

- A voice link is created once and persists; there is nothing to re-run when people come and go.
- The bridge joins both channels automatically only when a person (not a bot) is in the Discord channel **and** a person is in the Fluxer channel; if only one side has people, the bot stays out. Once either side is empty it leaves both after `BF_VOICE_LEAVE_GRACE_MS` (default 30 seconds) unless someone rejoins that side in time, and comes back by itself the next time both sides have people.
- Users who self-mute or deafen are left out of the mix for the other side; everyone else is mixed in as they speak.
- If either voice connection drops while both sides still have people, the bridge leaves the other side too and rejoins with a short backoff. After a few failed attempts it gives up until someone joins again.
- Disabling or removing a voice link while its bridge is live disconnects the bridge immediately.

### Commands

From either platform (the first ID is a voice channel on the platform you run the command on, the second one is on the other platform):

- `!b voice <voiceChannelId> <otherPlatformVoiceChannelId>` — links the two voice channels immediately, no confirmation step. Run it once per channel pair; from then on the bot joins by itself whenever people are in both channels.
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

## Cat chat

Say `meow`, `mrrp`, `nyah` or `purr` on Fluxer (stretched, repeated or decorated with `!`, `~`, `:3` or a cat emoji as you like) and Bifröst answers with a cat noise of its own, matching the kind of noise, how stretched it was and the mood of the punctuation, so you can hold a little conversation with it. **Only Fluxer users get an answer**: a meow written on Discord is bridged like any other message but is not replied to. Only messages that consist entirely of cat noises count: an ordinary sentence that happens to contain "meow" is ignored, as are bots and bridged messages. In a linked channel the reply is bridged like any other message, so Discord still sees the exchange. Replies are limited to one per channel every 1.5 seconds. Turn the feature off with `meow.enabled: false` in the [configuration file](#configuration-file).

## Identity mapping

Many people are on both platforms. An **identity mapping** (a *user link*) tells the bridge which Fluxer account and which Discord account are the same person, so a ping on one side reaches that person on the other. Mappings are created with the Fluxer command `!b role <@fluxerUser> <discordUserId>` (alias `!b map`; both names do exactly the same). It takes the Fluxer member as a mention and the ID of their Discord account, and only members holding one of the Fluxer roles listed in `roles.identity` in the [configuration file](#configuration-file) may run it.

The `role` command does three things at once and reports the outcome of each:

1. **Roles** — every Fluxer role with the same name as one of the Discord user's roles is added to the Fluxer member.
2. **Identity mapping** — the two accounts are recorded as the same person for this server pair. Mappings are one-to-one: re-running the command for either account replaces that account's previous mapping. They are removed together with the server link.
3. **Thread membership** — for every bridged thread pair (thread↔thread link) whose Discord thread the Discord user is a member of, the Fluxer member is added to the Fluxer thread. Adding someone to a public Fluxer thread requires the bot to be able to manage the parent channel; threads it could not add the member to are listed in the reply.

### Pings

User pings need an identity mapping; role pings need a role with the same name in the linked server.

- With a mapping, a `<@user>` mention written on one platform is relayed as a real mention of the mapped account on the other, and a reply-with-ping to a message that was written on the replier's own platform pings the author's mapped account on the other side.
- Without a mapping, mentions are relayed as plaintext `@name` and nobody is pinged on the other side.
- Replying with a ping to a *bridged copy* of a message (one the bridge posted on your platform) has always pinged the original author on their platform and still does, mapping or not.
- A `<@&role>` mention is relayed as a real mention of the role with the **same name** in the linked server on the other platform, Discord → Fluxer and Fluxer → Discord. Names are matched the same way as for custom emojis and `!b role`.
- The role is only pinged on the other side if the author could ping it on their own: the role is mentionable there, or the author has **Mention Everyone** (or the Fluxer equivalent).
- If the other server has no role with that name, or the author could not ping the role, the mention is relayed as plaintext `@RoleName` and nobody is pinged.
- `@everyone` and `@here` are never bridged, and editing a bridged message never pings anyone again.
- Role ping bridging is on by default; turn it off with `roles.bridgeMentions: false` in the [configuration file](#configuration-file) to relay every role mention as plaintext.

### Database migration

Identity mappings ship as migration `00008-user-links`, which adds the `user_links` table (one row per mapped account pair, unique per server link on both the Discord and the Fluxer side). It runs automatically on startup; rolling it back drops the table.

## Emoji and sticker transfer

Custom emojis are bridged by **name**: in messages and in [reactions](#reactions), a custom emoji only comes through when the other server has a custom emoji with the same name. Instead of re-creating every emoji on Fluxer by hand, one command copies all of the linked Discord server's custom emojis and stickers into the linked Fluxer server under the same names. The copy goes one way only, **Discord → Fluxer**; nothing is ever deleted or renamed on either side.

- `!b expressions` — copies the emojis and the stickers.
- `!b expressions emojis` — copies only the emojis.
- `!b expressions stickers` — copies only the stickers.

`!b emotes` and `!b emojis` are aliases of `!b expressions`. The command works on both platforms: run it on Discord inside the linked Discord server, or on Fluxer inside the linked Fluxer server; either way the Discord server's expressions are copied to the Fluxer server it is linked to.

- **Re-running is safe.** An emoji or sticker whose name already exists on the Fluxer server is skipped (names are compared exactly, case-sensitive, the same rule bridging uses), so after adding new emojis on Discord, run the command again to copy only the new ones. If several Discord emojis share a name, it is copied once.
- **What is copied.** Emojis (PNG or animated GIF) and PNG, APNG and GIF stickers are copied as-is at their original size, keeping the name; stickers also keep their description and tag.
- **What is skipped.** Lottie stickers (Discord's animated vector format) cannot be transferred, because Fluxer only stores PNG, APNG, GIF and WebP images.
- **Progress and report.** For a non-empty transfer the bot first posts a short "copying N emojis and M stickers…" notice: images are downloaded from Discord and uploaded to Fluxer in batches, so a large server can take a while. When it is done it posts one report listing what was created, what was skipped (and why) and what failed (with the error). A failed item does not stop the rest.
- **One at a time.** Only one transfer per Fluxer server runs at once; running the command again while one is in progress is refused with a message.

### Permissions

- **Who may run it.** The member needs **Manage Expressions** on the platform the command is run on: in the linked Discord server when run on Discord, in the linked Fluxer server when run on Fluxer. `roles.*` in the configuration file does not apply.
- **What the bot needs.** **Create Expressions** in the Fluxer server, to upload the copies. Reading the Discord server's emojis and stickers needs no extra permission. The invite links logged at startup include Create Expressions; installations made before emoji and sticker transfer was added must grant it to the bot's role on Fluxer manually or re-invite the bot.

### Limits

Fluxer's defaults apply (a self-hosted instance may configure them differently): a server has **500 emoji** and **500 sticker** slots, and each image may be at most **512 KiB**. Items that do not fit, are too large, or whose content the instance blocks are listed as failed in the report, with Fluxer's error.

## Reminders

Bifröst has a reminder command modelled on [YAGPDB's `remindme`](https://help.yagpdb.xyz/docs/core/all-commands/#remindme): tell it how long to wait and what to say, and when the time is up it pings you in the channel you set it in. It works the same on Discord and on Fluxer.

There are three ways to run the commands:

- `?remindme 1h30min take the pizza out`
- `!remindme 1h30min take the pizza out`
- `!b remindme 1h30min take the pizza out` (the normal bot prefix, always available)

The short `?` and `!` forms work for every reminder command and alias below (`?reminders`, `!reminder delete 3`, …), and a space or capital after the prefix is fine, so `? Remindme 1h30min …` as typed on a phone keyboard works too. They are set by `reminders.triggerPrefixes` in the [configuration file](#configuration-file); an empty list leaves only the bot-prefix form, and `reminders.enabled: false` switches reminders off entirely. Like other commands, these messages are not bridged to the other platform and are deleted when `BF_DELETE_INVOCATION` is on.

### Commands

- `remindme <time> <message>` (alias `remind`) — schedules a reminder in the current channel. Add `-channel <channel>` (a channel mention or ID, before the time or at the very end) to have it delivered in another text channel or thread of the same server instead; you need permission to view and send messages there. Example: `?remindme -channel #general 2d book the venue`.
- `reminder list` (alias `reminders`) — lists your reminders in this server with their IDs, a preview of the message and when they are due.
- `reminder channel` (aliases `creminders`, `channelreminders`) — lists every reminder set for the current channel, by anyone. Requires **Manage Channels**.
- `reminder delete <id>` (aliases `delreminder`, `rmreminder`) — deletes a reminder. You can always delete your own; deleting someone else's requires **Manage Channels** in the reminder's channel (or in the server, if that channel no longer exists).
- `reminder delete -a` — deletes all of your reminders.

### Duration syntax

The time is parsed like YAGPDB does it: a sequence of `<number><unit>` parts written together, such as `90`, `45s`, `10m`, `1h30min`, `1day3h`, `2w`, `1mo` or `1y`. Units are matched by their first letters:

| Unit | Meaning |
| --- | --- |
| `s`, `sec`, `seconds` | seconds |
| `m`, `min`, `minutes` | minutes |
| `h`, `hours` | hours |
| `d`, `days` | days |
| `w`, `weeks` | weeks |
| `mo`, `months` | months (30 days) |
| `y`, `years` | years (365 days) |
| *(none)* | minutes, so `90` means 90 minutes |

The time must start with a number and is a **single word**: in `?remindme 1h 30m stretch` the reminder fires after one hour and its message is `30m stretch`. Write `1h30m` instead.

### Limits

- A reminder can be set at most **10 years** ahead (`10y` is fine, `10y1d` is not) and at least 1 second ahead.
- Each user can have **25** reminders at a time (counted across all servers on that platform).
- The message can be up to 2000 characters.
- Bots cannot set reminders, and the commands only work in servers, not in DMs.

### Delivery

When a reminder is due, Bifröst posts `**Reminder** for @you` in the channel it was set for, with the message in an embed. Only you are pinged: mentions of other people, roles or `@everyone` in the message are not. Reminders belong to the platform they were created on: one set on Discord is delivered on Discord and is not bridged to Fluxer, and vice versa. Reminder IDs come from one sequence shared by both platforms, so the IDs you see may skip numbers; you can only see and delete reminders from the platform you are on.

If the bot was offline when a reminder came due, it is delivered shortly after the bot starts again. A reminder whose channel no longer exists (or that the bot can no longer post in) is dropped, and so is one that still fails after several delivery attempts.

### Database migration

Reminders ship as migration `00009-reminders`, which adds the `reminders` table (one row per pending reminder; a row is removed once it is delivered or deleted). It runs automatically on startup.

## Moderation

### Clean

Bifröst has a bulk-delete command modelled on [YAGPDB's `clean`](https://help.yagpdb.xyz/docs/core/all-commands/#clean): tell it how many messages to remove, optionally whose and which, and it deletes them from the current channel. It works the same on Discord and on Fluxer, and is a **moderator command** (see [Permissions](#permissions-3) below).

There are three ways to run it:

- `?clean 10`
- `!clean 10`
- `!b clean 10` (the normal bot prefix, always available)

The aliases `clear` and `cl` work everywhere `clean` does (`?clear 5`, `!b cl 3`), and a space or capital after the short prefix is fine, so `? Clean 10` as typed on a phone keyboard works too. The short prefixes are set by `clean.triggerPrefixes` in the [configuration file](#configuration-file); an empty list leaves only the bot-prefix form, and `clean.enabled: false` switches the command off entirely.

**Arguments.** `clean <num> [user]` or `clean [user] <num>`: `num` is how many messages to delete (1–100) and `user`, a mention or a user ID, limits the deletion to that user's messages. Switches can go anywhere after the command:

| Switch | Effect |
| --- | --- |
| `-r <regex>` | Only messages whose text matches the regular expression. |
| `-im` | Invert the regex: only messages that do **not** match. |
| `-i` | Make the regex case-insensitive. |
| `-ma <time>` | Max age: only messages younger than the given time. |
| `-minage <time>` | Min age: only messages older than the given time. |
| `-nopin` | Leave pinned messages alone. |
| `-a` | Only messages with attachments. |
| `-bots` | Only messages written by bots. |
| `-from <id>` | Start at this message ID: only that message and older ones. |
| `-to <id>` | Stop at this message ID: only that message and newer ones. |

Times use the reminder [duration syntax](#duration-syntax) (`30m`, `1h30m`, `2d`; a bare number is minutes), and `0` means no limit. Wrap a value in double quotes to keep its spaces: `-r "foo bar"`.

Examples:

- `?clean 20 -bots` — deletes the last 20 bot messages.
- `?clean 50 @user -ma 1h` — deletes up to 50 of that user's messages from the last hour.
- `?clean 10 -r "^!"` — deletes the last 10 messages that start with `!`.
- `?clear 5 -nopin` — deletes the last 5 messages that are not pinned.

#### Limits

- At most **100** messages are deleted per run. Without filters exactly the last `num` messages are looked at; with a user or any switch, up to `num × 50` messages are searched, and never more than the last **1000**.
- On **Discord**, messages older than two weeks cannot be bulk-deleted, so the search stops at the first one it reaches. Fluxer has no such age limit.
- The command message itself is never counted and is deleted as well.
- When it is done, Bifröst posts `Deleted N message(s)! :')` (or `No messages matched.`) and removes that confirmation after 5 seconds.
- Deleting a bridged message also deletes its copy on the other platform, just like deleting a single message does.
- Bots cannot use the command, and it only works in servers, not in DMs.

#### Permissions

- **Who may run it.** The member needs at least one of the roles listed in `roles.moderator` in the [configuration file](#configuration-file). Role IDs are matched on the platform the command is run on, and the default (`1561105750388908139`) is a **Fluxer** role, so out of the box nobody can run `clean` on Discord: add a Discord role ID to `roles.moderator` to allow it there.
- **What the bot needs.** **Manage Messages** and **Read Message History** in the channel.

### History transfer

Linking two channels bridges new messages only. `history` (alias `backfill`) copies the messages that were already there: run it inside a linked channel or thread on either platform and it posts that channel's history to the linked counterpart, oldest first, through the same pipeline as live bridging. Copies look like bridged messages (the author's name and avatar via the webhook, attachments, embeds, replies, emojis), and each one starts with a small `<t:…>` line showing when the original was written. It is a **moderator command** (see [Permissions](#permissions-4) below) and only answers to the bot prefix: `!b history …`, never `?history`.

**Scope.** Three ways to say what to copy:

- `!b history` copies the last 100 messages (`history.defaultCount`); `!b history 500` the last 500, up to `history.maxCount` (1000 by default).
- `!b history all` copies the whole history. Because that may be a lot, Bifröst first explains what will happen and waits for `!b history confirm` from the same person in the same channel, for 2 minutes.
- `-ma <time>` copies only messages younger than the given time (`-ma 7d`), `-after <id>` only messages newer than that message, `-before <id>` only older ones; message IDs or message links both work. These combine with a count or `all`: `!b history all -after 1234567890123456789`.

| Switch | Effect |
| --- | --- |
| `-ma <time>` | Max age: only messages younger than the given time ([duration syntax](#duration-syntax)). |
| `-after <id>` | Only messages newer than this message ID or link. |
| `-before <id>` | Only messages older than this message ID or link. |
| `-digest` | Pack many messages into transcript posts instead of one post per message. |
| `-notime` | Leave out the timestamp line at the top of each copy. |

**What is skipped.** Messages that were already bridged live, or already transferred by an earlier run, are skipped, so running the command again is safe: it only fills the gaps and continues where a stopped run ended. System messages (joins, pins), empty messages, bot commands and the bot's own messages are skipped as well. Copies made in plain mode get a message link like live-bridged messages, so later reactions, edits and deletions of the original are mirrored to them (an edit refreshes the copy without the timestamp line).

**How it runs.** The transfer runs in the background, one channel at a time (further requests queue up), with a pause of `history.delayMs` between posts so the bot stays inside both platforms' rate limits. The reply to the command is a status embed that keeps updating while the job runs and shows the final counts when it is done; `!b history status` shows it again and `!b history stop` cancels the job (what was posted stays). The copies appear at the bottom of the other channel, in the original order, after whatever is there already; they never ping anyone, even when the original did.

**How long it takes.** Roughly *posts × delay*: 1000 messages at the default 1 s delay take about 17 minutes, a channel with 50 000 messages about 14 hours. `-digest` is the fast lane: it packs roughly 10–20 messages into one transcript post (author, time and text per line; attachments are re-uploaded with the post and noted as `📎 name`), so the same channel takes a fraction of the time. The price is that digest copies get no per-message links, so later reactions, edits and deletions of those originals are not mirrored to them, and replies to them cannot ping the original author. Use plain mode for the recent part of a channel and `-digest -before <id>` for the old bulk if you want both.

#### Permissions

- **Who may run it.** A member with one of the roles listed in `roles.moderator`, like [Clean](#clean); add a Discord role ID there to allow it on Discord.
- **What the bot needs.** **Read Message History** in the channel the command is run in. Posting on the other side goes through the link's webhook, which exists already.

`history.enabled: false` switches the command off. The transfer state ships as migration `00010-history-messages`, which adds the `history_messages` table (one row per transferred message, so re-runs can skip them); it runs automatically on startup.

## Claude requests

`!b clauderequest <request>` turns a chat message into a GitHub issue for Claude, without opening GitHub: everything after the command (newlines kept, up to 4000 characters) becomes an issue in the bot's repository (`claudeRequests.repo`, `FruitBoi/bifrost` by default) with the `claude` label (`claudeRequests.label`), the same label the **Claude request** issue template sets. The first line becomes the issue title (cut to 80 characters), the full text the body, followed by who sent it and from which server and channel. The bot replies with a link to the new issue. `@name` mentions in the text are defused so filing a request never pings anyone on GitHub.

- **Who may run it.** Members with one of the roles in `roles.claudeRequest` (by default the same Fluxer roles as `roles.identity`; add a Discord role ID to allow it on Discord). One request per minute per user.
- **Setup.** Set `BF_GITHUB_TOKEN` (or `BF_GITHUB_TOKEN_FILE`) to a GitHub token that may create issues and apply labels in the repository, for example a fine-grained token limited to that repository with **Issues: Read and write**. Without it the command replies that it is not configured. `claudeRequests.enabled: false` switches the command off.

Filing an issue does not start any work by itself; see [CLAUDE.md](CLAUDE.md) for how Claude requests are picked up.

## Lines

`!b lines` answers the server's favorite question: how many lines of code has Claude written? It scans the default branch of the bot's repository (`claudeRequests.repo`) and adds up the lines added and deleted in every commit with a `Co-Authored-By: Claude …` trailer, then replies with the totals, the number of those commits, their share of all lines added, the biggest and the latest Claude commit, and when the first one landed. Anyone can run it. Results are cached for 10 minutes; up to the 5000 most recent commits are scanned.

It reads the history through the GitHub GraphQL API, so it needs `BF_GITHUB_TOKEN` as well (the GraphQL API does not allow anonymous requests); a fine-grained token also needs **Contents: Read** on the repository. Without a token the command replies that it is not configured.

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

### Environment variables

Secrets, database settings and feature flags are read from environment variables (or an `.env` file); [.env.example](.env.example) lists every variable with a short description. Behavioural switches that are not secrets live in the optional configuration file described next.

### Configuration file

The bot can also read an **optional** configuration file once at startup. Nothing needs to exist for the bot to run; a missing file means every setting keeps its default.

**Lookup order.** If `BF_CONFIG_FILE` is set, that file is used (startup fails if it does not exist). Otherwise the bot looks for `config.yml`, `config.yaml` and `config.json`, in that order, inside `BF_CONFIG_PATH`, the directory that also holds the SQLite database (`./config` by default; in the Docker image it is `/config`, which the compose files mount from `./config` on the host). The file may be YAML or JSON; the extension decides which parser is used.

**Validation.** Keys you omit keep their defaults. Unknown keys are logged as warnings and ignored. A value of the wrong type (for example `"false"` as a string instead of `false`) stops startup with the offending key path. Renamed keys (currently `roles.copyAllowedRoleIds` → `roles.identity`) still work and log a warning naming the new key. The bot logs which file it loaded, or that it is using defaults. Edits take effect after a restart.

[config.example.yml](config.example.yml) contains every key with its default and a comment; copy it to `<BF_CONFIG_PATH>/config.yml` and change what you need.

| Key | Default | Meaning |
| --- | --- | --- |
| `permissions.manageThreads` | `false` | Request **Manage Threads** in the bot invite links. Needed to rename threads the bot does not own and for `threads.mirrorDeletes`, but it also lets the bot delete and archive any thread. See [Permissions](#permissions). |
| `threads.mirrorRenames` | `true` | Mirror thread renames between linked threads (thread↔thread links). |
| `threads.mirrorDeletes` | `false` | When a linked thread is deleted on one side, delete its counterpart too. Requires `permissions.manageThreads` on Discord and the matching right on Fluxer; otherwise the counterpart stays and only the link is removed. |
| `categories.mirrorChannelRenames` | `true` | Mirror Discord channel renames onto the Fluxer thread a category link created for the channel. |
| `categories.unlinkWhenChannelLeaves` | `true` | Drop a channel's link when it is moved out of a linked category (the Fluxer thread stays). |
| `roles.moderator` | `["1561105750388908139"]` | Role IDs whose members may run the moderator commands (`clean`, `history`); see [Clean](#clean) and [History transfer](#history-transfer). IDs are matched on the platform the command is run on, so add a Discord role ID to allow them on Discord. Quote the IDs, unquoted numbers lose precision. |
| `roles.identity` | `["1561105750388908139", "1561105750388908112"]` | Fluxer role IDs whose members may run the identity command `!b role` (alias `!b map`); see [Identity mapping](#identity-mapping). Formerly `roles.copyAllowedRoleIds`. Quote the IDs, unquoted numbers lose precision. |
| `roles.bridgeMentions` | `true` | Relay role mentions as real pings of the role with the same name in the linked server on the other platform, if the author could ping the role on their own side. Without a same-named role the mention stays plaintext `@RoleName`; `@everyone`/`@here` are never bridged and edits never re-ping. `false` relays every role mention as plaintext. See [Pings](#pings). |
| `roles.claudeRequest` | `["1561105750388908139", "1561105750388908112"]` | Role IDs whose members may run `!b clauderequest`; see [Claude requests](#claude-requests). Quote the IDs, unquoted numbers lose precision. |
| `claudeRequests.enabled` | `true` | Enable the `clauderequest` command on both platforms. It also needs `BF_GITHUB_TOKEN`. |
| `claudeRequests.repo` | `"FruitBoi/bifrost"` | Repository (`owner/name`) the issues are opened in. |
| `claudeRequests.label` | `"claude"` | Label put on every issue. |
| `clean.enabled` | `true` | Enable the `clean` command (aliases `clear`, `cl`) on both platforms. See [Clean](#clean). |
| `clean.triggerPrefixes` | `["?", "!"]` | Prefixes that run `clean` without the bot prefix (`?clean 10`). `!b clean` always works; an empty list disables the shortcuts. Drop `"!"` if other bots in your server use it. |
| `history.enabled` | `true` | Enable the `history` command (alias `backfill`) on both platforms. See [History transfer](#history-transfer). |
| `history.defaultCount` | `100` | Messages copied by a bare `!b history`. |
| `history.maxCount` | `1000` | Largest count accepted as a number (`!b history 1000`); anything bigger needs `!b history all` plus `confirm`. |
| `history.delayMs` | `1000` | Pause between two posts on the destination, in milliseconds; 1000 posts take about `1000 × delayMs`. Keep it at or above the default: both platforms rate-limit webhooks and Fluxer IP-bans bots that exceed its limits. |
| `meow.enabled` | `true` | Answer Fluxer messages that are nothing but cat noises (`meow`, `mrrp`, `nya`, `purr`…) with a cat noise; Discord users are never answered. See [Cat chat](#cat-chat). |
| `reminders.enabled` | `true` | Enable the `remindme` / `reminder` commands on both platforms. See [Reminders](#reminders). |
| `reminders.triggerPrefixes` | `["?", "!"]` | Prefixes that run the reminder commands without the bot prefix (`?remindme 1h take a break`). `!b remindme` always works; an empty list disables the shortcuts. Drop `"!"` if other bots in your server use it. |
| `reactions.enabled` | `true` | Mirror reactions on bridged messages onto the counterpart message, as one reaction from the bot per emoji. Needs **Add Reactions** on both platforms. See [Reactions](#reactions). |

Example `config.yml` that keeps the defaults except for enabling deletion mirroring:

```yaml
permissions:
    manageThreads: true
threads:
    mirrorDeletes: true
```

## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for details.
