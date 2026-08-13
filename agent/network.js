// Single source of truth for "which BOT Chain network are we talking to" — shared by
// the agent, the dashboard server, and (via hardhat.config.js network names matching
// these `name` keys) the deploy script. Verified live against both RPCs on 2026-08-13
// via raw eth_chainId calls before being hardcoded here.
const NETWORKS = {
  mainnet: {
    name: "botchain",
    chainId: 677,
    rpcUrl: "https://rpc.botchain.ai",
    explorerUrl: "https://scan.botchain.ai",
  },
  testnet: {
    name: "botchainTestnet",
    chainId: 968,
    rpcUrl: "https://rpc.bohr.life",
    explorerUrl: "https://scan.bohr.life",
  },
};

/// Reads NETWORK from .env ("mainnet" | "testnet"; defaults to "testnet" so a fresh
/// checkout can't accidentally fire a transaction at mainnet before you've deliberately
/// opted in). BOTCHAIN_RPC_URL, if set, overrides the preset RPC for whichever network
/// is selected — handy if you're running your own node or a proxy.
function resolveNetwork() {
  const key = (process.env.NETWORK || "testnet").toLowerCase();
  const preset = NETWORKS[key];
  if (!preset) {
    throw new Error(`Unknown NETWORK "${key}" in .env — use "mainnet" or "testnet".`);
  }
  // Each network has its OWN override var (BOTCHAIN_RPC_URL for mainnet,
  // BOTCHAIN_TESTNET_RPC_URL for testnet) so setting one to point at a custom node
  // can never silently leak into the other network's resolution — this is exactly
  // the class of bug a single shared override var would invite.
  const rpcOverride = key === "mainnet" ? process.env.BOTCHAIN_RPC_URL : process.env.BOTCHAIN_TESTNET_RPC_URL;
  return {
    ...preset,
    rpcUrl: rpcOverride || preset.rpcUrl,
  };
}

module.exports = { NETWORKS, resolveNetwork };
