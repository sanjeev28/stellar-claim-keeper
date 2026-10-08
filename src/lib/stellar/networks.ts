export type NetworkPreset = {
  id: string;
  label: string;
  horizon: string;
  passphrase: string;
  nativeCode: string;
  explorerTx: (hash: string) => string;
  /** SLIP-10 coin type used for mnemonic derivation */
  coinType: number;
};

export const NETWORKS: NetworkPreset[] = [
  {
    id: "pi-mainnet",
    label: "Pi Mainnet",
    horizon: "https://api.mainnet.minepi.com",
    passphrase: "Pi Network",
    nativeCode: "Pi",
    explorerTx: (h) => `https://blockexplorer.minepi.com/mainnet/transactions/${h}`,
    coinType: 314159,
  },
  {
    id: "pi-testnet",
    label: "Pi Testnet",
    horizon: "https://api.testnet.minepi.com",
    passphrase: "Pi Testnet",
    nativeCode: "Test-Pi",
    explorerTx: (h) => `https://blockexplorer.minepi.com/testnet/transactions/${h}`,
    coinType: 314159,
  },
  {
    id: "stellar-public",
    label: "Stellar Public",
    horizon: "https://horizon.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
    nativeCode: "XLM",
    explorerTx: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
    coinType: 148,
  },
  {
    id: "stellar-testnet",
    label: "Stellar Testnet",
    horizon: "https://horizon-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    nativeCode: "XLM",
    explorerTx: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
    coinType: 148,
  },
];

export const STROOPS = 10_000_000;
export const toUnits = (stroops: number) => stroops / STROOPS;
export const toStroops = (units: number) => Math.round(units * STROOPS);

/** Competitive per-op fee tiers, in native units. */
export const FEE_TIERS = {
  standard: { label: "Standard", perOp: 1 },
  high: { label: "High", perOp: 5 },
  ultra: { label: "Ultra Sniper", perOp: 10 },
} as const;
export const CUSTOM_FEE_DEFAULT = 6;
export const CUSTOM_FEE_MAX = 25;
export const ESCALATION_CAP_DEFAULT = 15;

/** Example extra endpoints (Pi core / Horizon nodes) shown as hints. */
export const ENDPOINT_HINTS = ["http://194.233.69.78:31401", "http://82.197.68.80:31401"];
