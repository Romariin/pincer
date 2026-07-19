export interface PincerConfig {
  wsUrl?: string;
  contractAVersion?: number;
  projectRoot?: string;
}

declare global {
  interface Window {
    __PINCER__?: PincerConfig;
    __PINCER_LOADED__?: boolean;
  }
}
