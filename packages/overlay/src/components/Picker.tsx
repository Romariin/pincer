import {
	useState,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from "react";
import type { HarnessDescriptor, HarnessModel } from "@pincer/core";
import { usePincerStore, useCfg } from "@/state/store";
import {
	effortLabel,
	harnessInfo,
	modelEfforts,
	modelLabel,
	modelPickerOptions,
} from "@/lib/harness";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "./ui/drawer";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "./ui/combobox";

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
	const choose = usePincerStore((s) => s.choose);
	const cfg = useCfg();
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
	const choose = usePincerStore((s) => s.choose);
	const cfg = useCfg();
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

function EffortSlider({
	list,
	value,
	onCommit,
}: {
	list: string[];
	value: string;
	onCommit: (v: string) => void;
}): ReactNode {
	const n = list.length;
	const idx = Math.max(0, list.indexOf(value));
	const listKey = list.join("\u0000");
	const [drag, setDrag] = useState<{
		index: number;
		listKey: string;
		value: string;
	} | null>(null);
	const shown =
		drag?.listKey === listKey && drag.value === value ? drag.index : idx;
	const at = (i: number): number => (i / (n - 1)) * 100;
	const tickStyle = (i: number): CSSProperties => ({
		left: `${at(i)}%`,
		transform: "translate(-50%,-50%)",
	});
	const labelStyle = (i: number): CSSProperties => ({
		left: `${at(i)}%`,
		transform: "translateX(-50%)",
	});

	return (
		<div className="px-6 pt-1">
			<div className="relative">
				<div className="pointer-events-none absolute inset-0 z-10">
					{list.map((e, i) => (
						<span
							key={e}
							style={tickStyle(i)}
							className={cn(
								"absolute top-1/2 h-2 w-0.5 rounded-full",
								i <= shown
									? "bg-primary-foreground/70"
									: "bg-muted-foreground/50",
							)}
						/>
					))}
				</div>
				<Slider
					min={0}
					max={n - 1}
					step={1}
					value={[shown]}
					onValueChange={(v) => {
						setDrag({
							index: Array.isArray(v) ? (v[0] ?? 0) : v,
							listKey,
							value,
						});
					}}
					onValueCommitted={(v) => {
						const i = Array.isArray(v) ? (v[0] ?? 0) : v;
						setDrag(null);
						onCommit(list[i] ?? value);
					}}
				/>
			</div>
			<div className="relative mt-3 h-4">
				{list.map((e, i) => (
					<button
						key={e}
						type="button"
						style={labelStyle(i)}
						onClick={() => onCommit(e)}
						className={cn(
							"absolute top-0 cursor-pointer text-[10px] leading-none whitespace-nowrap transition-colors hover:text-foreground",
							i === shown
								? "font-semibold text-primary"
								: "text-muted-foreground",
						)}
					>
						{effortLabel(e)}
					</button>
				))}
			</div>
		</div>
	);
}

export function Picker({ container }: { container: Container }): ReactNode {
	const picker = usePincerStore((s) => s.picker);
	const closePicker = usePincerStore((s) => s.closePicker);
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const choose = usePincerStore((s) => s.choose);
	const cfg = useCfg();
	const info = harnessInfo(harnessMap, cfg.harnessId);
	const effortList = modelEfforts(info, cfg.model, cfg.effort);

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
					{info.capabilities.effort && effortList.length > 1 ? (
						<Section label="EFFORT">
							<EffortSlider
								list={effortList}
								value={cfg.effort}
								onCommit={(value) => choose("effort", value)}
							/>
						</Section>
					) : null}
				</div>
			</DrawerContent>
		</Drawer>
	);
}
