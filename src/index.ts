/**
 * solana-rpc-shield — resilient RPC + transaction-reliability SDK for Solana.
 *
 * @packageDocumentation
 */

export {
  createResilientTransport,
  createFetchTransport,
  type ResilientTransport,
} from './transport/resilient-transport.js';
export { EndpointHealth, classifyError, isEndpointFault } from './transport/health.js';
export {
  SlotMonitor,
  type SlotProbeTarget,
  type SlotMonitorOptions,
} from './transport/slot-monitor.js';
export {
  PriorityFeeEstimator,
  computePriorityFee,
  type PrioritizationFee,
  type PriorityFeeConfig,
} from './transaction/priority-fee.js';
export {
  TransactionManager,
  TransactionFailedError,
  type Commitment,
  type LatestBlockhash,
  type JitoConfig,
  type TransactionEvent,
  type TransactionManagerOptions,
  type SendAndConfirmOptions,
  type ConfirmResult,
} from './transaction/transaction-manager.js';
export {
  ShieldTelemetry,
  type HealthSource,
  type ShieldTelemetryOptions,
} from './observability/otel.js';
export {
  fromWalletStandard,
  fromLegacyAdapter,
  type WalletSigner,
  type StandardWallet,
  type StandardWalletAccount,
  type WalletStandardOptions,
  type SerializableTransaction,
  type LegacySignerAdapter,
  type LegacyAdapterOptions,
} from './wallet/signers.js';
export {
  WalletPipeline,
  WalletTransactionExpiredError,
  toBase64,
  type WalletPipelineEvent,
  type WalletPipelineOptions,
  type WalletSendOptions,
} from './wallet/wallet-pipeline.js';
export {
  ErrorClass,
  type CircuitState,
  type EndpointConfig,
  type HealthConfig,
  type HealthSnapshot,
  type ResilientTransportConfig,
  type RpcRequest,
  type RpcTransport,
  type TransportEvent,
} from './types/index.js';
