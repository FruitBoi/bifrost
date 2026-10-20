# Voice bridge spike: findings

Findings from wiring `@discordjs/voice` and `@fluxerjs/voice` into Bifröst
(branch `feat/voice-bridge`). Everything below was established by reading the
installed package sources in `node_modules` and by running the codec in the
`node:20` container. Nothing has been exercised against live Discord or
Fluxer servers yet; see "Still to verify live" at the end.

Versions inspected: `@discordjs/voice@0.19.2`, `@discordjs/opus@0.10.0`,
`@snazzah/davey@0.1.12`, `sodium-native@5.2.0`, `@fluxerjs/voice@3.1.0`,
`@fluxerjs/core@3.3.0`, `@livekit/rtc-node@0.13.35`.

## Frame contract

Everything crossing `VoiceTransport` / `AudioMixer` is one 20 ms Opus frame at
48 kHz stereo (960 samples per channel, 1920 interleaved int16 samples, 3840
bytes of PCM). Discord natively speaks exactly this. Fluxer/LiveKit does not,
so the Fluxer transport converts (details below).

## How `@fluxerjs/voice` works internally

`getVoiceManager(client)` returns a per-client singleton `VoiceManager`
(WeakMap keyed on the client). Its constructor registers listeners on the
client for `Events.VoiceStateUpdate`, `VoiceServerUpdate`, `VoiceStateAck`
and `VoiceStatesSync`, so it must be created before `client.login()` or it
misses the voice states delivered with READY/GUILD_CREATE.
`FluxerVoiceTransport`'s constructor calls it; the integrator must construct
the transport before logging in.

`voiceManager.join(channel)` sends gateway opcode 4 (VoiceStateUpdate) with a
`mutation_id`, waits for `VoiceServerUpdate` (20 s timeout) and, depending on
the endpoint, creates one of two connection classes:

- `LiveKitRtcConnection` when the endpoint looks like a LiveKit URL
  (`access_token=` or `/rtc?...`, or a bare host with a token). This is the
  path Fluxer uses today. It opens a LiveKit `Room` via `@livekit/rtc-node`
  (`room.connect(url, token, { autoSubscribe: true, dynacast: false })`).
- `VoiceConnection` (legacy Discord-style WebSocket + UDP with
  `tweetnacl`), otherwise. It has no receive API.

### Receive path (LiveKit)

`LiveKitRtcConnection` is receive-capable. On `RoomEvent.TrackSubscribed`
for an audio track it creates an `AudioStream(track, { sampleRate: 48000,
numChannels: 1, frameSizeMs: 10 })` and pumps it, emitting

```ts
conn.emit('audioFrame', {
    participantId,
    trackSid,
    sampleRate,
    channels,
    samples: Int16Array,
});
```

for every frame. So the receive path delivers **decoded PCM, 48 kHz, mono,
10 ms (480 samples)**, not Opus.

**Frames are only pumped for identities that were explicitly requested.**
`subscribeParticipantTrack` returns early unless
`requestedSubscriptions.has(participant.identity)` (the `TrackSubscribed`
handler never passes `autoSubscribe`), and `requestedSubscriptions` is only
filled by `conn.subscribeParticipantAudio(participantId, { autoResubscribe })`.
The LiveKit room itself is joined with `autoSubscribe: true`, so the SFU
_does_ deliver every audio track; the package just ignores the ones nobody
asked for. `autoResubscribe: true` keeps a request alive across
`TrackUnsubscribed` / `ParticipantDisconnected`.

#### Subscription strategy (why Discord heard silence)

The first implementation requested audio only for the Fluxer user IDs in
our own gateway voice-state cache (`transport.listParticipants`, fed by
`VoiceStatesSync` / `VoiceStateUpdate`). That silently fails in two ways,
either of which produces exactly "Fluxer hears Discord, Discord hears
nothing":

1. the LiveKit identity is not the bare Fluxer user ID (e.g.
   `userId:connectionId`), so the request key never matches a participant;
2. the voice-state cache is empty or stale at join time (`VoiceStatesSync`
   only fires from GUILD_CREATE payloads that carry `voice_states`;
   `VoiceStateUpdate` requires the gateway to send it; states for people
   already in the channel may arrive after `join()` resolves).

