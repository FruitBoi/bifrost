import { beforeEach, describe, expect, it } from 'vitest';
import IdentityClaimService, {
    IdentityClaimPrompt,
    IdentityClaimPromptSender,
} from '../../../src/services/identityClaim/IdentityClaimService';
import { runIamCommand } from '../../../src/services/identityClaim/iamCommand';
import { ChannelLink } from '../../../src/db/entities/ChannelLink';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
    makeUserLink,
} from '../../helpers/fakes';

class RecordingSender implements IdentityClaimPromptSender {
    prompts: IdentityClaimPrompt[] = [];
    fail = false;
    async sendPrompt(prompt: IdentityClaimPrompt) {
        if (this.fail) throw new Error('Missing Access');
        this.prompts.push(prompt);
    }
}

describe('IdentityClaimService', () => {
    let links: FakeLinkService;
    let discordSender: RecordingSender;
    let fluxerSender: RecordingSender;
    let service: IdentityClaimService;
    let now: number;
    let channelLink: ChannelLink;

    beforeEach(async () => {
        now = 1_000_000;
        links = new FakeLinkService();
        channelLink = makeChannelLink({ fluxerThreadId: 'fthread' });
        links.links.push(channelLink);
        // Fluxer user fA wrote fmsg1; its Discord copy is dmsg1.
        await links.createMessageLink({
            discordMessageId: 'dmsg1',
            fluxerMessageId: 'fmsg1',
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'fluxer',
            sourceAuthorId: 'fA',
        });
        // Discord user dB wrote dmsg2; its Fluxer copy is fmsg2.
        await links.createMessageLink({
            discordMessageId: 'dmsg2',
            fluxerMessageId: 'fmsg2',
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'discord',
            sourceAuthorId: 'dB',
        });
        discordSender = new RecordingSender();
        fluxerSender = new RecordingSender();
        service = new IdentityClaimService({
            linkService: links.asLinkService(),
            commandPrefix: '!b ',
            now: () => now,
        });
        service.setPromptSender('discord', discordSender);
        service.setPromptSender('fluxer', fluxerSender);
    });

    const claimFromDiscord = (
        repliedMessageId = 'dmsg1',
        userId = 'dU',
        displayName = 'Ada'
    ) =>
        service.claim({
            guildLink,
            platform: 'discord',
            userId,
            displayName,
            repliedMessageId,
        });

    it('sends a prompt on the other platform pinging only the original author', async () => {
        const result = await claimFromDiscord();

        expect(result.kind).toBe('sent');
        expect(discordSender.prompts).toHaveLength(0);
        expect(fluxerSender.prompts).toHaveLength(1);
        const prompt = fluxerSender.prompts[0];
        expect(prompt.targetUserId).toBe('fA');
        // Thread side: the prompt goes to the thread, replying to the original.
        expect(prompt.locationId).toBe('fthread');
        expect(prompt.messageId).toBe('fmsg1');
        expect(prompt.content).toContain('<@fA>');
        expect(prompt.content).toContain('**Ada** on Discord');
        expect(prompt.content).toContain('`!b iam yes`');
        expect(prompt.content).toContain('`!b iam no`');
        expect(prompt.content.match(/<@/g)).toHaveLength(1);
    });

    it('escapes markdown in the claimer display name', async () => {
        await claimFromDiscord('dmsg1', 'dU', '*bold*_name_');
        expect(fluxerSender.prompts[0].content).toContain(
            '**\\*bold\\*\\_name\\_**'
        );
    });

    it('rejects the original message, unbridged messages and unknown sources', async () => {
        await links.createMessageLink({
            discordMessageId: 'dmsg3',
            fluxerMessageId: 'fmsg3',
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
        });
        await links.createMessageLink({
            discordMessageId: 'dmsg4',
            fluxerMessageId: 'fmsg4',
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'fluxer',
        });

        // dmsg2 is the Discord original, not a copy.
        expect((await claimFromDiscord('dmsg2')).kind).toBe('own_platform');
        expect((await claimFromDiscord('nope')).kind).toBe('not_bridged');
        expect((await claimFromDiscord('dmsg3')).kind).toBe('unknown_source');
        expect((await claimFromDiscord('dmsg4')).kind).toBe('no_author');
        expect(fluxerSender.prompts).toHaveLength(0);
        expect(discordSender.prompts).toHaveLength(0);
    });

    it('works from Fluxer towards Discord', async () => {
        const result = await service.claim({
            guildLink,
            platform: 'fluxer',
            userId: 'fU',
            displayName: 'Bea',
            repliedMessageId: 'fmsg2',
        });
        expect(result.kind).toBe('sent');
        expect(discordSender.prompts[0]).toMatchObject({
            locationId: 'dchan',
            messageId: 'dmsg2',
            targetUserId: 'dB',
        });
        expect(discordSender.prompts[0].content).toContain('**Bea** on Fluxer');

        const confirmed = await service.confirm({
            guildLinkId: guildLink.id,
            platform: 'discord',
            userId: 'dB',
        });
        expect(confirmed.kind).toBe('linked');
        expect(links.userLinks).toMatchObject([
            { discordUserId: 'dB', fluxerUserId: 'fU' },
        ]);
    });

    it('refuses when the claimer or the target is mapped to someone else', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'dU', fluxerUserId: 'fOther' })
        );
        const claimer = await claimFromDiscord();
        expect(claimer).toMatchObject({
            kind: 'claimer_mapped',
            mappedTo: { platform: 'fluxer', userId: 'fOther' },
        });

        links.userLinks = [
            makeUserLink({ discordUserId: 'dOther', fluxerUserId: 'fA' }),
        ];
        expect((await claimFromDiscord()).kind).toBe('target_mapped');
        expect(fluxerSender.prompts).toHaveLength(0);
        expect(links.userLinks).toHaveLength(1);
    });

    it('reports an existing identical mapping', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'dU', fluxerUserId: 'fA' })
        );
        expect((await claimFromDiscord()).kind).toBe('already_linked');
        expect(fluxerSender.prompts).toHaveLength(0);
    });

    it('creates the user link when the target confirms', async () => {
        await claimFromDiscord();
        const result = await service.confirm({
            guildLinkId: guildLink.id,
            platform: 'fluxer',
            userId: 'fA',
        });
        expect(result.kind).toBe('linked');
        expect(links.userLinks).toMatchObject([
            {
                guildLinkId: guildLink.id,
                discordUserId: 'dU',
                fluxerUserId: 'fA',
            },
        ]);
        // The claim is used up.
        expect(
            (
                await service.confirm({
                    guildLinkId: guildLink.id,
                    platform: 'fluxer',
                    userId: 'fA',
                })
            ).kind
        ).toBe('no_pending');
    });

    it('does not let anyone but the target confirm', async () => {
        await claimFromDiscord();
        for (const who of [
            { platform: 'fluxer' as const, userId: 'fSomeoneElse' },
            { platform: 'discord' as const, userId: 'dU' },
            { platform: 'discord' as const, userId: 'fA' },
        ]) {
            expect(
                (await service.confirm({ guildLinkId: guildLink.id, ...who }))
                    .kind
            ).toBe('no_pending');
        }
        expect(
            (
                await service.confirm({
                    guildLinkId: 'other-guild-link',
                    platform: 'fluxer',
                    userId: 'fA',
                })
            ).kind
        ).toBe('no_pending');
        expect(links.userLinks).toHaveLength(0);
    });

    it('fails to confirm after expiry or without a claim', async () => {
        const target = {
            guildLinkId: guildLink.id,
            platform: 'fluxer' as const,
            userId: 'fA',
        };
        expect((await service.confirm(target)).kind).toBe('no_pending');

        await claimFromDiscord();
        now += 10 * 60 * 1000;
        expect((await service.confirm(target)).kind).toBe('no_pending');
        expect(links.userLinks).toHaveLength(0);
    });

    it('re-checks conflicts on confirm and never replaces a mapping', async () => {
        await claimFromDiscord();
        links.userLinks.push(
            makeUserLink({ discordUserId: 'dU', fluxerUserId: 'fOther' })
        );
        const result = await service.confirm({
            guildLinkId: guildLink.id,
            platform: 'fluxer',
            userId: 'fA',
        });
        expect(result.kind).toBe('conflict');
        expect(links.userLinks).toMatchObject([
            { discordUserId: 'dU', fluxerUserId: 'fOther' },
        ]);
    });

    it('deny clears the pending claim', async () => {
        await claimFromDiscord();
        const target = {
            guildLinkId: guildLink.id,
            platform: 'fluxer' as const,
            userId: 'fA',
        };
        expect((await service.deny(target)).kind).toBe('denied');
        expect((await service.deny(target)).kind).toBe('no_pending');
        expect((await service.confirm(target)).kind).toBe('no_pending');
    });

    it('a new claim for the same target replaces the old one', async () => {
        await claimFromDiscord('dmsg1', 'dU', 'Ada');
        await claimFromDiscord('dmsg1', 'dV', 'Eve');
        expect(fluxerSender.prompts).toHaveLength(2);

        const status = await service.status({
            guildLinkId: guildLink.id,
            platform: 'fluxer',
            userId: 'fA',
        });
        expect(status.pendingForCaller?.claimer.userId).toBe('dV');

        await service.confirm({
            guildLinkId: guildLink.id,
            platform: 'fluxer',
            userId: 'fA',
        });
        expect(links.userLinks).toMatchObject([
            { discordUserId: 'dV', fluxerUserId: 'fA' },
        ]);
    });

    it('enforces a per-claimer cooldown', async () => {
        expect((await claimFromDiscord()).kind).toBe('sent');
        now += 30_000;
        const second = await claimFromDiscord();
        expect(second).toMatchObject({
            kind: 'cooldown',
            retryAfterMs: 30_000,
        });
        expect(fluxerSender.prompts).toHaveLength(1);
        // Other users are not affected.
        expect((await claimFromDiscord('dmsg1', 'dV')).kind).toBe('sent');
        now += 30_000;
        expect((await claimFromDiscord()).kind).toBe('sent');
    });

    it('drops the claim (and the cooldown) when the prompt cannot be posted', async () => {
        fluxerSender.fail = true;
        const result = await claimFromDiscord();
        expect(result).toMatchObject({
            kind: 'prompt_failed',
            error: 'Missing Access',
        });
        expect(
            (
                await service.confirm({
                    guildLinkId: guildLink.id,
                    platform: 'fluxer',
                    userId: 'fA',
                })
            ).kind
        ).toBe('no_pending');

        fluxerSender.fail = false;
        expect((await claimFromDiscord()).kind).toBe('sent');
    });

    it('fails when no sender is registered for the target platform', async () => {
        service.setPromptSender('fluxer', null);
        expect((await claimFromDiscord()).kind).toBe('prompt_failed');
    });

    it('remove deletes only the caller’s own mapping', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'dU', fluxerUserId: 'fA' }),
            makeUserLink({ discordUserId: 'dX', fluxerUserId: 'fX' })
        );
        const result = await service.remove({
            guildLinkId: guildLink.id,
            platform: 'fluxer',
            userId: 'fA',
        });
        expect(result).toMatchObject({
            kind: 'removed',
            was: { platform: 'discord', userId: 'dU' },
        });
        expect(links.userLinks).toMatchObject([{ discordUserId: 'dX' }]);
        expect(
            (
                await service.remove({
                    guildLinkId: guildLink.id,
                    platform: 'fluxer',
                    userId: 'fA',
                })
            ).kind
        ).toBe('not_linked');
    });

    it('status shows the mapping', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'dU', fluxerUserId: 'fA' })
        );
        expect(
            await service.status({
                guildLinkId: guildLink.id,
                platform: 'discord',
                userId: 'dU',
            })
        ).toEqual({
            linkedTo: { platform: 'fluxer', userId: 'fA' },
            pendingForCaller: null,
        });
    });
});

