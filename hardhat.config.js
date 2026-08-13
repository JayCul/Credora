require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { NETWORKS } = require("./agent/network");

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Both RPCs verified live via raw eth_chainId calls on 2026-08-13, matching the
    // official quick-start docs (dev-docs.botchain.ai) — not guessed.
    [NETWORKS.mainnet.name]: {
      url: process.env.BOTCHAIN_RPC_URL || NETWORKS.mainnet.rpcUrl,
      chainId: NETWORKS.mainnet.chainId,
      accounts,
    },
    [NETWORKS.testnet.name]: {
      url: process.env.BOTCHAIN_TESTNET_RPC_URL || NETWORKS.testnet.rpcUrl,
      chainId: NETWORKS.testnet.chainId,
      accounts,
    },
  },
  etherscan: {
    // Both explorers are Blockscout-based. If they expose a Blockscout verification
    // API, point this at it so `npx hardhat verify` works; harmless to leave unset if
    // you verify manually through the UI instead.
    apiKey: {
      [NETWORKS.mainnet.name]: process.env.BOTCHAIN_EXPLORER_API_KEY || "not-required",
      [NETWORKS.testnet.name]: process.env.BOTCHAIN_TESTNET_EXPLORER_API_KEY || "not-required",
    },
    customChains: [
      {
        network: NETWORKS.mainnet.name,
        chainId: NETWORKS.mainnet.chainId,
        urls: {
          apiURL: process.env.BOTCHAIN_EXPLORER_API_URL || "https://api-scan.botchain.ai/api",
          browserURL: NETWORKS.mainnet.explorerUrl,
        },
      },
      {
        network: NETWORKS.testnet.name,
        chainId: NETWORKS.testnet.chainId,
        urls: {
          apiURL: process.env.BOTCHAIN_TESTNET_EXPLORER_API_URL || "https://api-scan.bohr.life/api",
          browserURL: NETWORKS.testnet.explorerUrl,
        },
      },
    ],
  },
};