`FluxerVoiceSession` now drives subscriptions **from the LiveKit room**,
which is the source of truth for who is actually publishing audio:

- `VoiceManager.join()` resolves only after `conn.connect()` →
  `room.connect()` finished, so at `init()` the room is connected and
  `room.remoteParticipants` is populated (rtc-node fills it from the
  connect callback before `connect()` resolves). We reach the room with the
  same reflective `getRoom(conn)` accessor the send path already uses.
- On init we iterate `room.remoteParticipants` and call
  `subscribeParticipantAudio(identity, { autoResubscribe: true })` for every
  identity that is not the bot's (compared against both
  `room.localParticipant.identity` and `transport.botUserId()`).
- We also listen on the room for `ParticipantConnected`, `TrackPublished`
  and `TrackSubscribed` (all three request audio for that identity;
  requesting is idempotent per identity), `ParticipantDisconnected` (stops
  our subscription) and `Reconnected` (re-scans the room). rtc-node sets
  `publication.track` _before_ emitting `TrackSubscribed`, and the
  package's own `TrackSubscribed` handler is registered first, so by the
  time our handler calls `subscribeParticipantAudio` the track is there and
  the pump starts immediately.
- If `getRoom(conn)` ever returns null (upstream renamed the field) we fall
  back to the old voice-state driven requests and log a warning.
- Gateway `participantUpdate` events are no longer used to subscribe or
  unsubscribe (when the room is reachable); they are forwarded to the bridge
  unchanged and used to refresh identity → user ID mappings.

The session then upmixes mono to stereo, accumulates two 10 ms frames into
one 20 ms frame per identity, encodes with a per-identity `@discordjs/opus`
`OpusEncoder(48000, 2)`, and emits `audio(sourceId, packet)` where
`sourceId` is the mapped Fluxer user ID when possible (see below). Frames at
a sample rate other than 48 kHz are dropped with a one-time warning (the
AudioStream is asked for 48 kHz so this should not occur).

`FluxerVoiceSession.stats()` returns
`{ framesIn: number; packetsOut: number; participants: number }`: decoded
PCM frames received from LiveKit, 20 ms Opus packets emitted as `audio`
events, and the number of remote participants currently in the LiveKit room
(bot excluded).

### Send path (LiveKit)

`LiveKitRtcConnection.playOpus()` is **not implemented** upstream; it only
emits `error("LiveKit: playOpus not supported; use play(url) with a
WebM/Opus URL")`. `play()` demuxes WebM with prism-media, decodes with the
WASM `opus-decoder`, and publishes a **mono** `AudioSource(48000, 1)`.

Rather than mux our Opus into WebM to feed `play()` (encode → mux → demux →
WASM decode), `FluxerVoiceSession` publishes its own track directly with
`@livekit/rtc-node`:

```ts
const source = new AudioSource(48000, 2);
const track = LocalAudioTrack.createAudioTrack('bifrost-bridge', source);
const opts = new TrackPublishOptions();
opts.source = TrackSource.SOURCE_MICROPHONE;
await room.localParticipant.publishTrack(track, opts);
// per sendOpus(): decode Opus -> Int16Array(1920) -> source.captureFrame(new AudioFrame(pcm, 48000, 2, 960))
```

This requires the connection's LiveKit `Room`, which is a `private room`
field on `LiveKitRtcConnection`. We read it reflectively
(`(conn as unknown as { room: Room | null }).room`). This is the main
upstream coupling risk: a future `@fluxerjs/voice` rename breaks sending.
A cleaner fix is an upstream PR implementing `playOpus` for LiveKit (decode
Opus into the existing `AudioSource`), which is small given `play()` already
has the code.

For this to work, `@livekit/rtc-node` had to become a direct dependency so we
can import `AudioSource` etc. It is pinned to `^0.13.35`, the version
`@fluxerjs/voice` resolves, so pnpm dedupes to a single copy; the FFI handles
would not be shared across two copies.

Outbound backpressure: if `source.queuedDuration > 400 ms` we drop the frame
(the mixer emits silence frames continuously, so this only triggers when the
process stalls).

### Send path (legacy UDP `VoiceConnection`)

