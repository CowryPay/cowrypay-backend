import type { Request } from "express";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Passed as express.json()'s `verify` option — webhook signature checks
// (Blockradar's HMAC) need the exact raw bytes that were signed, which the
// parsed-then-restringified req.body can't guarantee byte-for-byte.
export function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  req.rawBody = buf;
}
