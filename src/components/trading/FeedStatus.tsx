import { Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import type { FeedHealth } from '@/services/kotakMarketFeed';

interface FeedStatusProps {
  health: FeedHealth;
}

export function FeedStatus({ health }: FeedStatusProps) {
  const { status, latencyMs, lastTickTime, errorMessage } = health;

  const lastTickLabel = lastTickTime
    ? new Date(lastTickTime).toLocaleTimeString('en-IN', { hour12: false })
    : '—';

  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <div className="flex items-center gap-1.5">
        {status === 'connected' && (
          <>
            <Wifi className="w-3 h-3 text-profit" />
            <span className="status-dot status-connected" />
          </>
        )}
        {status === 'reconnecting' && (
          <>
            <AlertTriangle className="w-3 h-3 text-warning animate-pulse" />
            <span className="status-dot bg-warning shadow-[0_0_6px_hsl(var(--warning)/0.6)]" />
          </>
        )}
        {(status === 'disconnected' || status === 'error') && (
          <>
            <WifiOff className="w-3 h-3 text-loss" />
            <span className="status-dot status-disconnected" />
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-muted-foreground">
        {status === 'connected' && (
          <>
            <span>{latencyMs}ms</span>
            <span className="text-foreground/50">|</span>
            <span>{lastTickLabel}</span>
          </>
        )}
        {status === 'reconnecting' && (
          <span className="text-warning">Reconnecting…</span>
        )}
        {status === 'error' && (
          <span className="text-loss truncate max-w-[180px]" title={errorMessage || undefined}>
            {errorMessage || 'Feed error'}
          </span>
        )}
        {status === 'disconnected' && (
          <span>No feed</span>
        )}
      </div>
    </div>
  );
}
