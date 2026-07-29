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
import { passwordRouter } from "./routes/password.js";
import { pinRouter } from "./routes/pin.js";
import { signupRouter } from "./routes/signup.js";
import { usersRouter } from "./routes/users.js";

const app = express();
app.use(cors({ origin: env.corsOrigins ?? true }));
app.use(express.json({ verify: captureRawBody }));
app.use(healthRouter);
app.use(signupRouter);
app.use(usersRouter);
app.use(depositsRouter);
app.use(kycRouter);
app.use(passwordRouter);
app.use(pinRouter);
app.use(blockradarWebhookRouter);
app.use(chatRouter);

app.listen(env.port, () => {
  console.log(`CowryPay backend  →  http://localhost:${env.port}`);
});
