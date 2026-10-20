import {
    Combobox,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
} from '@/components/ui/combobox';
import {
    Dialog,
    DialogClose,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { toastManager } from '@/components/ui/toast';
import { ArrowLeftRight, MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import type { ChannelLinkSummary } from '../../../src/web/types';
import { useChannelThreads, useCreateThreadLink } from '../api/client';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

type ThreadOption = { label: string; value: string };

export function LinkThreadDialog({
    guildLinkId,
    channelLink,
}: {
    guildLinkId: string;
    channelLink: ChannelLinkSummary;
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const { data, isLoading } = useChannelThreads(channelLink.id, open);
    const createThreadLink = useCreateThreadLink(guildLinkId);

    const discordOptions: ThreadOption[] = (
        data?.unlinkedDiscordThreads ?? []
    ).map((t) => ({ label: t.name, value: t.id }));
    const fluxerOptions: ThreadOption[] = (
        data?.unlinkedFluxerThreads ?? []
    ).map((t) => ({ label: t.name, value: t.id }));

    const selectedDiscord =
        discordOptions.find((o) => o.value === discordId) ?? null;
    const selectedFluxer =
        fluxerOptions.find((o) => o.value === fluxerId) ?? null;

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) {
                    setDiscordId(null);
                    setFluxerId(null);
                }
            }}
        >
            <DialogTrigger
                render={
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Link a thread in #${channelLink.discordChannel.name}`}
                    />
                }
            >
                <MessageSquareText aria-hidden="true" />
                Link thread
            </DialogTrigger>
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Link a thread</DialogTitle>
                    <DialogDescription>
                        Pair an active thread in #
                        {channelLink.discordChannel.name} with one in #
                        {channelLink.fluxerChannel.name}. Messages and renames
                        will be mirrored between them.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    {isLoading || !data ? (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                            <Skeleton className="h-9 rounded-md" />
                            <div className="hidden sm:block" />
                            <Skeleton className="h-9 rounded-md" />
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium">
                                    Discord thread
                                </label>
                                <Combobox
                                    items={discordOptions}
                                    value={selectedDiscord}
                                    onValueChange={(item) =>
                                        setDiscordId(item?.value ?? null)
                                    }
                                >
                                    <ComboboxInput
                                        placeholder="Search Discord threads..."
                                        startAddon={
                                            <MessageSquareText
                                                aria-hidden="true"
                                                className="size-4.5"
                                            />
                                        }
                                    />
                                    <ComboboxPopup>
                                        <ComboboxEmpty>
                                            No unlinked active Discord threads.
                                        </ComboboxEmpty>
                                        <ComboboxList>
                                            {(item: ThreadOption) => (
                                                <ComboboxItem
                                                    key={item.value}
                                                    value={item}
                                                >
                                                    {item.label}
                                                </ComboboxItem>
                                            )}
                                        </ComboboxList>
                                    </ComboboxPopup>
                                </Combobox>
                            </div>

                            <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                                <ArrowLeftRight
                                    aria-hidden="true"
                                    className="size-5"
                                />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium">
                                    Fluxer thread
                                </label>
                                <Combobox
                                    items={fluxerOptions}
                                    value={selectedFluxer}
                                    onValueChange={(item) =>
                                        setFluxerId(item?.value ?? null)
                                    }
                                >
                                    <ComboboxInput
                                        placeholder="Search Fluxer threads..."
                                        startAddon={
                                            <MessageSquareText
                                                aria-hidden="true"
                                                className="size-4.5"
                                            />
                                        }
                                    />
                                    <ComboboxPopup>
                                        <ComboboxEmpty>
                                            No unlinked active Fluxer threads.
                                        </ComboboxEmpty>
                                        <ComboboxList>
                                            {(item: ThreadOption) => (
                                                <ComboboxItem
                                                    key={item.value}
                                                    value={item}
                                                >
                                                    {item.label}
                                                </ComboboxItem>
                                            )}
                                        </ComboboxList>
                                    </ComboboxPopup>
                                </Combobox>
                            </div>
                        </div>
                    )}
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={!discordId || !fluxerId}
                        loading={createThreadLink.isPending}
                        onClick={() => {
                            if (!discordId || !fluxerId) return;
                            createThreadLink.mutate(
                                {
                                    channelLinkId: channelLink.id,
                                    discordThreadId: discordId,
                                    fluxerThreadId: fluxerId,
                                },
                                {
                                    onSuccess: () => {
                                        toastManager.add({
                                            type: 'success',
                                            title: 'Threads linked',
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            type: 'error',
                                            title: 'Could not link threads',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link threads
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}
