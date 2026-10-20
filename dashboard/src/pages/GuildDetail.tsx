import { Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
    ArrowLeft,
    CornerDownRight,
    MessageSquareText,
    PackageOpen,
    Trash,
} from 'lucide-react';
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
    useDeleteThreadLink,
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
import { LinkThreadDialog } from '../components/LinkThreadDialog';

export function GuildDetail() {
    const { guildLinkId } = useParams<{ guildLinkId: string }>();
    const { data, isLoading } = useGuildChannels(guildLinkId);
    const deleteChannelLink = useDeleteChannelLink(guildLinkId);
    const deleteThreadLink = useDeleteThreadLink(guildLinkId);
    const updateChannelLink = useUpdateChannelLink(guildLinkId);

    const content = (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <Button render={<Link to="/" />} variant="ghost" size="sm">
                    <ArrowLeft aria-hidden="true" />
                    Back
                </Button>
                {data && (
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
                        />
                    </div>
                )}
            </div>

            {isLoading || !data ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Discord channel</TableHead>
                            <TableHead>Fluxer channel</TableHead>
                            <TableHead className="whitespace-nowrap">
                                Auto-sync threads
                            </TableHead>
                            <TableHead className="w-px" />
                        </TableRow>
                    </TableHeader>
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
                            You haven't linked any Discord channels to Fluxer
                            channels yet.
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
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
                            />
                        </div>
                    </EmptyContent>
                </Empty>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Discord channel</TableHead>
                            <TableHead>Fluxer channel</TableHead>
                            <TableHead className="whitespace-nowrap">
                                Auto-sync threads
                            </TableHead>
                            <TableHead className="w-px" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.linked.map((link) => (
                            <Fragment key={link.id}>
                                <TableRow>
                                    <TableCell className="whitespace-nowrap">
                                        #{link.discordChannel.name}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                        #{link.fluxerChannel.name}
                                    </TableCell>
                                    <TableCell>
                                        <Switch
                                            aria-label={`Automatically bridge new threads in #${link.discordChannel.name}`}
                                            checked={link.autoSyncThreads}
                                            disabled={
                                                updateChannelLink.isPending &&
                                                updateChannelLink.variables
                                                    ?.channelLinkId === link.id
                                            }
                                            onCheckedChange={(checked) =>
                                                updateChannelLink.mutate(
                                                    {
                                                        channelLinkId: link.id,
                                                        autoSyncThreads:
                                                            checked,
                                                    },
                                                    {
                                                        onError: (err) =>
                                                            toastManager.add({
                                                                type: 'error',
                                                                title: 'Could not update thread sync',
                                                                description:
                                                                    err.message,
                                                            }),
                                                    }
                                                )
                                            }
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center justify-end gap-1">
                                            <LinkThreadDialog
                                                guildLinkId={guildLinkId!}
                                                channelLink={link}
                                            />
                                            <Button
                                                aria-label="Unlink channel"
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
                                                                        title: 'Could not unlink channel',
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
                                {link.threads.map((thread) => (
                                    <TableRow
                                        key={thread.id}
                                        className="bg-muted/30"
                                    >
                                        <TableCell className="whitespace-nowrap">
                                            <span className="text-muted-foreground inline-flex items-center gap-1.5 pl-4">
                                                <CornerDownRight
                                                    aria-hidden="true"
                                                    className="size-3.5"
                                                />
                                                <MessageSquareText
                                                    aria-hidden="true"
                                                    className="size-3.5"
                                                />
                                                <span className="text-foreground">
                                                    {thread.discordThread.name}
                                                </span>
                                            </span>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            <span className="text-muted-foreground inline-flex items-center gap-1.5">
                                                <MessageSquareText
                                                    aria-hidden="true"
                                                    className="size-3.5"
                                                />
                                                <span className="text-foreground">
                                                    {thread.fluxerThread.name}
                                                </span>
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-xs">
                                            Thread
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex justify-end">
                                                <Button
                                                    aria-label="Unlink thread"
                                                    variant="destructive-outline"
                                                    size="icon-sm"
                                                    loading={
                                                        deleteThreadLink.isPending &&
                                                        deleteThreadLink.variables ===
                                                            thread.id
                                                    }
                                                    onClick={() =>
                                                        deleteThreadLink.mutate(
                                                            thread.id,
                                                            {
                                                                onError: (
                                                                    err
                                                                ) =>
                                                                    toastManager.add(
                                                                        {
                                                                            title: 'Could not unlink thread',
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
                                ))}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
            )}
        </div>
    );

    return <Layout requiredAuth="either">{content}</Layout>;
}
