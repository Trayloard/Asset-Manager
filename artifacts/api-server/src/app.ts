import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Build the allowed-origins set from explicit config plus the Replit dev domain
// when present (injected at runtime; cannot be set manually).
const allowedOrigins: Set<string> = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

// In the Replit environment REPLIT_DEV_DOMAIN holds the proxied preview hostname.
// Include both http and https variants so local curl and the iframe both work.
if (process.env.REPLIT_DEV_DOMAIN) {
  allowedOrigins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  allowedOrigins.add(`http://${process.env.REPLIT_DEV_DOMAIN}`);
}

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // Allow requests with no Origin header (same-origin, server-to-server, curl)
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(authMiddleware);

app.use("/api", router);

export default app;
