import { Activity, Wifi, WifiOff, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';

interface BrokerStatusProps {
  isConnected: boolean;
  isPaperTrading: boolean;
  expiresAt?: string | null;
}

export function BrokerStatus({ isConnected, isPaperTrading, expiresAt }: BrokerStatusProps) {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    if (!isConnected || !expiresAt) {
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
  }, [isConnected, expiresAt]);

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`} />
        {isConnected ? (
          <Wifi className="w-3.5 h-3.5 text-profit" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-loss" />
        )}
        <span className="text-xs font-mono">
          {isPaperTrading ? 'PAPER MODE' : isConnected ? 'KOTAK NEO' : 'DISCONNECTED'}
        </span>
      </div>
      {isConnected && timeLeft && (
        <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{timeLeft === 'Expired' ? 'SESSION EXPIRED' : timeLeft}</span>
        </div>
      )}
      {isConnected && (
        <Activity className="w-3 h-3 text-primary animate-pulse-glow" />
      )}
    </div>
  );
}
