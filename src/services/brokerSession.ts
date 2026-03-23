export type BrokerConnectionState = 'connected' | 'disconnected';

export type BrokerState = {
  auth: BrokerConnectionState;
  marketData: BrokerConnectionState;
  trading: BrokerConnectionState;
};

export type BrokerStatus = {
  isAuthenticated: boolean;
  isMarketDataAvailable: boolean;
};

export type BrokerSessionState = BrokerState & {
  connectedAt: string | null;
  expiresAt: string | null;
  loading: boolean;
  marketDataError: string | null;
  validationAttempts: number;
};

export const createDisconnectedBrokerSession = (
  loading = true,
): BrokerSessionState => ({
  auth: 'disconnected',
  marketData: 'disconnected',
  trading: 'disconnected',
  connectedAt: null,
  expiresAt: null,
  loading,
  marketDataError: null,
  validationAttempts: 0,
});

export const isBrokerAuthenticated = (state: BrokerState) => state.auth === 'connected';

export const isMarketDataConnected = (state: BrokerState) => state.marketData === 'connected';

export const isBrokerFullyConnected = (state: BrokerState) =>
  state.auth === 'connected' && state.marketData === 'connected';

export const toBrokerStatus = (state: BrokerState): BrokerStatus => ({
  isAuthenticated: state.auth === 'connected',
  isMarketDataAvailable: state.marketData === 'connected',
});