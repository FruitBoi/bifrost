import {
    Combobox,
    ComboboxCollection,
    ComboboxEmpty,
    ComboboxGroup,
    ComboboxGroupLabel,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
    ComboboxSeparator,
} from '@/components/ui/combobox';
import type {
    UnlinkedChannelSummary,
    UnlinkedThreadSummary,
} from '../../../src/web/types';
import { Fragment, useState } from 'react';
import { useCreateChannelLink } from '../api/client';
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
import { ArrowLeftRight, Hash, MessageSquareText, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { toastManager } from '@/components/ui/toast';

type TargetOption = {
    label: string;
    value: string;
    kind: 'channel' | 'thread';
};

type TargetOptionGroup = {
    key: string;
    label: string | null;
    items: TargetOption[];
};

/**
 * Channels grouped by category, followed by active threads grouped by their
 * parent channel.
 */
function groupTargetOptions(
    channels: UnlinkedChannelSummary[],
    threads: UnlinkedThreadSummary[]
): TargetOptionGroup[] {
    const groups: TargetOptionGroup[] = [];
    const byKey = new Map<string, TargetOptionGroup>();

    for (const channel of channels) {
        const key = `category:${channel.categoryId ?? '__uncategorized__'}`;
        let group = byKey.get(key);
        if (!group) {
            group = { key, label: channel.categoryName ?? null, items: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.items.push({
            label: channel.name,
            value: channel.id,
            kind: 'channel',
        });
    }

    for (const thread of threads) {
        const key = `threads:${thread.parentId}`;
        let group = byKey.get(key);
        if (!group) {
            group = {
                key,
                label: `Threads · #${thread.parentName}`,
                items: [],
            };
            byKey.set(key, group);
            groups.push(group);
        }
        group.items.push({
            label: thread.name,
            value: thread.id,
            kind: 'thread',
        });
    }

    return groups;
}

function TargetCombobox({
    label,
    placeholder,
    emptyText,
    groups,
    value,
    onChange,
}: {
    label: string;
    placeholder: string;
    emptyText: string;
    groups: TargetOptionGroup[];
    value: string | null;
    onChange: (value: string | null) => void;
}) {
    const selected =
        groups.flatMap((g) => g.items).find((i) => i.value === value) ?? null;

    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{label}</label>
            <Combobox
                items={groups}
                value={selected}
                onValueChange={(item) => onChange(item?.value ?? null)}
            >
                <ComboboxInput
                    placeholder={placeholder}
                    startAddon={
                        selected?.kind === 'thread' ? (
                            <MessageSquareText
                                aria-hidden="true"
                                className="size-4.5"
                            />
                        ) : (
                            <Hash aria-hidden="true" className="size-4.5" />
                        )
                    }
                />
                <ComboboxPopup>
                    <ComboboxEmpty>{emptyText}</ComboboxEmpty>
                    <ComboboxList>
                        {(group: TargetOptionGroup, index: number) => (
                            <Fragment key={group.key}>
                                {index > 0 && <ComboboxSeparator />}
                                <ComboboxGroup items={group.items}>
                                    {group.label && (
                                        <ComboboxGroupLabel>
                                            {group.label}
                                        </ComboboxGroupLabel>
                                    )}
                                    <ComboboxCollection>
                                        {(item: TargetOption) => (
                                            <ComboboxItem
                                                key={item.value}
                                                value={item}
                                            >
                                                {item.kind === 'thread' ? (
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <MessageSquareText
                                                            aria-hidden="true"
                                                            className="text-muted-foreground size-3.5"
                                                        />
                                                        {item.label}
                                                    </span>
                                                ) : (
                                                    <>#{item.label}</>
                                                )}
                                            </ComboboxItem>
                                        )}
                                    </ComboboxCollection>
                                </ComboboxGroup>
                            </Fragment>
                        )}
                    </ComboboxList>
                </ComboboxPopup>
            </Combobox>
        </div>
    );
}

export function CreateChannelLinkDialog({
    guildLinkId,
    discordChannels,
    fluxerChannels,
    discordThreads,
    fluxerThreads,
}: {
    guildLinkId: string;
    discordChannels: UnlinkedChannelSummary[];
    fluxerChannels: UnlinkedChannelSummary[];
    discordThreads: UnlinkedThreadSummary[];
    fluxerThreads: UnlinkedThreadSummary[];
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const createChannelLink = useCreateChannelLink();

    const discordGroups = groupTargetOptions(discordChannels, discordThreads);
    const fluxerGroups = groupTargetOptions(fluxerChannels, fluxerThreads);

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
            <DialogTrigger render={<Button />}>
                <Plus aria-hidden="true" />
                Link a channel
            </DialogTrigger>
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Link a channel or thread</DialogTitle>
                    <DialogDescription>
                        Messages posted on either side will be mirrored to the
                        other. Each side can be a channel or a thread.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <TargetCombobox
                            label="Discord channel or thread"
                            placeholder="Search Discord channels and threads..."
                            emptyText="No unlinked Discord channels or threads."
                            groups={discordGroups}
                            value={discordId}
                            onChange={setDiscordId}
                        />

                        <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                            <ArrowLeftRight
                                aria-hidden="true"
                                className="size-5"
                            />
                        </div>

                        <TargetCombobox
                            label="Fluxer channel or thread"
                            placeholder="Search Fluxer channels and threads..."
                            emptyText="No unlinked Fluxer channels or threads."
                            groups={fluxerGroups}
                            value={fluxerId}
                            onChange={setFluxerId}
                        />
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={!discordId || !fluxerId}
                        loading={createChannelLink.isPending}
                        onClick={() => {
                            if (!discordId || !fluxerId) return;
                            createChannelLink.mutate(
                                {
                                    guildLinkId,
                                    discordTargetId: discordId,
                                    fluxerTargetId: fluxerId,
                                },
                                {
                                    onSuccess: () => {
                                        toastManager.add({
                                            type: 'success',
                                            title: 'Linked',
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            type: 'error',
                                            title: 'Could not create link',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}
