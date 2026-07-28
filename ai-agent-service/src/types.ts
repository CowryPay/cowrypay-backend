import type { PaymentAction } from "./schemas.js";
import type { CachedOpportunity, PendingYieldDeposit } from "./lifi/types.js";

// ── WhatsApp / Webhook types ──────────────────────────────────────────────────

export type WebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: "text" | "interactive" | string;
          text?: { body: string };
          interactive?: {
            button_reply?: { id: string; title: string };
          };
        }>;
        contacts?: Array<{
          profile?: { name: string };
        }>;
      };
    }>;
  }>;
};

export type ParsedMessage = {
  phone: string;
  messageId: string;
  text: string;
  buttonId: string | null;
  name: string | null;
  timestamp: number;
};

// ── User model ────────────────────────────────────────────────────────────────

export type User = {
  phone: string;
  username: string;
  walletAddress: string;
  privyWalletId: string;
};

// ── Group model ───────────────────────────────────────────────────────────────

export type Group = {
  ownerPhone: string;
  name: string;
  members: { username: string; address: string }[];
};

// ── Privy wallet ──────────────────────────────────────────────────────────────

export type TxPayload = {
  to: string;
  data: string;
  value: string;               // hex string
  gasLimit?: bigint;           // explicit gas limit
  maxFeePerGas?: bigint;       // EIP-1559 max fee per gas (wei)
  maxPriorityFeePerGas?: bigint; // EIP-1559 priority fee (wei)
};

export type PrivyWallet = {
  id: string;
  address: string;
};

// ── Intent (parsed from WhatsApp message by AI) ───────────────────────────────

export type Intent = {
  action:
    | "SEND_SINGLE"
    | "SPLIT_PAYMENT"
    | "GROUP_PAYMENT"
    | "HELP"
    | "BALANCE"
    | "TX_HISTORY"
    | "CREATE_GROUP"
    | "ADD_TO_GROUP"
    | "REMOVE_FROM_GROUP"
    | "LIST_GROUPS"
    | "SPLIT_COUNT"
    // ── LI.FI Earn intents ────────────────────────────────────────────────
    | "FIND_YIELD"       // "show me USDC vaults above 5% APY on Arbitrum"
    | "DEPOSIT_YIELD"    // "put $100 into vault 1" / "deposit $200 into top vault"
    | "CHECK_POSITIONS"; // "show my yield positions" / "what am I earning"
  totalAmount?: number;
  count?: number;        // SPLIT_COUNT: number of people to split among
  recipient?: string;   // SEND_SINGLE: single recipient username (no @)
  recipients?: string[];// SPLIT_PAYMENT: multiple usernames (no @)
  groupName?: string;   // GROUP_PAYMENT, ADD_TO_GROUP, REMOVE_FROM_GROUP
  members?: string[];   // CREATE_GROUP: initial member usernames
  name?: string;        // CREATE_GROUP: the group name
  member?: string;      // ADD_TO_GROUP, REMOVE_FROM_GROUP: single username
  note?: string;
  // ── Yield-specific fields ─────────────────────────────────────────────
  minApy?: number;       // FIND_YIELD: minimum APY percentage (e.g. 5 = 5%)
  yieldChain?: string;   // FIND_YIELD: chain preference (e.g. "Arbitrum")
  yieldToken?: string;   // FIND_YIELD: token preference (default "USDC")
  vaultIndex?: number;   // DEPOSIT_YIELD: 1-based index from the displayed list
};

// ── Resolved payment (addresses looked up) ───────────────────────────────────

export type ResolvedPayment = {
  recipients: { username: string; address: string; amount: number }[];
  totalAmount: number;
  note?: string;
  groupId?: bigint;    // set for GROUP_PAYMENT → coordinator uses payGroupEqual
  groupName?: string;  // display name for confirmation / success messages
};

// ── Pending tx stored while awaiting WhatsApp confirmation ───────────────────

export type PendingTxData = {
  txPayload: TxPayload;
  resolved: ResolvedPayment;
  intent: Intent;
  createdAt: number;
};

// ── Transaction history item ──────────────────────────────────────────────────

export type TxHistoryItem = {
  phone: string;
  txHash: string;
  intent: Intent;
  resolved: ResolvedPayment;
  timestamp: number;
  status: "confirmed" | "failed" | "pending";
};

// ── Security ──────────────────────────────────────────────────────────────────

export type SecurityResult =
  | { blocked: false; warning: string | null }
  | { blocked: true; reason: string };

// ── Existing pipeline types ───────────────────────────────────────────────────

export type EncodedTxJson = {
  to: string;
  data: string;
  value: string;
  description: string;
};

export type ChatResponse =
  | {
      type: "clarify";
      question: string;
      /** Optional ERC-20 approve calldata when allowance is too low */
      transactions?: EncodedTxJson[];
      /** Token for approve/sign flows (USDC or USDm) */
      tokenSymbol?: string;
    }
  | {
      type: "draft";
      draftId: string;
      preview: string;
      action: PaymentAction;
      recipients: { username: string; address: string; amount: number }[];
      totalAmount: number;
      /** USDC or USDm for this payment */
      tokenSymbol: string;
    }
  | {
      type: "tx_ready";
      draftId: string;
      preview: string;
      tx: {
        chainId: number;
        token: { address: string; symbol: string; decimals: number };
        cowryPay: string;
        note: string;
        transactions: EncodedTxJson[];
      };
      /**
       * Cowry AI agent (AGENT_PRIVATE_KEY). Payment txs are still signed by the
       * user's wallet; this is identity + ERC-8004 registration, not the tx `from`.
       */
      agent?: {
        address: string;
        erc8004?: { registered: boolean; agentId?: string; hint?: string };
      };
    }
  | {
      type: "cancelled";
      message: string;
    }
  | {
      type: "info";
      message: string;
      transactions?: EncodedTxJson[];
    }
  | {
      /** Morpho / LI.FI Earn deposit ready to broadcast */
      type: "earn_draft";
      preview: string;
      transactions: EncodedTxJson[];
    }
  | {
      /**
       * Agent has already signed and broadcast the payment on-chain.
       * The user does NOT need to sign anything — the Cowry AI agent wallet
       * was the tx sender. Frontend should just display the explorer link.
       */
      type: "tx_sent";
      preview: string;
      txHash: string;
      explorerUrl: string;
      /** Agent wallet address that executed the tx */
      agentAddress: string;
    };

export type SessionState = {
  pendingDraftId: string | null;
  /** Vault list shown to user, keyed 1-based for selection */
  earnOpportunities?: CachedOpportunity[];
  /** Pending yield deposit awaiting user confirm */
  pendingYieldDeposit?: PendingYieldDeposit;
};
