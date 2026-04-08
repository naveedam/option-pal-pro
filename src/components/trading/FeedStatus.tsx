import { useState } from 'react';
import { Wifi, WifiOff, AlertTriangle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import type { FeedHealth } from '@/services/kotakMarketFeed';

interface FeedStatusProps {
  health: FeedHealth;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false });
}

function formatAge(ts: number | null | undefined): string {
  if (!ts) return '—';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

export function FeedStatus({ health }: FeedStatusProps) {
  const [expanded, setExpanded] = useState(false);
  const { status, latencyMs, lastTickTime, errorMessage, sessionError } = health;

  const lastTickLabel = lastTickTime
    ? new Date(lastTickTime).toLocaleTimeString('en-IN', { hour12: false })
    : '—';

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 text-xs font-mono cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center gap-1.5">
          {status === 'connected' && (
            <>
              <Wifi className="w-3 h-3 text-profit" />
              <span className="status-dot status-connected" />
            </>
          )}
          {status === 'stale' && (
            <>
              <Clock className="w-3 h-3 text-warning animate-pulse" />
              <span className="status-dot bg-warning shadow-[0_0_6px_hsl(var(--warning)/0.6)]" />
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
          {status === 'stale' && (
            <span className="text-warning">
              ⚠ Using last known data ({lastTickLabel})
            </span>
          )}
          {status === 'reconnecting' && <span className="text-warning">Reconnecting… ({health.consecutiveErrors})</span>}
          {status === 'error' && (
            <span className="text-loss truncate max-w-[220px]" title={errorMessage || undefined}>
              {sessionError === 'SESSION_EXPIRED' ? 'Session expired' :
               sessionError === 'NO_SESSION' ? 'No session' : 'Feed unavailable'}
            </span>
          )}
          {status === 'disconnected' && <span>No feed</span>}
        </div>

        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      </div>

      {/* Debug panel */}
      {expanded && (
        <div className="mt-1 bg-muted/50 rounded px-2 py-1.5 text-[9px] font-mono text-muted-foreground space-y-0.5 border border-border">
          <div className="flex justify-between">
            <span>Source</span>
            <span className={health.currentSource === 'kotak' ? 'text-profit' : 'text-loss'}>
              {(health.currentSource || 'none').toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Last API Response</span>
            <span>{formatAge(health.lastApiResponseTime)}</span>
          </div>
          <div className="flex justify-between">
            <span>Last Good Data</span>
            <span>{formatAge(health.lastSuccessfulDataTime)}</span>
          </div>
          <div className="flex justify-between">
            <span>Last Tick</span>
            <span>{formatTime(lastTickTime)}</span>
          </div>
          <div className="flex justify-between">
            <span>Latency</span>
            <span>{latencyMs}ms</span>
          </div>
          <div className="flex justify-between">
            <span>Errors</span>
            <span>{health.consecutiveErrors}</span>
          </div>
          {sessionError && (
            <div className="flex justify-between text-loss">
              <span>Session</span>
              <span>{sessionError}</span>
            </div>
          )}
          {errorMessage && (
            <div className="text-loss break-all mt-0.5">
              {errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