`VoiceConnection.playOpus(stream)` exists: it reads raw Opus packets from a
Node stream (`'data'` chunks) and paces them at 20 ms over UDP. We feed it an
object-mode `PassThrough`. There is no receive API on this class, so sessions
on it are send-only (logged as a warning).

### Identity mapping

`LiveKitRtcConnection.getParticipantId(participant)` returns
`participant.identity`, and the package's own
`subscribeChannelParticipants` passes Fluxer **user IDs** from gateway voice
states straight into `subscribeParticipantAudio(participantId)`. So the
package assumes LiveKit identity == Fluxer user ID. **This is still
unverified live**: nothing in `@fluxerjs/core`, `@fluxerjs/voice` or
`@fluxerjs/types` reveals how Fluxer mints LiveKit tokens, so the identity
format is unknown until we see it in logs. Note also that the old
"unexpected participant" fallback in `handleAudioFrame` could never fire:
the package emits no `audioFrame` at all for identities that were not
requested, so an identity mismatch produced silence, not a debug line.

We no longer depend on the assumption. Subscriptions are keyed by LiveKit
identity (above), and `src/services/voice/fluxer/identity.ts` maps an
identity back to a Fluxer user ID best-effort for the bridge's mute/leave
bookkeeping (`setSourceMuted` / `removeSource` in `VoiceBridgeService` are
keyed by user ID):

1. if the identity equals a user ID in the channel's voice states, use it;
2. else split on `:`, `-`, `_`, `.`, `/` and use the first token that is a
   known user ID;
3. else emit audio under the raw identity string. The mixer only needs a
   stable key; mute mapping simply will not apply to that source.

Audio is never dropped because an identity is unfamiliar. The mapping is
re-evaluated whenever a voice state for the channel arrives, so an identity
that could not be mapped at join time (empty cache) is upgraded to the user
ID later (`Identity "…" now maps to user …`). The bot's own identity is
recognised via `room.localParticipant.identity` and via the same
token-matching against `transport.botUserId()`.

#### Log lines to look for in the next live test

All at INFO unless noted, all tagged `[FluxerVoice]`:

- `🔗 LiveKit room "<name>" for <channelId> (join; state CONN_CONNECTED); local identity "<id>", bot user <id> (identity == user id | identity embeds user id | identity format differs from user id!); N remote participant(s); M user(s) in voice-state cache`
    - This line answers the identity question: compare the local identity
      with the bot user ID. `M` tells whether the voice-state cache was
      populated at join time.
- `📡 Remote participant "<identity>": maps to user <id> | no known user id, bridging under raw identity; N audio track(s), S subscribed` — one per
  remote participant at join and on reconnect.
- `📡 Published bridge audio track <sid> to LiveKit room for <channelId>`
- `📡 Participant "<identity>" joined LiveKit room …` / `👋 Participant "<identity>" left LiveKit room …`
- `🎧 First audio frame from "<identity>" in <channelId>: 48000 Hz, 1 ch, 480 samples/frame, track <sid>; emitting as source <id>` — the key line:
  if it appears, Fluxer audio is reaching the session and the remaining
  suspect is the Discord send path.
- `🎧 Audio from unrequested participant …` — should not appear; means the
  package started pumping something we did not request.
- WARN `⚠️ No audio received from LiveKit 5s after joining <channelId> although N remote participant(s) are present: "<identity>" (requested | NOT requested, N audio track(s), S subscribed), …` — fires once per
  session. "requested, 1 audio track, 1 subscribed" with no frames points
  at the AudioStream pump; "0 audio track(s)" means the client is not
  publishing (muted, or the Fluxer client publishes only while speaking).
  If nobody spoke in those 5 s the warning is benign.
- `👋 Session <channelId> closed (<reason>); received F frames → P packets, sent S frames, dropped D` — end-of-session totals from `stats()`.
- DEBUG: `🎧 Requested audio from "<identity>" (<why>)`, `📡 Audio track … published by …`, `📡 Subscribed to audio track …`.

The package itself also prints `[voice LiveKitRtc] connected to room` via
`console.error`, and `VOICE_DEBUG=1` adds per-frame output.

### Voice states

