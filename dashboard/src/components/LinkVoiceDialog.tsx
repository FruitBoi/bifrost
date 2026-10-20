import {
    Combobox,
    ComboboxCollection,
    ComboboxEmpty,
    ComboboxGroup,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
} from '@/components/ui/combobox';
import type { ChannelSummary } from '../../../src/web/types';
import { useState } from 'react';
import { useCreateVoiceLink, useVoiceChannels } from '../api/client';
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
import { ArrowLeftRight, Volume2 } from 'lucide-react';
import { Button } from './ui/button';
import { toastManager } from '@/components/ui/toast';

type Option = { label: string; value: string };
type OptionGroup = { key: string; label: string | null; items: Option[] };

function VoiceChannelCombobox({
    label,
    placeholder,
    emptyText,
    channels,
    value,
    onChange,
    disabled,
}: {
    label: string;
    placeholder: string;
    emptyText: string;
    channels: ChannelSummary[];
    value: string | null;
    onChange: (value: string | null) => void;
    disabled?: boolean;
}) {
    const items: Option[] = channels.map((c) => ({
        label: c.name,
        value: c.id,
    }));
    const groups: OptionGroup[] = [{ key: 'voice', label: null, items }];
    const selected = items.find((i) => i.value === value) ?? null;

    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{label}</label>
            <Combobox
                items={groups}
                value={selected}
                onValueChange={(item) => onChange(item?.value ?? null)}
                disabled={disabled}
            >
                <ComboboxInput
                    placeholder={placeholder}
                    startAddon={
                        <Volume2 aria-hidden="true" className="size-4.5" />
                    }
                />
                <ComboboxPopup>
                    <ComboboxEmpty>{emptyText}</ComboboxEmpty>
                    <ComboboxList>
                        {(group: OptionGroup) => (
                            <ComboboxGroup key={group.key} items={group.items}>
                                <ComboboxCollection>
                                    {(item: Option) => (
                                        <ComboboxItem
                                            key={item.value}
                                            value={item}
                                        >
                                            {item.label}
                                        </ComboboxItem>
                                    )}
                                </ComboboxCollection>
                            </ComboboxGroup>
                        )}
                    </ComboboxList>
                </ComboboxPopup>
            </Combobox>
        </div>
    );
}

/**
 * Bridges one Discord voice channel with one Fluxer voice channel. Voice
 * channels that are already part of a voice link are hidden.
 */
export function LinkVoiceDialog({
    guildLinkId,
    linkedDiscordChannelIds,
    linkedFluxerChannelIds,
}: {
    guildLinkId: string;
    linkedDiscordChannelIds: string[];
    linkedFluxerChannelIds: string[];
}) {
    const [open, setOpen] = useState(false);
    const [discordId, setDiscordId] = useState<string | null>(null);
    const [fluxerId, setFluxerId] = useState<string | null>(null);
    const voiceChannels = useVoiceChannels(guildLinkId, open);
    const createVoiceLink = useCreateVoiceLink(guildLinkId);

    const discordChannels = (voiceChannels.data?.discord ?? []).filter(
        (c) => !linkedDiscordChannelIds.includes(c.id)
    );
    const fluxerChannels = (voiceChannels.data?.fluxer ?? []).filter(
        (c) => !linkedFluxerChannelIds.includes(c.id)
    );

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
            <DialogTrigger render={<Button variant="outline" />}>
                <Volume2 aria-hidden="true" />
                Link voice
            </DialogTrigger>
            <DialogPopup className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Link voice channels</DialogTitle>
                    <DialogDescription>
                        Audio in the Discord voice channel is relayed into the
                        Fluxer voice channel and vice versa. Each voice channel
                        can be linked once, and only one voice link per server
                        pair can be live at a time, because the bot can only sit
                        in one voice channel per server.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="flex flex-col gap-4">
                    {voiceChannels.isError && (
                        <p className="text-destructive text-sm">
                            Could not load voice channels:{' '}
                            {voiceChannels.error.message}
                        </p>
                    )}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr]">
                        <VoiceChannelCombobox
                            label="Discord voice channel"
                            placeholder={
                                voiceChannels.isLoading
                                    ? 'Loading...'
                                    : 'Search Discord voice channels...'
                            }
                            emptyText="No unlinked Discord voice channels."
                            channels={discordChannels}
                            value={discordId}
                            onChange={setDiscordId}
                            disabled={voiceChannels.isLoading}
                        />

                        <div className="text-muted-foreground hidden items-center justify-center pt-7 sm:flex">
                            <ArrowLeftRight
                                aria-hidden="true"
                                className="size-5"
                            />
                        </div>

                        <VoiceChannelCombobox
                            label="Fluxer voice channel"
                            placeholder={
                                voiceChannels.isLoading
                                    ? 'Loading...'
                                    : 'Search Fluxer voice channels...'
                            }
                            emptyText="No unlinked Fluxer voice channels."
                            channels={fluxerChannels}
                            value={fluxerId}
                            onChange={setFluxerId}
                            disabled={voiceChannels.isLoading}
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
                        loading={createVoiceLink.isPending}
                        onClick={() => {
                            if (!discordId || !fluxerId) return;
                            createVoiceLink.mutate(
                                {
                                    discordChannelId: discordId,
                                    fluxerChannelId: fluxerId,
                                },
                                {
                                    onSuccess: (result) => {
                                        toastManager.add({
                                            type: 'success',
                                            title: 'Voice channels linked',
                                            description: `${result.discordChannelName ?? 'Discord'} ↔ ${result.fluxerChannelName ?? 'Fluxer'}`,
                                        });
                                        setOpen(false);
                                    },
                                    onError: (err) =>
                                        toastManager.add({
                                            type: 'error',
                                            title: 'Could not link voice channels',
                                            description: err.message,
                                        }),
                                }
                            );
                        }}
                    >
                        Link voice
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}
