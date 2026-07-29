import { env } from "../../config/env.js";

export interface RateQuote {
  rate: string;
}

export interface Institution {
  name: string;
  code: string;
  type: string;
}

// docs.paycrest.io — GET /institutions/{currency} is public, no API key
// needed. Returns the valid bank / mobile-money codes for a currency;
// `institution` on verify-account and order creation must be one of these
// codes, not a free-text name.
export async function getInstitutions(currencyCode: string): Promise<Institution[]> {
  const res = await fetch(`${env.paycrestBaseUrl}/institutions/${currencyCode}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest institutions lookup failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: Institution[] };
  return json.data ?? [];
}

// docs.paycrest.io — GET /rates/{network}/{token}/{amount}/{fiat} is public,
// no API key needed. `sell` is the rate to quote a user off-ramping crypto
// to fiat (this is the offramp-only adapter for now).
export async function getOfframpRate(params: {
  network: string;
  token: string;
  amount: string;
  fiatCurrency: string;
}): Promise<RateQuote> {
  const url = `${env.paycrestBaseUrl}/rates/${params.network}/${params.token}/${params.amount}/${params.fiatCurrency}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest rate lookup failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { sell: { rate: string } } };
  return { rate: json.data.sell.rate };
}

export interface OfframpRecipient {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  memo?: string;
}

export interface CreateOrderInput {
  amount: string;
  token: string;
  network: string;
  refundAddress: string;
  fiatCurrency: string;
  recipient: OfframpRecipient;
  reference: string;
  rate?: string;
}

export interface CreatedOrder {
  orderId: string;
  receiveAddress: string;
  validUntil: string;
  rate: string;
}

function requirePaycrestApiKey(): string {
  if (!env.paycrestApiKey) {
    throw new Error("PAYCREST_API_KEY must be set to create off-ramp orders");
  }
  return env.paycrestApiKey;
}

export async function createOfframpOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/sender/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "API-Key": apiKey },
    body: JSON.stringify({
      amount: input.amount,
      reference: input.reference,
      ...(input.rate ? { rate: input.rate } : {}),
      source: {
        type: "crypto",
        currency: input.token,
        network: input.network,
        refundAddress: input.refundAddress,
      },
      destination: {
        type: "fiat",
        currency: input.fiatCurrency,
        recipient: input.recipient,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest order creation failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: {
      id: string;
      rate: string;
      validUntil?: string;
      receiveAddress?: string;
      providerAccount?: { receiveAddress?: string; validUntil?: string };
    };
  };
  const receiveAddress = json.data.providerAccount?.receiveAddress ?? json.data.receiveAddress;
  const validUntil = json.data.providerAccount?.validUntil ?? json.data.validUntil;
  if (!receiveAddress || !validUntil) {
    throw new Error("Paycrest order response had no receiveAddress/validUntil — response shape needs re-checking");
  }

  return { orderId: json.data.id, receiveAddress, validUntil, rate: json.data.rate };
}

export interface VerifiedAccount {
  accountName: string;
}

export async function verifyRecipientAccount(recipient: {
  institution: string;
  accountIdentifier: string;
}): Promise<VerifiedAccount> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/verify-account`, {
    method: "POST",
    headers: { "content-type": "application/json", "API-Key": apiKey },
    body: JSON.stringify(recipient),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest account verification failed (${res.status}): ${body}`);
  }

  // docs.paycrest.io — `data` is the resolved account name itself (a plain
  // string), or "OK" when name lookup is unavailable — not an object.
  const json = (await res.json()) as { data: string };
  return { accountName: json.data };
}

export interface OrderStatus {
  id: string;
  status: string;
  amountPaid?: string;
}

// docs.paycrest.io — GET /sender/orders/{id}, requires API key. Used to poll
// an order after creation (the sends state machine also gets updates via the
// payment_order.* webhook, but polling covers the gap before that arrives).
export async function getOrderStatus(orderId: string): Promise<OrderStatus> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/sender/orders/${orderId}`, {
    headers: { "API-Key": apiKey },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest order status lookup failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data?: { id: string; status: string; amountPaid?: string } };
  if (!json.data) {
    throw new Error("Paycrest order status response missing data");
  }
  return { id: json.data.id, status: json.data.status, amountPaid: json.data.amountPaid };
}
