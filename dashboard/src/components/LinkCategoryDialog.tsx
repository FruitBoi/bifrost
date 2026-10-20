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
    ChannelSummary,
    UnlinkedChannelSummary,
} from '../../../src/web/types';
import { Fragment, useState } from 'react';
import { useCreateCategoryLink } from '../api/client';
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
import { ArrowRight, FolderOpen, Hash } from 'lucide-react';
import { Button } from './ui/button';
import { toastManager } from '@/components/ui/toast';

type Option = { label: string; value: string };
type OptionGroup = { key: string; label: string | null; items: Option[] };

/** Fluxer channels grouped by their category, in display order. */
function groupFluxerChannels(
    channels: UnlinkedChannelSummary[]
): OptionGroup[] {
    const groups: OptionGroup[] = [];
    const byKey = new Map<string, OptionGroup>();
    for (const channel of channels) {
        const key = channel.categoryId ?? '__uncategorized__';
        let group = byKey.get(key);
        if (!group) {
            group = { key, label: channel.categoryName ?? null, items: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.items.push({ label: channel.name, value: channel.id });
    }
    return groups;
}

function OptionCombobox({
    label,
    placeholder,
    emptyText,
    groups,
    value,
    onChange,
    icon,
    itemPrefix,
}: {
    label: string;
    placeholder: string;
    emptyText: string;
    groups: OptionGroup[];
    value: string | null;
    onChange: (value: string | null) => void;
    icon: React.ReactNode;
    itemPrefix: string;
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
                <ComboboxInput placeholder={placeholder} startAddon={icon} />
                <ComboboxPopup>
                    <ComboboxEmpty>{emptyText}</ComboboxEmpty>
                    <ComboboxList>
                        {(group: OptionGroup, index: number) => (
                            <Fragment key={group.key}>
                                {index > 0 && <ComboboxSeparator />}
                                <ComboboxGroup items={group.items}>
                                    {group.label && (
                                        <ComboboxGroupLabel>
                                            {group.label}
                                        </ComboboxGroupLabel>
                                    )}
                                    <ComboboxCollection>
                                        {(item: Option) => (
                                            <ComboboxItem
                                                key={item.value}
                                                value={item}
                                            >
                                                {itemPrefix}
                                                {item.label}
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

/**
 * Bridges every text channel of a Discord category to a thread inside one
 * Fluxer channel.
 */
export function LinkCategoryDialog({
    guildLinkId,
    categories,
    fluxerChannels,
    disabled,
}: {
    guildLinkId: string;
    categories: ChannelSummary[];
    fluxerChannels: UnlinkedChannelSummary[];
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [categoryId, setCategoryId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const createCategoryLink = useCreateCategoryLink(guildLinkId);

    const categoryGroups: OptionGroup[] = [
        {
            key: 'categories',
            label: null,
            items: categories.map((c) => ({ label: c.name, value: c.id })),
        },
    ];
    const fluxerGroups = groupFluxerChannels(fluxerChannels);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) {
                    setCategoryId(null);
                    setFluxerId(null);
                }
            }}
        >
            <DialogTrigger
                render={<Button variant="outline" disabled={disabled} />}
            >
                <FolderOpen aria-hidden="true" />
                Link a category
            </DialogTrigger>
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Link a category</DialogTitle>
                    <DialogDescription>
                        Every text channel in the Discord category becomes a
                        thread inside the chosen Fluxer channel. Channels added
                        to the category later are bridged automatically.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <OptionCombobox
                            label="Discord category"
                            placeholder="Search Discord categories..."
                            emptyText="No unlinked Discord categories."
                            groups={categoryGroups}
                            value={categoryId}
                            onChange={setCategoryId}
                            icon={
                                <FolderOpen
                                    aria-hidden="true"
                                    className="size-4.5"
                                />
                            }
                            itemPrefix=""
                        />

                        <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                            <ArrowRight aria-hidden="true" className="size-5" />
                        </div>

                        <OptionCombobox
                            label="Fluxer channel"
                            placeholder="Search Fluxer channels..."
                            emptyText="No unlinked Fluxer channels."
                            groups={fluxerGroups}
                            value={fluxerId}
                            onChange={setFluxerId}
                            icon={
                                <Hash aria-hidden="true" className="size-4.5" />
                            }
                            itemPrefix="#"
                        />
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost" />}>
                        Cancel
                    </DialogClose>
                    <Button
                        type="button"
                        disabled={!categoryId || !fluxerId}
                        loading={createCategoryLink.isPending}
                        onClick={() => {
                            if (!categoryId || !fluxerId) return;
                            createCategoryLink.mutate(
                                {
                                    discordCategoryId: categoryId,
                                    fluxerChannelId: fluxerId,
                                },
                                {
                                    onSuccess: (result) => {
                                        toastManager.add({
                                            type: 'success',
                                            title: 'Category linked',
                                            description: `Bridged ${result.linked} channel${result.linked === 1 ? '' : 's'} (${result.skipped} skipped)`,
                                        });
                                        if (result.failed.length > 0) {
                                            toastManager.add({
                                                type: 'error',
                                                title: `${result.failed.length} channel${result.failed.length === 1 ? '' : 's'} could not be bridged`,
                                                description: result.failed
                                                    .map(
                                                        (f) =>
                                                            `${f.channelName}: ${f.reason}`
                                                    )
                                                    .join('\n'),
                                            });
                                        }
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            type: 'error',
                                            title: 'Could not link category',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link category
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}
