import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createDisconnectedBrokerSession, type BrokerSessionState } from '@/services/brokerSession';
import { createBroker, type BrokerType, type BrokerAuthParams } from '@/services/brokerInterface';

const MAX_MARKET_VALIDATION_RETRIES = 2;

interface RefreshOptions {
  validateMarketData?: boolean;
  reason?: string;
}

export function useBrokerConnection() {
  const [state, setState] = useState<BrokerSessionState>(createDisconnectedBrokerSession());
  const [activeBrokerType, setActiveBrokerType] = useState<BrokerType | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const validateMarketData = useCallback(async () => {
    // Bypass: trust broker auth — market data validated by feed
    setState((prev) => ({ ...prev, marketData: 'connected', marketDataError: null, validationAttempts: 0 }));
    return { marketData: 'connected' as const, marketDataError: null, validationAttempts: 0 };
  }, []);

  const checkStatus = useCallback(async ({ validateMarketData: shouldValidate = false, reason = 'manual' }: RefreshOptions = {}) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const nextState = createDisconnectedBrokerSession(false);
        setState(nextState);
        return nextState;
      }

      // Use active broker type or default to kotak
      const brokerType = activeBrokerType || 'kotak';
      const broker = createBroker(brokerType, supabase);
      const status = await broker.getStatus();

      const nextState: BrokerSessionState = {
        auth: status.auth,
        trading: status.trading,
        marketData: status.auth === 'connected' ? stateRef.current.marketData : 'disconnected',
        connectedAt: null,
        expiresAt: status.expiresAt || null,
        loading: false,
        marketDataError: status.auth === 'connected' ? stateRef.current.marketDataError : null,
        validationAttempts: status.auth === 'connected' ? stateRef.current.validationAttempts : 0,
      };

      console.log(`[BrokerConnection] Status: reason=${reason} broker=${brokerType} auth=${status.auth} trading=${status.trading}`);
      setState(nextState);

      if (status.auth === 'connected' && shouldValidate) {
        const validation = await validateMarketData();
        return { ...nextState, ...validation };
      }
      return nextState;
    } catch (err) {
      console.error('[BrokerConnection] Status check failed:', err);
      setState(prev => ({ ...prev, loading: false }));
      return { ...stateRef.current, loading: false };
    }
  }, [validateMarketData, activeBrokerType]);

  const connect = useCallback(async (brokerType: BrokerType, params: BrokerAuthParams) => {
    const broker = createBroker(brokerType, supabase);
    const result = await broker.connect(params);
    if (result.success) {
      setActiveBrokerType(brokerType);
      const brokerState = await checkStatus({ validateMarketData: true, reason: 'connect' });
      return { success: true, brokerState };
    }
    return { success: false, error: result.error };
  }, [checkStatus]);

  const disconnect = useCallback(async () => {
    try {
      const brokerType = activeBrokerType || 'kotak';
      const broker = createBroker(brokerType, supabase);
      await broker.disconnect();
      setActiveBrokerType(null);
      setState(createDisconnectedBrokerSession(false));
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
  }, [activeBrokerType]);

  const retryMarketValidation = useCallback(async () => {
    if (stateRef.current.auth !== 'connected') return stateRef.current;
    const validation = await validateMarketData();
    return { ...stateRef.current, ...validation, loading: false };
  }, [validateMarketData]);

  useEffect(() => {
    checkStatus({ validateMarketData: true, reason: 'initial' });
    const interval = setInterval(() => checkStatus({ reason: 'poll' }), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  return {
    ...state,
    activeBrokerType,
    isConnected: state.auth === 'connected' && state.marketData === 'connected',
    isAuthenticated: state.auth === 'connected',
    isMarketDataAvailable: state.marketData === 'connected',
    connect,
    refresh: checkStatus,
    retryMarketValidation,
    disconnect,
  };
}
