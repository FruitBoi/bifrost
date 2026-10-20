import { RESTJSONErrorCodes } from 'discord.js';
import { ChannelLink } from '../../db/entities/ChannelLink';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';

/** A bridged thread pair as reported back to the caller. */
export interface ThreadPairRef {
    discordThreadId: string;
    fluxerThreadId: string;
    /** Name of the Fluxer thread (falls back to the Discord one, then the ID). */
    name: string;
}

export interface ThreadMemberSyncResult {
    /** Thread pairs examined (every link whose both sides are threads). */
    examined: number;
    /** Fluxer threads the user was added to. */
    added: ThreadPairRef[];
    /** Fluxer threads the user was already in. */
    already: ThreadPairRef[];
    /** Fluxer threads the user could not be added to. */
    failed: { thread: ThreadPairRef; reason: string }[];
    /** Discord threads whose membership could not be determined. */
    unchecked: { thread: ThreadPairRef; reason: string }[];
}

type ThreadLookups = Pick<LinkService, 'getChannelLinksForGuildLink'>;
type DiscordThreads = Pick<DiscordEntityResolver, 'fetchThread'>;
type FluxerThreads = Pick<FluxerEntityResolver, 'fetchThread'>;

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isUnknownMemberError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMember
    );
}

/**
 * Carries thread membership across the bridge for one person. Given a
 * Discord user and the Fluxer user that is the same person, every bridged
 * thread pair (a link with both thread IDs set) is checked: when the Discord
 * user is a member of the Discord thread, the Fluxer user is added to the
 * Fluxer counterpart. Used by the Fluxer `role` command so someone moving
 * from Discord lands in the same conversations.
 */
export default class ThreadMemberSyncService {
    constructor(
        private readonly linkService: ThreadLookups,
        private readonly discordEntityResolver: DiscordThreads,
        private readonly fluxerEntityResolver: FluxerThreads
    ) {}

    /** Links whose Discord and Fluxer sides are both threads. */
    private async threadPairs(guildLinkId: string): Promise<ChannelLink[]> {
        const links =
            await this.linkService.getChannelLinksForGuildLink(guildLinkId);
        return links.filter(
            (link) =>
                link.discordThreadId !== null && link.fluxerThreadId !== null
        );
    }

    async addFluxerUserToDiscordUsersThreads({
        guildLinkId,
        discordUserId,
        fluxerUserId,
    }: {
        guildLinkId: string;
        discordUserId: string;
        fluxerUserId: string;
    }): Promise<ThreadMemberSyncResult> {
        const result: ThreadMemberSyncResult = {
            examined: 0,
            added: [],
            already: [],
            failed: [],
            unchecked: [],
        };

        const pairs = await this.threadPairs(guildLinkId);
        result.examined = pairs.length;
        logger.debug(
            `🧵 Checking ${pairs.length} bridged thread pair(s) for Discord user ${discordUserId} → Fluxer user ${fluxerUserId}`
        );

        // Sequential on purpose: this runs from an admin command and a guild
        // can have many bridged threads; bursts would just hit rate limits.
        for (const link of pairs) {
            const discordThreadId = link.discordThreadId!;
            const fluxerThreadId = link.fluxerThreadId!;
            const ref: ThreadPairRef = {
                discordThreadId,
                fluxerThreadId,
                name: fluxerThreadId,
            };

            const discordThread =
                await this.discordEntityResolver.fetchThread(discordThreadId);
            if (!discordThread) {
                result.unchecked.push({
                    thread: ref,
                    reason: 'Discord thread not found',
                });
                continue;
            }
            ref.name = discordThread.name || ref.name;

            let isMember: boolean;
            try {
                await discordThread.members.fetch(discordUserId);
                isMember = true;
            } catch (err) {
                if (isUnknownMemberError(err)) {
                    isMember = false;
                } else {
                    result.unchecked.push({
                        thread: ref,
                        reason: errorMessage(err),
                    });
                    continue;
                }
            }
            if (!isMember) continue;

            const fluxerThread =
                await this.fluxerEntityResolver.fetchThread(fluxerThreadId);
            if (!fluxerThread) {
                result.failed.push({
                    thread: ref,
                    reason: 'Fluxer thread not found',
                });
                continue;
            }
            ref.name = fluxerThread.name || ref.name;

            const alreadyIn = await fluxerThread.members
                .fetchOne(fluxerUserId)
                .then(() => true)
                .catch(() => false);
            if (alreadyIn) {
                result.already.push(ref);
                continue;
            }

            try {
                await fluxerThread.members.add(fluxerUserId);
                result.added.push(ref);
                logger.info(
                    `🧵 Added Fluxer user ${fluxerUserId} to thread ${fluxerThreadId} (${ref.name}), mirroring Discord user ${discordUserId}'s membership in ${discordThreadId}`
                );
            } catch (err) {
                logger.warn(
                    `⚠️ Could not add Fluxer user ${fluxerUserId} to thread ${fluxerThreadId} (${ref.name}):`,
                    err
                );
                result.failed.push({ thread: ref, reason: errorMessage(err) });
            }
        }

        return result;
    }
}
