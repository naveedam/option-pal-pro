import { useState, useEffect, useCallback } from 'react';
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

      setState({
        isConnected: data?.connected || false,
        connectedAt: data?.connectedAt || null,
        expiresAt: data?.expiresAt || null,
        loading: false,
      });
    } catch {
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
    // Re-check every 5 minutes
    const interval = setInterval(checkStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  return { ...state, refresh: checkStatus, disconnect };
}
