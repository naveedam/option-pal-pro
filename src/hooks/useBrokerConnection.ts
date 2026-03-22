import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface BrokerConnectionState {
  isConnected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  loading: boolean;
}

export function useBrokerConnection() {
  const [state, setState] = useState<BrokerConnectionState>({
    isConnected: false,
    connectedAt: null,
    expiresAt: null,
    loading: true,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const checkStatus = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setState({ isConnected: false, connectedAt: null, expiresAt: null, loading: false });
        return;
      }

      const { data, error } = await supabase.functions.invoke('kotak-neo-auth', {
        body: { action: 'status' },
      });

      if (error) throw error;

      const connected = data?.connected || false;
      console.log(`[BrokerConnection] Status check: connected=${connected}, connectedAt=${data?.connectedAt}, expiresAt=${data?.expiresAt}`);

      setState({
        isConnected: connected,
        connectedAt: data?.connectedAt || null,
        expiresAt: data?.expiresAt || null,
        loading: false,
      });
    } catch (err) {
      console.error('[BrokerConnection] Status check failed:', err);
      setState(prev => ({ ...prev, loading: false }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await supabase.functions.invoke('kotak-neo-auth', {
        body: { action: 'disconnect' },
      });
      setState({ isConnected: false, connectedAt: null, expiresAt: null, loading: false });
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  return { ...state, refresh: checkStatus, disconnect };
}
