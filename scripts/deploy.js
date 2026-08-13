const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { NETWORKS } = require("../agent/network");
const { syncAbi } = require("./syncAbi");

function explorerBaseFor(networkName) {
  const preset = Object.values(NETWORKS).find((n) => n.name === networkName);
  return preset?.explorerUrl || null;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer available — set DEPLOYER_PRIVATE_KEY in .env (see .env.example)."
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  console.log(`Network:  ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} BOT`);
  if (balance === 0n) {
    const isTestnet = hre.network.name === NETWORKS.testnet.name;
    console.warn(
      isTestnet
        ? "⚠️  Deployer has zero balance — fund this address from https://faucet.botchain.ai/basic before continuing."
        : "⚠️  Deployer has zero balance — mainnet BOT has no faucet; acquire it via https://dex.botchain.ai before continuing."
    );
  }

  // ADMIN_ADDRESS should ideally be a multisig; AGENT_ADDRESS is the hot wallet the
  // WhatsApp agent process (agent/contractClient.js) will sign transactions with.
  // Both default to the deployer for a fast hackathon setup — tighten before real use.
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address;
  const agentAddress = process.env.AGENT_ADDRESS || deployer.address;

  console.log(`Admin:    ${adminAddress}`);
  console.log(`Agent:    ${agentAddress}`);

  const ReceiptLedger = await hre.ethers.getContractFactory("ReceiptLedger");
  const ledger = await ReceiptLedger.deploy(adminAddress, agentAddress);
  await ledger.waitForDeployment();

  const address = await ledger.getAddress();
  const deployTx = ledger.deploymentTransaction();
  const deployReceipt = deployTx ? await deployTx.wait() : null;
  const explorerBase = explorerBaseFor(hre.network.name);
  console.log(`\n✅ ReceiptLedger deployed: ${address}`);
  console.log(`   Tx hash: ${deployTx?.hash}`);
  if (explorerBase) console.log(`   Explorer: ${explorerBase}/address/${address}`);

  // Recorded so the dashboard can scan ReceiptIssued events starting from this block
  // instead of from genesis — on a chain with tens of millions of blocks already,
  // scanning from zero would be prohibitively slow.
  const deploymentInfo = {
    address,
    admin: adminAddress,
    agent: agentAddress,
    network: hre.network.name,
    chainId: network.chainId.toString(),
    txHash: deployTx?.hash ?? null,
    deployedAtBlock: deployReceipt?.blockNumber ?? null,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${hre.network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nSaved deployment info to deployments/${hre.network.name}.json`);
  console.log("The WhatsApp agent (agent/contractClient.js) reads this file automatically.");

  const abiCount = syncAbi();
  console.log(`Synced public/abi/ReceiptLedger.json (${abiCount} entries) so the dashboard matches this contract.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
