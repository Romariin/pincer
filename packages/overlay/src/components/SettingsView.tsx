import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DEFAULT_TOGGLE_SHORTCUT } from "@pincer/core";
import { formatShortcut, shortcutFromEvent } from "@/lib/shortcut";
import { usePincerStore } from "@/state/store";
import { Button } from "./ui/button";

export function SettingsView(): ReactNode {
  const connected = usePincerStore((state) => state.connected);
  const shortcut = usePincerStore((state) => state.shortcut);
  const showFloatingButton = usePincerStore((state) => state.showFloatingButton);
  const appRoot = usePincerStore((state) => state.appRoot);
  const appOrigin = usePincerStore((state) => state.appOrigin);
  const settingsLoaded = usePincerStore((state) => state.settingsLoaded);
  const settingsPending = usePincerStore((state) => state.settingsPending);
  const settingsError = usePincerStore((state) => state.settingsError);
  const recordingShortcut = usePincerStore((state) => state.recordingShortcut);
  const startRecordingShortcut = usePincerStore((state) => state.startRecordingShortcut);
  const cancelRecordingShortcut = usePincerStore((state) => state.cancelRecordingShortcut);
  const updateShortcut = usePincerStore((state) => state.updateShortcut);
  const updateShowFloatingButton = usePincerStore((state) => state.updateShowFloatingButton);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const controlsDisabled =
    !connected || !settingsLoaded || settingsPending || appRoot === null || appOrigin === null;

  useEffect(() => {
    if (recordingShortcut) recorder.current?.focus();
  }, [recordingShortcut]);

  const beginRecording = (): void => {
    setCaptureError(null);
    startRecordingShortcut();
  };

  const handleRecorderKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recordingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    const result = shortcutFromEvent(event.nativeEvent);
    if (result.type === "cancel") {
      setCaptureError(null);
      cancelRecordingShortcut();
    } else if (result.type === "invalid") {
      setCaptureError(result.message);
    } else if (result.type === "shortcut") {
      setCaptureError(null);
      updateShortcut(result.shortcut);
    }
  };

  return (
    <div className="pcr-scroll min-h-0 flex-1 overflow-y-auto p-4 pt-[52px]">
      <div className="space-y-6">
        <section aria-labelledby="pincer-shortcut-heading" className="space-y-3">
          <div className="space-y-1">
            <h2 id="pincer-shortcut-heading" className="text-sm font-semibold">
              Keyboard shortcut
            </h2>
            <p className="text-xs text-muted-foreground">Used in every Pincer app.</p>
          </div>
          <div className="flex items-center gap-2">
            <kbd className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground">
              {formatShortcut(shortcut)}
            </kbd>
            <Button
              ref={recorder}
              variant={recordingShortcut ? "default" : "outline"}
              disabled={controlsDisabled}
              aria-pressed={recordingShortcut}
              onClick={beginRecording}
              onKeyDown={handleRecorderKeyDown}
              onBlur={() => cancelRecordingShortcut()}
            >
              {recordingShortcut ? "Press keys…" : "Change"}
            </Button>
            <Button
              variant="ghost"
              disabled={controlsDisabled}
              onClick={() => updateShortcut(DEFAULT_TOGGLE_SHORTCUT)}
            >
              Reset
            </Button>
          </div>
          {captureError && (
            <p className="text-xs text-destructive" role="alert">
              {captureError}
            </p>
          )}
        </section>

        <section aria-labelledby="pincer-launcher-heading" className="space-y-3 border-t border-border pt-5">
          <h2 id="pincer-launcher-heading" className="text-sm font-semibold">
            Launcher
          </h2>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              checked={showFloatingButton}
              disabled={controlsDisabled}
              onChange={(event) => updateShowFloatingButton(event.currentTarget.checked)}
            />
            <span>Show floating button on this site</span>
          </label>
          <div className="space-y-1 rounded-md bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
            <div className="flex min-w-0 gap-2">
              <span className="shrink-0 font-medium text-foreground">App</span>
              <span className="min-w-0 flex-1 truncate" title={appRoot ?? undefined}>
                {appRoot ?? "Unavailable"}
              </span>
            </div>
            <div className="flex min-w-0 gap-2">
              <span className="shrink-0 font-medium text-foreground">Site</span>
              <span className="min-w-0 flex-1 truncate" title={appOrigin ?? undefined}>
                {appOrigin ?? "Unavailable"}
              </span>
            </div>
          </div>
        </section>

        <div className="min-h-5 text-xs" aria-live="polite">
          {!connected && (
            <p className="text-muted-foreground">Connect to the Pincer daemon to change settings.</p>
          )}
          {connected && !settingsLoaded && !settingsError && (
            <p className="text-muted-foreground">Loading settings…</p>
          )}
          {settingsPending && <p className="text-muted-foreground">Saving…</p>}
          {settingsError && (
            <p className="text-destructive" role="alert">
              {settingsError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
