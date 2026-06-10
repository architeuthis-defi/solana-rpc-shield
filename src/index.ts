/**
 * solana-rpc-shield — resilient RPC + transaction-reliability SDK for Solana.
 *
 * @packageDocumentation
 */

export { createResilientTransport, type ResilientTransport } from './transport/resilient-transport.js';
export { EndpointHealth, classifyError, isEndpointFault } from './transport/health.js';
export {
  SlotMonitor,
  type SlotProbeTarget,
  type SlotMonitorOptions,
} from './transport/slot-monitor.js';
export {
  ErrorClass,
  type CircuitState,
  type EndpointConfig,
  type HealthConfig,
  type HealthSnapshot,
  type ResilientTransportConfig,
  type RpcRequest,
  type RpcTransport,
} from './types/index.js';
