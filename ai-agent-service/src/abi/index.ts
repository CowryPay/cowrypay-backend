import userRegistry from "./userRegistry.json" with { type: "json" };
import groupRegistry from "./groupRegistry.json" with { type: "json" };
import CowryPay from "./CowryPay.json" with { type: "json" };

function contractAddress(
  envKey: string,
  fallback: `0x${string}`,
): `0x${string}` {
  const v = process.env[envKey]?.trim();
  if (v && /^0x[a-fA-F0-9]{40}$/.test(v)) return v as `0x${string}`;
  return fallback;
}

/** Celo mainnet — v2 redeployment (operator/agent pattern). Override via env if redeployed. */
const DEFAULT_USERNAME_REGISTRY = "0x1d8050eda109364c15db4c2c5a172128eaeabd25" as const;
const DEFAULT_GROUP_REGISTRY    = "0x3d8ea5b32dda2b3bfb71c9a07de25ecf28b73fd4" as const;
const DEFAULT_COWRYPAY          = "0xf253dde47ca717737be3aefb76326180c2239e04" as const;

export const userRegistryContract = {
  abi: userRegistry,
  address: contractAddress("USERNAME_REGISTRY_ADDRESS", DEFAULT_USERNAME_REGISTRY),
};

export const groupRegistryContract = {
  abi: groupRegistry,
  address: contractAddress("GROUP_REGISTRY_ADDRESS", DEFAULT_GROUP_REGISTRY),
};

export const cowrypayContract = {
  abi: CowryPay,
  address: contractAddress("COWRYPAY_ADDRESS", DEFAULT_COWRYPAY),
};