`VoiceManager.voiceStates` only caches `guild -> user -> channelId`. The
transport keeps its own `guild -> user -> { channelId, selfMute, selfDeaf,
isBot }` cache from `VoiceStatesSync` (READY/GUILD_CREATE) and
`VoiceStateUpdate`, so `listParticipants` can report mute/deaf and
`participantUpdate` can carry `previousChannelId`. Fluxer voice-state
payloads carry no bot flag (`APIUserPartial` has no `bot`); `isBot` comes
from `client.users` / guild member caches and is best effort.

The `VoiceStateUpdate` handler emits `participantUpdate` for the bot's own
state too. The session closes itself (`closed('moved')`) when the bot's
channel changes away from the session's channel.

### Things in `@fluxerjs/voice` worth knowing

- It logs via `console.error('[voice LiveKitRtc]', ...)` unconditionally for
  connection events, and more with `VOICE_DEBUG=1`.
- `LiveKitRtcConnection` emits `serverLeave` then `disconnect` (via
  `setImmediate`) when the room disconnects; the `VoiceManager` drops the
  connection from its map on `disconnect`. We close the session on both.
- `VoiceManager.leave(guildId)` leaves every channel in the guild;
  `leaveChannel(channelId)` leaves one. The session uses `leaveChannel`
  (equivalent here since `join` rejects when already elsewhere in the guild).
- `node-webcodecs` and `livekit-server-sdk` are optional dependencies used
  only for `playVideo`. `node-webcodecs` is `await import()`ed lazily, so its
  skipped build script is harmless. Do not add it to `onlyBuiltDependencies`.

## Duplicate `@fluxerjs/core` resolution

`@fluxerjs/voice@3.1.0` pins `@fluxerjs/core@3.1.0`, `@fluxerjs/types@3.1.0`
and `@fluxerjs/util@3.1.0` exactly, while the project uses core `^3.3.0`.
Without intervention pnpm installed both core 3.1.0 and 3.3.0.

At runtime the voice package only uses `Events.*` string constants from core,
`client.on/emit/user/sendToGateway`, `GatewayOpcodes.VoiceStateUpdate` (= 4)
from types, and `FluxerError`/`ErrorCodes` from util. The voice event names
are identical in 3.1.0 and 3.3.0, so a duplicate would probably have worked,
but the TypeScript `Client` type from core 3.1.0 would not have matched ours.

Fix applied in `pnpm-workspace.yaml`:

```yaml
overrides:
    '@fluxerjs/voice>@fluxerjs/core': '^3.3.0'
    '@fluxerjs/voice>@fluxerjs/types': '^3.3.0'
    '@fluxerjs/voice>@fluxerjs/util': '^3.1.0'
```

After `pnpm install` the lockfile records the overrides and
`@fluxerjs/voice@3.1.0` depends on core `3.3.0` / types `3.3.0` / util
`3.1.0`; `node_modules/.pnpm/@fluxerjs+voice.../node_modules/@fluxerjs/core`
symlinks to core 3.3.0 and `@fluxerjs/core@3.1.0` no longer appears in
`pnpm-lock.yaml`. (A stale `.pnpm/@fluxerjs+core@3.1.0` directory may linger
in an existing `node_modules`; a fresh install does not create it.)
`@fluxerjs/types@3.0.0`/`3.1.0` and `@fluxerjs/util@3.0.0` remain because
other existing dependencies (`@fluxerjs/builders@3.0.0`, `@fluxerjs/rest`,
`@fluxerjs/ws`) pin them; that predates this work.

The override should be revisited whenever `@fluxerjs/voice` is bumped; a
release that targets core 3.3.x makes it unnecessary.

## Native dependencies and build scripts

