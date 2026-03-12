import { Activity, Wifi, WifiOff } from 'lucide-react';

interface BrokerStatusProps {
  isConnected: boolean;
  isPaperTrading: boolean;
}

export function BrokerStatus({ isConnected, isPaperTrading }: BrokerStatusProps) {
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
      {isConnected && (
        <Activity className="w-3 h-3 text-primary animate-pulse-glow" />
      )}
    </div>
  );
}
