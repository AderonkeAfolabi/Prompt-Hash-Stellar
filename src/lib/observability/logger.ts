import pino from "pino";
import { REDACT_PATHS, REDACTED_CENSOR } from "./redactPaths";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? "silent" : "info"),
  redact: {
    paths: [...REDACT_PATHS],
    censor: REDACTED_CENSOR,
  },
  transport: undefined,
  base: {
    env: process.env.NODE_ENV,
    service: "prompt-hash-unlock",
  },
});

export default logger;