| Package             | Role                                                          | Native?                                              | Notes                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@discordjs/opus`   | Opus encode/decode (mixer, Fluxer transcode)                  | yes, node-gyp / node-pre-gyp                         | No prebuilt binary was downloaded for node 20 glibc 2.36 in the container; it compiled from the bundled libopus (needs python3, make, g++). Build script must be allowed (see below). |
| `sodium-native`     | Discord transport encryption                                  | yes, prebuilt (`node-gyp-build`)                     | Loaded fine without a build step.                                                                                                                                                     |
| `@snazzah/davey`    | Discord DAVE E2EE (MLS)                                       | yes, prebuilt napi (`davey-linux-x64-gnu` / `-musl`) | `@discordjs/voice` `require`s it at load time and enables DAVE automatically (`daveEncryption` defaults to true).                                                                     |
| `@livekit/rtc-node` | LiveKit client used by `@fluxerjs/voice` and our publish path | yes, prebuilt FFI (`rtc-ffi-bindings-linux-x64-gnu`) | glibc only; no musl build, so Alpine images are out.                                                                                                                                  |
| `node-webcodecs`    | `@fluxerjs/voice` video only (optional)                       | yes, prebuilt + install script                       | Not needed; build script intentionally left blocked.                                                                                                                                  |

pnpm 10 blocks dependency build scripts unless allow-listed. The project's
allow-list lives in `pnpm-workspace.yaml` (`onlyBuiltDependencies`), which
already had `sqlite3` and `esbuild`; `@discordjs/opus` was added. (pnpm 10
reads this from the workspace file, so it is not duplicated in
`package.json`.) After the first install the binding still had to be built
with `pnpm rebuild @discordjs/opus` because the package directory already
existed; a fresh `pnpm install` with the allow-list runs it directly.

Verified in `node:20` (Debian bookworm, glibc 2.36):

```
node -e "const {OpusEncoder}=require('@discordjs/opus'); ..."  -> opus ok, silence frame bytes 3, decoded bytes 3840
node -e "require('@fluxerjs/voice'); require('@discordjs/voice'); require('@livekit/rtc-node')" -> loads on v20.20.2
```

### Node version

`@fluxerjs/core` declares `engines.node >= 22.13.0`, `@discordjs/voice`
`>= 22.12.0`. The Dockerfile uses `node:20-slim`. Everything loads and the
Opus tests pass on Node 20.20, and pnpm only warns on engine mismatches, but
the libraries are not tested upstream on 20. Moving the image to
`node:22-slim` is recommended before relying on voice in production.

### Dockerfile changes required (not applied)

1. `pnpm-workspace.yaml` is already copied via the `pnpm-workspace.yaml*`
   glob, so the new `onlyBuiltDependencies` entry and the overrides reach the
   image. Nothing to change for that.
2. `python3`, `make`, `g++` are already installed and are required for
   `@discordjs/opus` (it compiled from source in the container).
3. Recommended: `FROM node:22-slim` (see above).
4. `@livekit/rtc-node` ships only glibc binaries; keep a Debian-based image.
5. Nothing new to expose with `EXPOSE`; see network below.

## Network / UDP requirements

- Discord voice: outbound WSS to `*.discord.media` plus outbound UDP to the
  voice server IP on a high port (IP discovery, then RTP). No inbound ports.
  The container needs outbound UDP allowed; Docker's default bridge network
  permits this. Discord receive (SSRC mapping) requires the
  `GuildVoiceStates` intent on the discord.js client.
- Fluxer via LiveKit: outbound WSS to the LiveKit endpoint from
  `VoiceServerUpdate`, then WebRTC media over UDP (ICE/STUN/DTLS/SRTP) to the
  LiveKit SFU, falling back to TCP/TURN if the SFU offers it. Again outbound
  only; a symmetric NAT is fine for a client. If the host blocks outbound
  UDP, LiveKit may still connect over TCP but with worse latency.
- Fluxer legacy UDP voice connection: outbound UDP to the endpoint/port from
  the voice WebSocket, same shape as Discord.

## Implementation notes per file

- `src/services/voice/OpusMixer.ts`: decodes on `push` with a per-source
  decoder, re-chunks to 1920-sample frames (so 10/40 ms remote packets work),
  per-source jitter buffer (prime at 2 frames, cap 10, drop oldest), a
  `setTimeout`-based drift-corrected 20 ms scheduler on `performance.now()`
  (skips ahead if more than 100 ms behind rather than bursting), Int32 sum,
  soft clip (linear to 80% full scale, tanh knee above), one shared encoder,
  cached encoded silence frame. `tick()` is public for tests. No Opus PLC:
  `@discordjs/opus`'s `decode()` requires a Buffer and would run PLC for its
  internal `MAX_FRAME_SIZE`, not 20 ms, so a missing frame is just skipped.
- `src/services/voice/discord/DiscordVoiceTransport.ts`: as specified.
  Permission check (`Connect` + `Speak`) and already-elsewhere check before
  `joinVoiceChannel`; `entersState(Ready, 20 s)`; outbound via an object-mode
  `PassThrough` + `createAudioResource(StreamType.Opus)` on a
  `NoSubscriberBehavior.Play` player (`maxMissedFrames` 250 so it tolerates a
  5 s gap; if it still goes Idle, playback is restarted on the same stream);
  outbound backlog capped at 50 frames; inbound subscriptions created on
  `receiver.speaking 'start'` with `EndBehaviorType.Manual`; reconnect dance
  (`Signalling`/`Connecting` within 5 s, else destroy and `closed`).
- `src/services/voice/fluxer/FluxerVoiceTransport.ts`: described above;
  receive subscriptions are driven by the LiveKit room's participant and
  track events, inbound state is keyed by LiveKit identity, and
  `FluxerVoiceSession.stats()` exposes receive counters.
- `src/services/voice/fluxer/identity.ts`: pure identity → user ID mapping
  helpers (unit-tested in `test/services/voice/FluxerIdentity.test.ts`).

## Still to verify live (with real bot tokens)

Discord:

1. Join a voice channel with the bot and confirm `entersState(Ready)`
   resolves; check `generateDependencyReport()` output in logs shows
   `@discordjs/opus`, `sodium-native` and `@snazzah/davey` detected.
2. Speak in the channel; confirm `audio(userId, packet)` events arrive with
   ~50 packets/s per speaker, and that DAVE decryption works (no
   `decryptionFailure` spam in the connection debug output).
3. Feed the mixer output back; confirm the bot is audible and does not
   stutter (the player must never fall Idle; grep logs for
   `Player went idle`).
4. Move the bot between channels / change region and confirm the session
   either recovers (`is reconnecting`) or emits `closed('disconnected')`.
5. Kick the bot from voice and confirm `closed`.

Fluxer:

1. Construct `FluxerVoiceTransport` before `client.login()` and confirm
   `VoiceStatesSync` populates `listParticipants` after READY. The
   `🔗 LiveKit room …` join line reports `M user(s) in voice-state cache`;
   `0` while people are in the channel means the cache is not being fed
   (the bridge's occupancy counting in `VoiceBridgeService` relies on it,
   even though audio no longer does).
2. Join a voice channel and confirm `voiceManager.join` resolves with a
   `LiveKitRtcConnection`. If the legacy UDP warning
   (`⚠️ Channel … uses the legacy UDP voice connection`) appears instead,
   receive is unsupported and this document's assumptions need revisiting.
3. Confirm `📡 Published bridge audio track …` is logged and the bot shows
   an audio track in the channel (other clients see it "speaking" when the
   mixer carries sound). This validates the reflective `room` access.
4. Have a human speak; confirm `🎧 First audio frame from "<identity>" …:
48000 Hz, 1 ch, 480 samples/frame` appears and note whether the identity
   maps to the speaker's Fluxer user ID (`emitting as source <userId>`) or
   is bridged under the raw identity. If the `⚠️ No audio received from
LiveKit 5s after joining` warning fires while someone is talking, read
   its per-identity `requested / audio track(s) / subscribed` breakdown to
   locate where the chain breaks (see "Log lines to look for").
5. Confirm the resulting Opus packets decode cleanly on the Discord side (no
   `Dropping undecodable packet` lines from the mixer).
6. Confirm `leave()` unpublishes the track and the bot disappears from the
   channel, and that a LiveKit token expiry produces `serverLeave` →
   `closed('serverLeave')`.
7. Check CPU: per Fluxer speaker we run one Opus encoder, plus one decoder
   per source in the mixer and one decoder for Fluxer outbound; measure with
   two or three concurrent speakers.
8. Check whether Fluxer's gateway requires the voice state `self_mute: false`
   bot to be shown as unmuted; `VoiceManager.join` always sends
   `self_mute: false, self_deaf: false`.
