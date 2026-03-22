import { Activity, AlertTriangle, Clock, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrokerState } from '@/services/brokerSession';

interface BrokerStatusProps {
  state: BrokerState;
  isPaperTrading: boolean;
  expiresAt?: string | null;
}

export function BrokerStatus({ state, isPaperTrading, expiresAt }: BrokerStatusProps) {
  const [timeLeft, setTimeLeft] = useState('');
  const isAuthenticated = state.auth === 'connected';
  const hasMarketData = state.marketData === 'connected';
  const statusLabel = !isAuthenticated
    ? 'NOT LOGGED IN'
    : !hasMarketData
      ? 'MARKET FEED UNAVAILABLE'
      : isPaperTrading
        ? 'PAPER MODE'
        : 'KOTAK NEO';

  useEffect(() => {
    if (!isAuthenticated || !expiresAt) {
      setTimeLeft('');
      return;
    }

    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft('Expired');
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setTimeLeft(`${h}h ${m}m`);
    };

    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [isAuthenticated, expiresAt]);

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <div className={`status-dot ${isAuthenticated && hasMarketData ? 'status-connected' : 'status-disconnected'}`} />
        {!isAuthenticated ? (
          <WifiOff className="w-3.5 h-3.5 text-loss" />
        ) : hasMarketData ? (
          <Wifi className="w-3.5 h-3.5 text-profit" />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 text-warning" />
        )}
        <span className="text-xs font-mono">{statusLabel}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
        <span className="rounded border border-border bg-secondary px-1.5 py-0.5">AUTH {state.auth.toUpperCase()}</span>
        <span className="rounded border border-border bg-secondary px-1.5 py-0.5">FEED {state.marketData.toUpperCase()}</span>
        <span className="rounded border border-border bg-secondary px-1.5 py-0.5">TRADE {state.trading.toUpperCase()}</span>
      </div>
      {isAuthenticated && timeLeft && (
        <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{timeLeft === 'Expired' ? 'SESSION EXPIRED' : timeLeft}</span>
        </div>
      )}
      {isAuthenticated && hasMarketData && (
        <Activity className="w-3 h-3 text-primary animate-pulse-glow" />
      )}
    </div>
  );
}
