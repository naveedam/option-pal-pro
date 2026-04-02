import { useState, useCallback, memo, useEffect, useRef } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { BrokerStatus } from '@/components/trading/BrokerStatus';
import { BrokerLoginDialog } from '@/components/trading/BrokerLoginDialog';
import { FeedStatus } from '@/components/trading/FeedStatus';
import { SpotTicker } from '@/components/trading/SpotTicker';
import { OptionChainTable } from '@/components/trading/OptionChainTable';
import { SignalPanel } from '@/components/trading/SignalPanel';
import { PositionsPanel } from '@/components/trading/PositionsPanel';
import { RiskControls } from '@/components/trading/RiskControls';
import { AnalyticsPanels } from '@/components/trading/AnalyticsPanels';
import { BacktestPanel } from '@/components/trading/BacktestPanel';
import { TradeTicketModal } from '@/components/trading/TradeTicketModal';
import { useBacktest } from '@/hooks/useBacktest';
import { useMarketData } from '@/hooks/useMarketData';
import { useBrokerConnection } from '@/hooks/useBrokerConnection';
import { useTradeStore } from '@/hooks/useTradeStore';
import { supabase } from '@/integrations/supabase/client';
import { isBrokerAuthenticated, isBrokerFullyConnected } from '@/services/brokerSession';
import { LogOut, Plug, Eye, EyeOff } from 'lucide-react';

