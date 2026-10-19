# Observability & Telemetry Guide (#804)

Prompt Hash Stellar emits structured telemetry for latency, failure rates, and business-critical conversion points.

## Core Operations Instrumented
1. `prompt-verification`: Stellar prompt validation & signature checks.
2. `wallet-connect`: User wallet authentication and session initiation.
3. `escrow-settlement`: Stellar smart contract escrow releases.
4. `prompt-purchase`: Marketplace buyer checkout flow.
5. `data-export`: Privacy-safe data portability exports.

## Structured Log Fields
Every telemetry event outputs JSON fields:
- `operation`: Core operation name
- `actorType`: `CREATOR`, `BUYER`, `ADMIN`, or `SYSTEM`
- `result`: `SUCCESS` or `FAILURE`
- `latencyMs`: Execution duration in milliseconds
- `correlationId`: Distributed tracing correlation ID
- `timestamp`: ISO timestamp
- `metadata`: Contextual attributes (automatically sanitized of secrets)
