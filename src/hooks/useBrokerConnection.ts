import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createDisconnectedBrokerSession, type BrokerSessionState } from '@/services/brokerSession';

const MAX_MARKET_VALIDATION_RETRIES = 2;

interface RefreshOptions {
  validateMarketData?: boolean;
  reason?: string;
}

export function useBrokerConnection() {
  const [state, setState] = useState<BrokerSessionState>(createDisconnectedBrokerSession());
  const stateRef = useRef(state);
  stateRef.current = state;

  const validateMarketData = useCallback(async () => {
    let lastError = 'Market feed unavailable';

    for (let retry = 0; retry <= MAX_MARKET_VALIDATION_RETRIES; retry++) {
      try {
        if (retry > 0) {
          console.log(`[BrokerConnection] Market validation retry ${retry}/${MAX_MARKET_VALIDATION_RETRIES}`);
        }

        console.log(
          `[BrokerConnection] Market validation started (attempt ${retry + 1}/${MAX_MARKET_VALIDATION_RETRIES + 1}) auth=${stateRef.current.auth}`,
        );

        const { data, error } = await supabase.functions.invoke('kotak-market-data', {
          body: { validateOnly: true, symbol: 'NIFTY' },
        });

        if (error) throw new Error(error.message || 'Market validation failed');

        if (data?.success && data?.validation?.marketData === 'connected') {
          console.log(
            `[BrokerConnection] Market validation result: success symbol=NIFTY price=${data?.validation?.quote ?? 'n/a'}`,
          );

          setState((prev) => ({
            ...prev,
            marketData: 'connected',
            marketDataError: null,
            validationAttempts: retry,
          }));

          return { marketData: 'connected' as const, marketDataError: null, validationAttempts: retry };
        }

        lastError = data?.error || data?.validation?.error || 'Market feed unavailable';
        console.log(`[BrokerConnection] Market validation result: failed attempt=${retry + 1} error=${lastError}`);
      } catch (err: any) {
        lastError = err.message || 'Market feed unavailable';
        console.log(`[BrokerConnection] Market validation result: failed attempt=${retry + 1} error=${lastError}`);
      }
    }

    setState((prev) => ({
      ...prev,
      marketData: 'disconnected',
      marketDataError: lastError,
      validationAttempts: MAX_MARKET_VALIDATION_RETRIES,
    }));

    return {
      marketData: 'disconnected' as const,
      marketDataError: lastError,
      validationAttempts: MAX_MARKET_VALIDATION_RETRIES,
    };
  }, []);

  const checkStatus = useCallback(async ({ validateMarketData: shouldValidateMarketData = false, reason = 'manual' }: RefreshOptions = {}) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const nextState = createDisconnectedBrokerSession(false);
        setState(nextState);
        return nextState;
      }

      const { data, error } = await supabase.functions.invoke('kotak-neo-auth', {
        body: { action: 'status' },
      });

      if (error) throw error;

      const auth = data?.auth === 'connected' ? 'connected' : 'disconnected';
      const trading = data?.trading === 'connected' ? 'connected' : 'disconnected';
      const nextState: BrokerSessionState = {
        auth,
        trading,
        marketData: auth === 'connected' ? stateRef.current.marketData : 'disconnected',
        connectedAt: data?.connectedAt || null,
        expiresAt: data?.expiresAt || null,
        loading: false,
        marketDataError: auth === 'connected' ? stateRef.current.marketDataError : null,
        validationAttempts: auth === 'connected' ? stateRef.current.validationAttempts : 0,
      };

      console.log(
        `[BrokerConnection] Status check: reason=${reason} auth=${auth} trading=${trading} connectedAt=${data?.connectedAt} expiresAt=${data?.expiresAt}`,
      );

      setState(nextState);

      if (auth === 'connected' && shouldValidateMarketData) {
        const validation = await validateMarketData();
        return { ...nextState, ...validation };
      }

      return nextState;
    } catch (err) {
      console.error('[BrokerConnection] Status check failed:', err);
      setState(prev => ({ ...prev, loading: false }));
      return { ...stateRef.current, loading: false };
    }
  }, [validateMarketData]);

  const disconnect = useCallback(async () => {
    try {
      await supabase.functions.invoke('kotak-neo-auth', {
        body: { action: 'disconnect' },
      });
      setState(createDisconnectedBrokerSession(false));
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
  }, []);

  const retryMarketValidation = useCallback(async () => {
    if (stateRef.current.auth !== 'connected') {
      return stateRef.current;
    }

    const validation = await validateMarketData();
    return {
      ...stateRef.current,
      ...validation,
      loading: false,
    };
  }, [validateMarketData]);

  useEffect(() => {
    checkStatus({ validateMarketData: true, reason: 'initial' });
    const interval = setInterval(() => {
      checkStatus({ reason: 'poll' });
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [checkStatus]);

  return {
    ...state,
    isConnected: state.auth === 'connected' && state.marketData === 'connected',
    refresh: checkStatus,
    retryMarketValidation,
    disconnect,
  };
}
