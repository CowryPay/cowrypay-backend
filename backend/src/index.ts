import "dotenv/config";
// Must load before any router is registered — patches Express 4's Router
// so a rejected promise inside an async route handler reaches the error
// middleware below via next(err), instead of becoming an unhandled
// rejection. Real incident this fixes: Express 4 does NOT catch async
// throws on its own, and this process has no unhandledRejection handler
// either, so Node's own default behavior (crash the whole process) was
// taking down EVERY in-flight request — not just the one that errored —
// on any single unexpected error (e.g. a malformed :id param hitting a
// uuid column). A user's cross-chain-send receipt lookup hanging then
// failing with a generic network error is exactly this: the backend
// process crashed mid-request and Railway restarted it, dropping the
// connection.
import "express-async-errors";
import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { captureRawBody } from "./middleware/captureRawBody.js";
import { blockradarWebhookRouter } from "./routes/blockradarWebhook.js";
import { chatRouter } from "./routes/chat.js";
import { depositsRouter } from "./routes/deposits.js";
import { healthRouter } from "./routes/health.js";
import { kycRouter } from "./routes/kyc.js";
import { offrampRouter } from "./routes/offramp.js";
import { passwordRouter } from "./routes/password.js";
import { paycrestWebhookRouter } from "./routes/paycrestWebhook.js";
import { quidaxWebhookRouter } from "./routes/quidaxWebhook.js";
import { pinRouter } from "./routes/pin.js";
import { recipientsRouter } from "./routes/recipients.js";
import { signupRouter } from "./routes/signup.js";
import { usersRouter } from "./routes/users.js";
import { adminRouter } from "./routes/admin.js";
import { stellarWalletRouter } from "./routes/stellarWallet.js";
import { solanaWalletRouter } from "./routes/solanaWallet.js";
import { solanaWebhookRouter } from "./routes/solanaWebhook.js";
import { cryptoWithdrawalsRouter } from "./routes/cryptoWithdrawals.js";
import { crossChainSendsRouter } from "./routes/crossChainSends.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { startWithdrawConfirmationPoller } from "./domain/offramp/withdrawConfirmationPoller.js";
import { startPaycrestSettlementPoller } from "./domain/offramp/paycrestSettlementPoller.js";
import { startQuidaxSettlementPoller } from "./domain/offramp/quidaxSettlementPoller.js";
import { startCentiivSettlementPoller } from "./domain/offramp/centiivSettlementPoller.js";
import { startCryptoWithdrawalConfirmationPoller } from "./domain/cryptoWithdrawals/cryptoWithdrawalConfirmationPoller.js";
import { startDepositScanner } from "./domain/deposits/depositScanner.js";
import { startDepositSweeper } from "./domain/wallets/depositSweeper.js";
import { startStellarDepositScanner } from "./domain/deposits/stellarDepositScanner.js";
import { startSolanaDepositSweeper } from "./domain/wallets/solanaDepositSweeper.js";
import { startSolanaAtaReclaimer } from "./domain/wallets/solanaAtaReclaimer.js";
import { startGasStatusMonitor } from "./domain/monitoring/gasStatusMonitor.js";
import { startDoubleCreditMonitor } from "./domain/monitoring/doubleCreditMonitor.js";
import { startSolanaWebhookReconciler } from "./domain/monitoring/solanaWebhookReconciler.js";
import { startReserveMonitor } from "./domain/monitoring/reserveMonitor.js";
import { startCrossChainSendConfirmationPoller } from "./domain/crossChainSend/crossChainSendConfirmationPoller.js";

// Defense-in-depth beyond the express-async-errors + error-middleware fix
// above, which only covers the request/response cycle — this catches
// anything outside it (a background job's own setInterval callback
// missing its own .catch, a truly async fire-and-forget path). Node
// terminates the whole process by default on either of these since v15;
// logging and staying up is the right call here given every poller in
// this codebase already treats a single bad tick as recoverable, not
// fatal, and taking down every in-flight request over one unexpected
// error is exactly the failure mode this whole change exists to stop.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled-rejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaught-exception]", err);
});

const app = express();
app.use(cors({ origin: env.corsOrigins ?? true }));
app.use(express.json({ verify: captureRawBody }));
app.use(healthRouter);
app.use(signupRouter);
app.use(usersRouter);
app.use(depositsRouter);
app.use(kycRouter);
app.use(offrampRouter);
app.use(passwordRouter);
app.use(pinRouter);
app.use(recipientsRouter);
app.use(blockradarWebhookRouter);
app.use(paycrestWebhookRouter);
app.use(quidaxWebhookRouter);
app.use(chatRouter);
app.use(stellarWalletRouter);
app.use(solanaWalletRouter);
app.use(solanaWebhookRouter);
app.use(adminRouter);
app.use(cryptoWithdrawalsRouter);
app.use(crossChainSendsRouter);
app.use(campaignsRouter);

// Last-resort catch-all — every route above already handles its OWN
// expected failures (validation, insufficient balance, etc.) with a clear
// message via its own try/catch, same as before. This exists for genuinely
// unexpected errors (a malformed :id crashing deep in a repo query, a
// transient DB blip) that would otherwise become an unhandled rejection —
// see the express-async-errors import up top for why that used to crash
// the entire process instead of just failing the one request. Deliberately
// does NOT echo err.message to the client (unlike the deliberate
// try/catches elsewhere, which show real business-logic messages by
// design) — an unexpected error's raw message could contain internals
// (SQL fragments, stack detail) never meant to reach a response body.
// Express identifies this as error-handling middleware purely by its
// 4-argument signature — it must stay last, after every other app.use.
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[unhandled] ${req.method} ${req.path}:`, err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Something went wrong on our end — please try again." });
});

app.listen(env.port, () => {
  console.log(`CowryPay backend  →  http://localhost:${env.port}`);
});

startWithdrawConfirmationPoller();
startPaycrestSettlementPoller();
startQuidaxSettlementPoller();
startCentiivSettlementPoller();
startCryptoWithdrawalConfirmationPoller();
startDepositScanner();
startDepositSweeper();
startStellarDepositScanner();
startSolanaDepositSweeper();
startSolanaAtaReclaimer();
startGasStatusMonitor();
startDoubleCreditMonitor();
startSolanaWebhookReconciler();
startReserveMonitor();
startCrossChainSendConfirmationPoller();