const Dashboard = () => {
  const [isPaperTrading, setIsPaperTrading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<'NIFTY' | 'SENSEX'>('NIFTY');
  const [brokerDialogOpen, setBrokerDialogOpen] = useState(false);
  const [showOptionChain, setShowOptionChain] = useState(true);
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(null);
  const [tradeTicketSignal, setTradeTicketSignal] = useState<typeof signals[0] | null>(null);
  const [tradeTicketOpen, setTradeTicketOpen] = useState(false);
  const [signalDrawerOpen, setSignalDrawerOpen] = useState(false);

  const broker = useBrokerConnection();
  const tradeStore = useTradeStore();
  const backtestResult = useBacktest(tradeStore.closedTrades);

  const {
    marketData, signals, positions, tradesToday, dailyPnL,
    riskSettings, setRiskSettings, riskLimitReached,
    executePaperTrade, validateRiskLimits, addLivePosition,
    exitPosition, dismissSignal, feedHealth, retryFeed,
    autoTradeEnabled, setAutoTradeEnabled, dataSourceInfo,
  } = useMarketData(isPaperTrading, true);

  const openBrokerDialog = useCallback(() => setBrokerDialogOpen(true), []);
  const handleBrokerConnected = useCallback(() => broker.refresh({ validateMarketData: true, reason: 'login' }), [broker]);

  // Smart linking: highlight strike and scroll into view
  const handleViewInChain = useCallback((strike: number) => {
    setShowOptionChain(true);
    setHighlightedStrike(strike);
    setTimeout(() => {
      const el = document.getElementById(`strike-${strike}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    // Clear highlight after 5s
    setTimeout(() => setHighlightedStrike(null), 5000);
  }, []);

  // Open trade ticket from signal
  const handleExecuteTrade = useCallback((signal: typeof signals[0]) => {
    setTradeTicketSignal(signal);
    setTradeTicketOpen(true);
  }, []);

  // Execute trade from modal
  const handleTradeExecute = async (params: {
    symbol: string; strike: number; optionType: 'CE' | 'PE';
    quantity: number; orderType: string; transactionType: 'BUY' | 'SELL';
  }) => {
    // Find matching signal to reuse existing flow
    const signal = signals.find(s => s.strike === params.strike && s.optionType === params.optionType);
    const baseSignal = signal || {
      id: `manual-${Date.now()}`,
      index: params.symbol as 'NIFTY' | 'SENSEX',
      strike: params.strike,
      optionType: params.optionType,
      strategy: 'Manual',
      reason: 'Manual trade',
      currentPrice: 0,
      suggestedQty: params.quantity,
      timestamp: Date.now(),
      strength: 'MEDIUM' as const,
      confidence: 100,
      dataSource: 'yahoo' as const,
      isStale: false,
      dataTimestamp: Date.now(),
      oiSource: 'synthetic' as const,
    };
    const modifiedSignal = { ...baseSignal, suggestedQty: params.quantity };
    await handleConfirmTrade(modifiedSignal, params.transactionType);
  };

  const handleConfirmTrade = async (signal: typeof signals[0], transactionType: 'BUY' | 'SELL' = 'BUY') => {
    const riskCheck = validateRiskLimits();
    if (!riskCheck.ok) {
      toast.error('Order blocked', { description: riskCheck.reason });
      return;
    }

    if (isPaperTrading) {
      const result = executePaperTrade(signal);
      if (result.success === true) {
        toast.success(`📝 Paper order placed: ${signal.index} ${signal.strike} ${signal.optionType}`, {
          description: `Qty: ${signal.suggestedQty} @ ₹${signal.currentPrice.toFixed(2)} | Confidence: ${signal.confidence}%`,
        });
        await tradeStore.saveTrade(result.position, true, {
          type: signal.optionType === 'CE' ? 'BUY' : 'SELL',
          strategy: signal.strategy,
          confidence: signal.confidence,
          stopLoss: signal.currentPrice * (1 - riskSettings.stopLossPct),
        });
      } else {
        toast.error('Order blocked', { description: result.reason });
      }
    } else {
      if (broker.trading !== 'connected') {
        toast.error('Broker not connected', { description: 'Please connect Kotak Neo first.' });
        openBrokerDialog();
        return;
      }
      try {
        const { data, error } = await supabase.functions.invoke('kotak-place-order', {
          body: {
            symbol: signal.index, strike: signal.strike, optionType: signal.optionType,
            quantity: signal.suggestedQty, orderType: 'MARKET', product: 'MIS', transactionType,
          },
        });
        if (error) {
          toast.error('Order failed', { description: error.message || 'Failed to place order' });
          return;
        }
        if (data?.success) {
          const position = addLivePosition(signal, data.orderId);
          toast.success(`✅ Live order placed: ${signal.index} ${signal.strike} ${signal.optionType}`, {
            description: `Qty: ${signal.suggestedQty} | Order ID: ${data.orderId}`,
          });
          position.dbId = data.orderId;
        } else {
          toast.error('Order rejected', { description: data?.error || 'Broker order failed.' });
        }
      } catch (err: any) {
        toast.error('Order failed', { description: 'Broker order failed. Please reconnect Kotak Neo.' });
      }
    }
  };

  const handleExitPosition = async (positionId: string) => {
    const pos = positions.find(p => p.id === positionId);
    if (pos) {
      if (pos.dbId) await tradeStore.closeTrade(pos.dbId, pos.currentPrice, pos.pnl);
      exitPosition(positionId);
      toast.info(`Position closed: ${pos.symbol} ${pos.strike} ${pos.optionType}`, {
        description: `P&L: ${pos.pnl >= 0 ? '+' : ''}₹${pos.pnl.toFixed(2)}`,
      });
    }
  };

  const handleLogout = async () => { await supabase.auth.signOut(); };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 't' || e.key === 'T') {
        setSignalDrawerOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-trade
  const autoTradeProcessedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoTradeEnabled || isPaperTrading || broker.trading !== 'connected') return;
    const riskCheck = validateRiskLimits();
    if (!riskCheck.ok) return;
    for (const signal of signals) {
      if (autoTradeProcessedRef.current.has(signal.id)) continue;
      if (signal.confidence > 75 && signal.strength === 'HIGH') {
        autoTradeProcessedRef.current.add(signal.id);
        handleConfirmTrade(signal);
        toast.info(`⚡ Auto-trade executed: ${signal.index} ${signal.strike} ${signal.optionType}`, {
          description: `Strategy: ${signal.strategy} | Confidence: ${signal.confidence}%`,
        });
      }
    }
  }, [signals, autoTradeEnabled, isPaperTrading, broker.trading]);

  const renderContent = () => {
    if (broker.loading) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-background gap-3">
          <div className="text-primary terminal-glow font-mono animate-pulse">Checking broker connection...</div>
        </div>
      );
    }

    if (!marketData && feedHealth.status === 'error') {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-background gap-4">
          <div className="text-destructive font-mono text-sm text-center">⚠ Market Feed Error</div>
          <p className="text-muted-foreground text-xs text-center max-w-sm">{feedHealth.errorMessage || 'Unable to connect.'}</p>
          <Button variant="default" size="sm" onClick={() => retryFeed()}>Retry Connection</Button>
          <Button variant="ghost" size="sm" onClick={handleLogout} className="text-muted-foreground text-xs">Sign out</Button>
        </div>
      );
    }

    if (!marketData) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-background gap-3">
          <div className="text-primary terminal-glow font-mono animate-pulse">Connecting to market feed...</div>
        </div>
      );
    }

    const activeChain = selectedIndex === 'NIFTY' ? marketData.niftyChain : marketData.sensexChain;
    const activeSpot = selectedIndex === 'NIFTY' ? marketData.niftySpot : marketData.sensexSpot;

    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* Header */}
        <header className="border-b border-border px-4 py-2 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="font-mono text-sm font-bold text-primary terminal-glow tracking-wider">
              OPTIQ<span className="text-muted-foreground">.TRADE</span>
            </h1>
            <BrokerStatus state={broker} isPaperTrading={isPaperTrading} expiresAt={broker.expiresAt} />
            <FeedStatus health={feedHealth} />
            {!isBrokerAuthenticated(broker) && (
              <Button variant="terminal" size="sm" onClick={openBrokerDialog} className="text-xs gap-1">
                <Plug className="w-3 h-3" /> CONNECT
              </Button>
            )}
            {isBrokerAuthenticated(broker) && (
              <Button variant="ghost" size="sm" onClick={async () => { await broker.disconnect(); setIsPaperTrading(true); toast.info('Broker disconnected'); }} className="text-xs text-muted-foreground">
                DISCONNECT
              </Button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <SpotTicker label="NIFTY" price={marketData.niftySpot} change={marketData.niftyChange} pcr={marketData.niftyPCR} atm={marketData.niftyATM} />
            <SpotTicker label="SENSEX" price={marketData.sensexSpot} change={marketData.sensexChange} pcr={marketData.sensexPCR} atm={marketData.sensexATM} />
          </div>

          <div className="flex items-center gap-3">
            {!isPaperTrading && isBrokerFullyConnected(broker) && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-signal">⚡ AUTO</span>
                <Switch checked={autoTradeEnabled} onCheckedChange={setAutoTradeEnabled} />
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono ${isPaperTrading ? 'text-warning' : 'text-loss'}`}>
                {isPaperTrading ? '📝 PAPER' : '🔴 LIVE'}
              </span>
              <Switch
                checked={!isPaperTrading}
                onCheckedChange={(checked) => {
                  if (checked && !isBrokerFullyConnected(broker)) {
                    toast.warning('Connect Kotak Neo broker first');
                    openBrokerDialog();
                    return;
                  }
                  setIsPaperTrading(!checked);
                  if (!checked) setAutoTradeEnabled(false);
                }}
              />
            </div>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="text-muted-foreground">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        {/* Risk + Analytics */}
        <div className="px-4 py-2 flex-shrink-0">
          <RiskControls settings={riskSettings} onUpdate={setRiskSettings} tradesToday={tradesToday} dailyPnL={dailyPnL} riskLimitReached={riskLimitReached} />
        </div>

        <div className="px-4 pb-2 flex-shrink-0">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <AnalyticsPanels chain={activeChain} spotPrice={activeSpot} index={selectedIndex} maxPain={selectedIndex === 'NIFTY' ? marketData.niftyMaxPain : marketData.sensexMaxPain} />
            <div className="w-[220px]">
              <BacktestPanel result={backtestResult} />
            </div>
          </div>
        </div>

        {/* Main content area */}
        <div className="flex-1 flex min-h-0 px-4 pb-3 gap-3">
          {/* Option Chain with toggle */}
          {showOptionChain && (
            <div className="flex-1 flex flex-col min-h-0">
              <Tabs value={selectedIndex} onValueChange={(v) => setSelectedIndex(v as 'NIFTY' | 'SENSEX')} className="flex flex-col flex-1 min-h-0">
                <div className="flex items-center justify-between mb-2">
                  <TabsList className="bg-secondary border border-border w-fit">
                    <TabsTrigger value="NIFTY" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">NIFTY</TabsTrigger>
                    <TabsTrigger value="SENSEX" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">SENSEX</TabsTrigger>
                  </TabsList>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowOptionChain(false)}
                    className="text-xs text-muted-foreground gap-1"
                  >
                    <EyeOff className="w-3 h-3" /> Hide Chain
                  </Button>
                </div>
                <TabsContent value="NIFTY" className="flex-1 min-h-0 mt-0">
                  <OptionChainTable chain={marketData.niftyChain} index="NIFTY" highlightedStrike={highlightedStrike} />
                </TabsContent>
                <TabsContent value="SENSEX" className="flex-1 min-h-0 mt-0">
                  <OptionChainTable chain={marketData.sensexChain} index="SENSEX" highlightedStrike={highlightedStrike} />
                </TabsContent>
              </Tabs>
            </div>
          )}

          {!showOptionChain && (
            <div className="flex items-start pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowOptionChain(true)}
                className="text-xs font-mono gap-1"
              >
                <Eye className="w-3 h-3" /> Show Chain
              </Button>
            </div>
          )}

          {/* Signal Panel */}
          <div className={`${showOptionChain ? 'w-[300px]' : 'flex-1 max-w-lg'} flex-shrink-0 min-h-[200px]`}>
            <SignalPanel
              signals={signals}
              onConfirm={handleConfirmTrade}
              onDismiss={dismissSignal}
              riskLimitReached={riskLimitReached}
              onExecuteTrade={handleExecuteTrade}
              onViewInChain={handleViewInChain}
              dataSourceInfo={dataSourceInfo}
            />
          </div>
        </div>

        {/* Daily P&L Summary Bar */}
        <div className="px-4 py-1.5 flex-shrink-0 border-t border-border bg-secondary/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Day P&L</span>
                <span className={`text-sm font-mono font-bold ${dailyPnL >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {dailyPnL >= 0 ? '+' : ''}₹{dailyPnL.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Trades</span>
                <span className="text-sm font-mono text-foreground">{tradesToday}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Open</span>
                <span className="text-sm font-mono text-foreground">{positions.length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono uppercase">Mode</span>
                <span className={`text-xs font-mono font-bold ${isPaperTrading ? 'text-warning' : 'text-loss'}`}>
                  {isPaperTrading ? 'PAPER' : 'LIVE'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Positions */}
        <div className="px-4 pb-3 h-[200px] flex-shrink-0">
          <PositionsPanel positions={positions} dailyPnL={dailyPnL} tradesToday={tradesToday} onExitPosition={handleExitPosition} tradeHistory={tradeStore.closedTrades} />
        </div>

        {/* Trade Ticket Modal */}
        <TradeTicketModal
          open={tradeTicketOpen}
          onOpenChange={setTradeTicketOpen}
          signal={tradeTicketSignal}
          onExecute={handleTradeExecute}
          isPaperTrading={isPaperTrading}
        />
      </div>
    );
  };

  return (
    <>
      {renderContent()}
      <BrokerLoginDialog
        open={brokerDialogOpen}
        onOpenChange={setBrokerDialogOpen}
        onConnected={handleBrokerConnected}
      />
    </>
  );
};

export default Dashboard;
