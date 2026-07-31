import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { env } from "../../config/env.js";

// Only Celo is wired up — that's the only chain Blockradar has actually
// rejected a withdraw on for lack of gas. Add more chains here (with their
// own RPC endpoint) only once they're actually needed.
const CHAIN_RPC_URLS: Record<string, string> = {
  celo: "https://forno.celo.org",
};

function requireGasStationKey(): string {
  if (!env.gasStationPrivateKey) {
    throw new Error("GAS_STATION_PRIVATE_KEY must be set to cover network fees");
  }
  return env.gasStationPrivateKey;
}

function getProvider(chain: string): JsonRpcProvider {
  const rpcUrl = CHAIN_RPC_URLS[chain];
  if (!rpcUrl) throw new Error(`No gas-station RPC endpoint configured for chain "${chain}"`);
  return new JsonRpcProvider(rpcUrl);
}

// Blockradar's withdraw rejects outright if the source address holds no
// native gas — it does not sponsor gas itself (confirmed via a real 400:
// "Insufficient CELO balance for network fee, you have 0 CELO"). Tops the
// address up from a company-controlled wallet only when actually needed,
// and waits for the top-up to confirm before returning, since Blockradar
// checks the real on-chain balance at broadcast time.
export async function ensureGasFunded(address: string, chain: string): Promise<void> {
  const privateKey = requireGasStationKey();
  const provider = getProvider(chain);
  const topupAmount = parseEther(env.gasStationTopupAmount);
  const threshold = topupAmount / 2n;

  const balance = await provider.getBalance(address);
  if (balance >= threshold) return;

  const wallet = new Wallet(privateKey, provider);
  const tx = await wallet.sendTransaction({ to: address, value: topupAmount });
  await tx.wait();
}
