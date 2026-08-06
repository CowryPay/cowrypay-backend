import "dotenv/config";
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
import { pinRouter } from "./routes/pin.js";
import { recipientsRouter } from "./routes/recipients.js";
import { signupRouter } from "./routes/signup.js";
import { usersRouter } from "./routes/users.js";
import { stellarWalletRouter } from "./routes/stellarWallet.js";
import { startWithdrawConfirmationPoller } from "./domain/offramp/withdrawConfirmationPoller.js";
import { startDepositScanner } from "./domain/deposits/depositScanner.js";
import { startDepositSweeper } from "./domain/wallets/depositSweeper.js";
import { startStellarDepositScanner } from "./domain/deposits/stellarDepositScanner.js";

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
app.use(chatRouter);
app.use(stellarWalletRouter);

app.listen(env.port, () => {
  console.log(`CowryPay backend  →  http://localhost:${env.port}`);
});

startWithdrawConfirmationPoller();
startDepositScanner();
startDepositSweeper();
startStellarDepositScanner();