describe('runIamCommand', () => {
    let links: FakeLinkService;
    let sender: RecordingSender;
    let service: IdentityClaimService;

    beforeEach(async () => {
        links = new FakeLinkService();
        const channelLink = makeChannelLink();
        links.links.push(channelLink);
        await links.createMessageLink({
            discordMessageId: 'dmsg1',
            fluxerMessageId: 'fmsg1',
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'fluxer',
            sourceAuthorId: 'fA',
        });
        sender = new RecordingSender();
        service = new IdentityClaimService({
            linkService: links.asLinkService(),
            commandPrefix: '!b ',
        });
        service.setPromptSender('fluxer', sender);
    });

    const base = {
        platform: 'discord' as const,
        userId: 'dU',
        displayName: 'Ada',
        guildLink,
        repliedMessageId: null,
        args: [] as string[],
    };

    it('claims on a bare reply and shows the status otherwise', async () => {
        const claim = await runIamCommand(service, {
            ...base,
            repliedMessageId: 'dmsg1',
        });
        expect(claim?.description).toContain('expires in 10 minutes');
        expect(sender.prompts).toHaveLength(1);

        const status = await runIamCommand(service, base);
        expect(status?.description).toContain('not linked');
        expect(status?.description).toContain('How to link');
    });

    it('routes yes/confirm, no/deny and remove/unlink', async () => {
        await runIamCommand(service, { ...base, repliedMessageId: 'dmsg1' });
        const fluxer = {
            ...base,
            platform: 'fluxer' as const,
            userId: 'fA',
        };
        const yes = await runIamCommand(service, {
            ...fluxer,
            args: ['confirm'],
        });
        expect(yes?.description).toContain('Linked your Fluxer account');
        expect(links.userLinks).toHaveLength(1);

        const none = await runIamCommand(service, { ...fluxer, args: ['no'] });
        expect(none?.description).toContain('no pending');

        const removed = await runIamCommand(service, {
            ...fluxer,
            args: ['unlink'],
        });
        expect(removed?.description).toContain('Unlinked');
        expect(links.userLinks).toHaveLength(0);
    });

    it('requires a linked server and known arguments', async () => {
        expect(
            (await runIamCommand(service, { ...base, guildLink: null }))
                ?.description
        ).toContain('not linked to a Fluxer server');
        expect(
            await runIamCommand(service, { ...base, args: ['maybe'] })
        ).toBeNull();
    });
});
