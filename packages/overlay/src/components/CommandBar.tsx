import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { usePincerStore, useCfg } from "@/state/store";
import {
	effortLabel,
	harnessInfo,
	modelEfforts,
	modelLabel,
} from "@/lib/harness";
import { Avatar } from "./Avatar";

export function CommandBar(): ReactNode {
	const cfg = useCfg();
	const harnessMap = usePincerStore((s) => s.harnessMap);
	const openPicker = usePincerStore((s) => s.openPicker);
	const info = harnessInfo(harnessMap, cfg.harnessId);
	const efforts = modelEfforts(info, cfg.model, cfg.effort);

	return (
		<button
			type="button"
			onClick={() => openPicker("harness")}
			className="flex w-full shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2.5 text-left text-[12.5px] transition-colors hover:bg-muted/40"
		>
			<Avatar info={info} size={18} />
			<span className="shrink-0 font-semibold text-foreground">
				{info.label}
			</span>
			{info.models.length > 0 && cfg.model ? (
				<>
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
					<span className="min-w-0 truncate text-muted-foreground">
						{modelLabel(info, cfg.model)}
					</span>
				</>
			) : null}
			{efforts.length > 0 && cfg.effort ? (
				<>
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
					<span className="shrink-0 font-semibold text-primary">
						{effortLabel(cfg.effort)}
					</span>
				</>
			) : null}
			<ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground/70" />
		</button>
	);
}
