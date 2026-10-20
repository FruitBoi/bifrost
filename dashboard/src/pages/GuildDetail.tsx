import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquareText, PackageOpen, Trash } from 'lucide-react';
import type {
    ChannelLinkSummary,
    ChannelSummary,
} from '../../../src/web/types';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { toastManager } from '@/components/ui/toast';
import {
    useDeleteChannelLink,
    useGuildChannels,
    useUpdateChannelLink,
} from '@/api/client';
import { Layout } from '../components/Layout';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '../components/ui/empty';
import { CreateChannelLinkDialog } from '../components/CreateChannelLinkDialog';
import { AutolinkDialog } from '../components/AutolinkDialog';

/** `#channel` for a channel side, or a thread icon with `#parent › thread`. */
function LocationCell({
    channel,
    thread,
}: {
    channel: ChannelSummary;
    thread: ChannelSummary | null;
}) {
    if (!thread) return <>#{channel.name}</>;
    return (
        <span className="inline-flex items-center gap-1.5">
            <MessageSquareText
                aria-hidden="true"
                className="text-muted-foreground size-3.5 shrink-0"
            />
            <span className="text-muted-foreground">#{channel.name} ›</span>
            <span>{thread.name}</span>
        </span>
    );
}

function describeLink(link: ChannelLinkSummary): string {
    const discord = link.discordThread
        ? `${link.discordThread.name} (in #${link.discordChannel.name})`
        : `#${link.discordChannel.name}`;
    const fluxer = link.fluxerThread
        ? `${link.fluxerThread.name} (in #${link.fluxerChannel.name})`
        : `#${link.fluxerChannel.name}`;
    return `${discord} ↔ ${fluxer}`;
}

export function GuildDetail() {
    const { guildLinkId } = useParams<{ guildLinkId: string }>();
    const { data, isLoading } = useGuildChannels(guildLinkId);
    const deleteChannelLink = useDeleteChannelLink(guildLinkId);
    const updateChannelLink = useUpdateChannelLink(guildLinkId);

    const dialogs = data && (
        <div className="flex gap-2">
            <AutolinkDialog
                guildLinkId={guildLinkId!}
                disabled={
                    data.unlinkedDiscordChannels.length === 0 ||
                    data.unlinkedFluxerChannels.length === 0
                }
            />
            <CreateChannelLinkDialog
                guildLinkId={guildLinkId!}
                discordChannels={data.unlinkedDiscordChannels}
                fluxerChannels={data.unlinkedFluxerChannels}
                discordThreads={data.unlinkedDiscordThreads}
                fluxerThreads={data.unlinkedFluxerThreads}
            />
        </div>
    );

    const header = (
        <TableHeader>
            <TableRow>
                <TableHead>Discord</TableHead>
                <TableHead>Fluxer</TableHead>
                <TableHead className="whitespace-nowrap">
                    Auto-sync threads
                </TableHead>
                <TableHead className="w-px" />
            </TableRow>
        </TableHeader>
    );

    const content = (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <Button render={<Link to="/" />} variant="ghost" size="sm">
                    <ArrowLeft aria-hidden="true" />
                    Back
                </Button>
                {dialogs}
            </div>

            {isLoading || !data ? (
                <Table>
                    {header}
                    <TableBody>
                        {[0, 1, 2].map((i) => (
                            <TableRow key={i}>
                                <TableCell>
                                    <Skeleton className="h-4 w-24 rounded-md" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-24 rounded-md" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-5 w-9 rounded-full" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="size-8 rounded-lg" />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : data.linked.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <PackageOpen />
                        </EmptyMedia>
                        <EmptyTitle>No bridged channels</EmptyTitle>
                        <EmptyDescription>
                            You haven't linked any Discord channels or threads
                            to Fluxer yet.
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>{dialogs}</EmptyContent>
                </Empty>
            ) : (
                <Table>
                    {header}
                    <TableBody>
                        {data.linked.map((link) => {
                            const isChannelPair =
                                !link.discordThread && !link.fluxerThread;
                            return (
                                <TableRow key={link.id}>
                                    <TableCell className="whitespace-nowrap">
                                        <LocationCell
                                            channel={link.discordChannel}
                                            thread={link.discordThread}
                                        />
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                        <LocationCell
                                            channel={link.fluxerChannel}
                                            thread={link.fluxerThread}
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <span
                                            title={
                                                isChannelPair
                                                    ? undefined
                                                    : 'Only available on channel-to-channel links'
                                            }
                                        >
                                            <Switch
                                                aria-label={`Automatically bridge new threads for ${describeLink(link)}`}
                                                checked={link.autoSyncThreads}
                                                disabled={
                                                    !isChannelPair ||
                                                    (updateChannelLink.isPending &&
                                                        updateChannelLink
                                                            .variables
                                                            ?.channelLinkId ===
                                                            link.id)
                                                }
                                                onCheckedChange={(checked) =>
                                                    updateChannelLink.mutate(
                                                        {
                                                            channelLinkId:
                                                                link.id,
                                                            autoSyncThreads:
                                                                checked,
                                                        },
                                                        {
                                                            onError: (err) =>
                                                                toastManager.add(
                                                                    {
                                                                        type: 'error',
                                                                        title: 'Could not update thread sync',
                                                                        description:
                                                                            err.message,
                                                                    }
                                                                ),
                                                        }
                                                    )
                                                }
                                            />
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex justify-end">
                                            <Button
                                                aria-label={`Unlink ${describeLink(link)}`}
                                                variant="destructive-outline"
                                                size="icon-sm"
                                                loading={
                                                    deleteChannelLink.isPending &&
                                                    deleteChannelLink.variables ===
                                                        link.id
                                                }
                                                onClick={() =>
                                                    deleteChannelLink.mutate(
                                                        link.id,
                                                        {
                                                            onError: (err) =>
                                                                toastManager.add(
                                                                    {
                                                                        title: 'Could not unlink',
                                                                        description:
                                                                            err.message,
                                                                    }
                                                                ),
                                                        }
                                                    )
                                                }
                                            >
                                                <Trash aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            )}
        </div>
    );

    return <Layout requiredAuth="either">{content}</Layout>;
}
