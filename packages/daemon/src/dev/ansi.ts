const ESC = String.fromCharCode(27);

export const CSI = `${ESC}[`;
export const RESET = `${CSI}0m`;
export const CURSOR_HIDE = `${CSI}?25l`;
export const CURSOR_SHOW = `${CSI}?25h`;
export const CLEAR_EOL = `${CSI}K`;

/** Strips SGR color sequences. Built from ESC so no control character sits in the source. */
export const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
