# Voice bridge: possible future features

Bifröst bridges voice in a deliberately narrow way:

- **What is bridged:** audio. While a voice link is live the bot is in both channels and relays one mixed Opus stream per direction. Self-mute and self-deafen on either side remove that person from the mix.
- **What is not bridged:** everything else. Video and screen sharing, per-user attribution, speaking indicators, server mute/deafen, stage channels, soundboard and entrance sounds, voice-channel text chat, and more than one live bridge per server pair.

This document lists what could be added later, why it was left out, and the main thing to watch when implementing it.

## Current limitations

- **One live bridge per linked server pair.** A bot can be in one voice channel per guild on both platforms. A second voice link in the same pair waits until the first bridge ends. Supporting several would need extra bot accounts (one token per concurrent bridge), which also multiplies invite links, permissions and health checks.
- **One voice, many speakers.** Discord allows exactly one audio stream per bot connection, so the Fluxer side is heard as a single participant. On Fluxer the bot could publish one LiveKit track per Discord speaker, but clients still render one participant, so the gain is small.
- **No speaking indicator for the far side.** The bot's speaking indicator lights up whenever anyone on the other side talks, with no name attached.
- **Fluxer transport is LiveKit-specific.** Fluxer has announced a replacement for LiveKit with end-to-end encryption (DAVE). If bots cannot take part in encrypted calls, the Fluxer half of the bridge stops working until the new protocol exposes a bot path. The `VoiceTransport` interface exists so only `FluxerVoiceTransport` has to change.
- **No history or recording.** Audio is relayed live and never stored.

## Candidate features

### Per-user tracks on the Fluxer side

*Rationale:* LiveKit lets one participant publish several audio tracks, so each Discord speaker could become a named track.
*Consideration:* Fluxer clients mix all tracks of a participant into one tile, so users would not see who is speaking anyway. Only worth it if Fluxer's client (or the replacement server) renders tracks separately.

### Text notice when the bridge goes live

*Rationale:* People joining a bridged channel should know their voice is relayed to another platform.
*Consideration:* Voice channels have a text chat on both platforms; a short message when the bot joins and leaves is cheap. Needs Send Messages in the voice channel. Could be made per-link configurable (`voice_links.announce`).

### Server mute / deafen mapping

*Rationale:* Today only self-mute and self-deafen are honoured. A moderator muting someone on one side still lets that person be heard on the other side.
*Consideration:* Both platforms expose `mute` / `deaf` in the voice state; mapping them is the same path as self-mute. Deciding whether a server mute on one side should also server-mute the bot on the other side is a policy question and probably not wanted.

### Bot-side mute as a kill switch

*Rationale:* Moderators may want to silence the bridge quickly without unlinking.
*Consideration:* Server-muting the bot on Discord only stops Discord from hearing it, so the bridge should watch its own voice state and pause the opposite mixer too, giving a one-click "mute the bridge" on either side.

### Several concurrent bridges per server pair

*Rationale:* Communities with several active voice channels want all of them bridged.
*Consideration:* Requires a pool of bot tokens and a scheduler that assigns a free bot to each link that needs a bridge. Every pooled bot must be invited with voice permissions on both platforms. This is a large change to configuration and health checks.

### Video and screen sharing

*Rationale:* Both platforms support camera and screen share in voice channels.
*Consideration:* Discord bots cannot send or receive video through the public voice API. Fluxer's voice SDK can publish video from a file, but there is no receive path. Out of reach today.

### Stage channels and announcement voice

*Rationale:* Stage channels are voice channels with a speaker list.
*Consideration:* The bot would need to request to speak and be approved; the linking code checks for plain voice channels on both sides and would have to accept stage channels and handle suppression state.

### Volume and ducking per direction

*Rationale:* Audio levels differ between platforms and user setups.
*Consideration:* A per-link gain for each direction (`voice_links.gainToDiscord`, `gainToFluxer`) applied in the mixer before soft clipping. The dashboard would need a slider. Automatic ducking (lower one side while the other speaks) is more involved and rarely wanted.

### Entrance sounds and soundboard

*Rationale:* Fluxer plays entrance sounds on join; Discord has a soundboard.
*Consideration:* Entrance sounds arrive as a gateway event with a URL, not as audio, so the bridge would have to download and play them into the other side. Soundboard audio on Discord is sent by the server and is not exposed to bots.

### Stats and metrics

*Rationale:* The stats command and dashboard count channel, thread and category links but say nothing about voice.
*Consideration:* Add the voice link count to `DbStatsService` and the dashboard admin stats, and surface the live bridge list from `VoiceBridgeService.status()` on the guild page. The Prometheus gauge for live bridges already exists.

### Health integration

*Rationale:* A bridge that keeps failing to join should show up in the health endpoint rather than only in logs.
*Consideration:* `HealthCheckService` could include the number of bridges in backoff; repeated join failures on one side probably mean missing permissions, which the bot could report in the voice channel's text chat once.
