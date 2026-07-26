import type { HarnessDescriptor, HarnessModel } from "@pincer/core";
import { type ReactNode, type RefObject, useState } from "react";
import {
	effortPickerOptions,
	harnessInfo,
	modelEfforts,
	modelLabel,
	modelPickerOptions,
} from "@/lib/harness";
import { useActiveCfg, usePincerStore } from "@/state/store";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "./ui/combobox";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "./ui/drawer";

type Container = RefObject<HTMLDivElement | null>;

function Section({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}): ReactNode {
	return (
		<section className="flex flex-col gap-2">
			<span className="text-[11px] font-bold tracking-[0.1em] text-muted-foreground">
				{label}
			</span>
			{children}
		</section>
	);
}

function HarnessCombobox({ container }: { container: Container }): ReactNode {
	const harnesses = usePincerStore((s) => s.harnesses);
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const choose = usePincerStore((s) => s.chooseCfgValue);
	const cfg = useActiveCfg();
	const info = harnessInfo(harnessMap, cfg.harnessId);
	const value = harnesses.find((h) => h.id === cfg.harnessId) ?? null;

	return (
		<Combobox
			items={harnesses}
			value={value}
			onValueChange={(harness: HarnessDescriptor | null) => {
				if (harness) choose("harness", harness.id);
			}}
			itemToStringLabel={(harness: HarnessDescriptor) => harness.label}
			itemToStringValue={(harness: HarnessDescriptor) => harness.label}
		>
			<ComboboxTrigger
				render={
					<Button
						variant="outline"
						className="w-full justify-between gap-2 px-3 font-normal"
					/>
				}
			>
				<span className="flex min-w-0 items-center gap-2">
					<Avatar info={info} size={16} />
					<span className="truncate">{info.label}</span>
				</span>
			</ComboboxTrigger>
			<ComboboxContent container={container}>
				<ComboboxInput showTrigger={false} placeholder="Search harness" />
				<ComboboxEmpty>No harness found.</ComboboxEmpty>
				<ComboboxList>
					{(harness: HarnessDescriptor) => (
						<ComboboxItem
							key={harness.id}
							value={harness}
							disabled={!harness.detected}
							className="gap-2.5 pr-7"
						>
							<Avatar info={harness} size={22} />
							<span className="min-w-0 flex-1 truncate">{harness.label}</span>
							<span className="text-[11px] text-muted-foreground">
								{!harness.detected
									? "unavailable"
									: `${harness.models.length} model${harness.models.length === 1 ? "" : "s"}`}
							</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

function ModelCombobox({ container }: { container: Container }): ReactNode {
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const choose = usePincerStore((s) => s.chooseCfgValue);
	const cfg = useActiveCfg();
	const info = harnessInfo(harnessMap, cfg.harnessId);
	const [query, setQuery] = useState("");
	const models = modelPickerOptions(info.models, cfg.model, query);
	const value = models.find((m) => m.id === cfg.model) ?? null;

	return (
		<Combobox
			items={models}
			value={value}
			onInputValueChange={(input) => setQuery(input)}
			onValueChange={(model: HarnessModel | null) => {
				if (model) {
					choose("model", model.id);
					setQuery("");
				}
			}}
			itemToStringLabel={(model: HarnessModel) => model.label}
			itemToStringValue={(model: HarnessModel) => model.label}
		>
			<ComboboxTrigger
				render={
					<Button
						variant="outline"
						className="w-full justify-between gap-2 px-3 font-normal"
					/>
				}
				disabled={models.length === 0}
			>
				<span className="min-w-0 truncate text-left">
					{modelLabel(info, cfg.model)}
				</span>
			</ComboboxTrigger>
			<ComboboxContent container={container}>
				<ComboboxInput showTrigger={false} placeholder="Search model" />
				<ComboboxEmpty>No model found.</ComboboxEmpty>
				<ComboboxList>
					{(m: HarnessModel) => (
						<ComboboxItem key={m.id} value={m} className="pr-7">
							<span className="min-w-0 flex-1 truncate">{m.label}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

function EffortCombobox({ container }: { container: Container }): ReactNode {
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const choose = usePincerStore((s) => s.chooseCfgValue);
	const cfg = useActiveCfg();
	const info = harnessInfo(harnessMap, cfg.harnessId);
	const [query, setQuery] = useState("");
	const options = effortPickerOptions(
		modelEfforts(info, cfg.model, cfg.effort),
		cfg.effort,
		query,
	);
	const value = options.find((option) => option.id === cfg.effort) ?? null;

	return (
		<Combobox
			items={options}
			itemToStringValue={(option: HarnessModel) => option.label}
			value={value}
			onInputValueChange={(input) => setQuery(input)}
			onValueChange={(option: HarnessModel | null) => {
				if (option) {
					choose("effort", option.id);
					setQuery("");
				}
			}}
		>
			<ComboboxTrigger
				render={
					<Button variant="outline" className="w-full justify-between px-3" />
				}
			>
				<span className="truncate">{value?.label ?? "Default"}</span>
				<span className="text-muted-foreground">⌄</span>
			</ComboboxTrigger>
			<ComboboxContent container={container} className="z-[2147483647]">
				<ComboboxInput placeholder="Search or enter an effort…" />
				<ComboboxEmpty>Type an effort value to use it.</ComboboxEmpty>
				<ComboboxList>
					{(option: HarnessModel) => (
						<ComboboxItem key={option.id} value={option}>
							<span className="truncate">{option.label}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

export function Picker({ container }: { container: Container }): ReactNode {
	const picker = usePincerStore((s) => s.picker);
	const closePicker = usePincerStore((s) => s.closePicker);
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const cfg = useActiveCfg();
	const info = harnessInfo(harnessMap, cfg.harnessId);

	return (
		<Drawer
			open={picker !== null}
			onOpenChange={(open) => {
				if (!open) closePicker();
			}}
		>
			<DrawerContent container={container}>
				<DrawerHeader>
					<DrawerTitle className="text-[11px] font-bold tracking-[0.1em] text-muted-foreground">
						CONFIGURATION
					</DrawerTitle>
				</DrawerHeader>
				<div className="flex flex-col gap-5 px-4 pb-6">
					<Section label="HARNESS">
						<HarnessCombobox container={container} />
					</Section>
					{info.capabilities.model ? (
						<Section label="MODEL">
							<ModelCombobox container={container} />
						</Section>
					) : null}
					{info.capabilities.effort ? (
						<Section label="EFFORT">
							<EffortCombobox container={container} />
						</Section>
					) : null}
				</div>
			</DrawerContent>
		</Drawer>
	);
}
