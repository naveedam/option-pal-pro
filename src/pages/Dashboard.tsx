import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { BrokerStatus } from '@/components/trading/BrokerStatus';
import { SpotTicker } from '@/components/trading/SpotTicker';
import { OptionChainTable } from '@/components/trading/OptionChainTable';
import { SignalPanel } from '@/components/trading/SignalPanel';
import { PositionsPanel } from '@/components/trading/PositionsPanel';
import { RiskControls } from '@/components/trading/RiskControls';
import { useMarketData } from '@/hooks/useMarketData';

const Dashboard = () => {
  const [isPaperTrading, setIsPaperTrading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<'NIFTY' | 'SENSEX'>('NIFTY');

  const {
    marketData,
    signals,
    positions,
    tradesToday,
    dailyPnL,
    riskSettings,
    setRiskSettings,
    riskLimitReached,
    executeTrade,
    dismissSignal,
  } = useMarketData(isPaperTrading);

  const handleConfirmTrade = (signal: typeof signals[0]) => {
    const result = executeTrade(signal);
    if (result.success) {
      toast.success(`${isPaperTrading ? '📝 Paper' : '✅ Live'} order placed: ${signal.index} ${signal.strike} ${signal.optionType}`, {
        description: `Qty: ${signal.suggestedQty} @ ₹${signal.currentPrice.toFixed(2)}`,
      });
    } else {
      toast.error('Order blocked', { description: result.reason });
    }
  };

  if (!marketData) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-primary terminal-glow font-mono animate-pulse-glow">
          Initializing market data engine...
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top Bar */}
      <header className="border-b border-border px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-6">
          <h1 className="font-mono text-sm font-bold text-primary terminal-glow tracking-wider">
            OPTIQ<span className="text-muted-foreground">.TRADE</span>
          </h1>
          <BrokerStatus isConnected={true} isPaperTrading={isPaperTrading} />
        </div>

        <div className="flex items-center gap-4">
          <SpotTicker
            label="NIFTY"
            price={marketData.niftySpot}
            change={marketData.niftyChange}
            pcr={marketData.niftyPCR}
            atm={marketData.niftyATM}
          />
          <SpotTicker
            label="SENSEX"
            price={marketData.sensexSpot}
            change={marketData.sensexChange}
            pcr={marketData.sensexPCR}
            atm={marketData.sensexATM}
          />
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-xs font-mono ${isPaperTrading ? 'text-warning' : 'text-loss'}`}>
            {isPaperTrading ? '📝 PAPER' : '🔴 LIVE'}
          </span>
          <Switch
            checked={!isPaperTrading}
            onCheckedChange={(checked) => {
              if (checked) {
                toast.warning('Live trading requires Kotak Neo connection', {
                  description: 'Connect your broker account first',
                });
              }
              setIsPaperTrading(!checked);
            }}
          />
        </div>
      </header>

      {/* Risk Controls */}
      <div className="px-4 py-2 flex-shrink-0">
        <RiskControls
          settings={riskSettings}
          onUpdate={setRiskSettings}
          tradesToday={tradesToday}
          dailyPnL={dailyPnL}
          riskLimitReached={riskLimitReached}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 px-4 pb-3 gap-3">
        {/* Option Chain - Center */}
        <div className="flex-1 flex flex-col min-h-0">
          <Tabs value={selectedIndex} onValueChange={(v) => setSelectedIndex(v as 'NIFTY' | 'SENSEX')} className="flex flex-col flex-1 min-h-0">
            <TabsList className="bg-secondary border border-border w-fit self-start mb-2">
              <TabsTrigger value="NIFTY" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                NIFTY
              </TabsTrigger>
              <TabsTrigger value="SENSEX" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                SENSEX
              </TabsTrigger>
            </TabsList>
            <TabsContent value="NIFTY" className="flex-1 min-h-0 mt-0">
              <OptionChainTable chain={marketData.niftyChain} index="NIFTY" />
            </TabsContent>
            <TabsContent value="SENSEX" className="flex-1 min-h-0 mt-0">
              <OptionChainTable chain={marketData.sensexChain} index="SENSEX" />
            </TabsContent>
          </Tabs>
        </div>

        {/* Signal Panel - Right */}
        <div className="w-[300px] flex-shrink-0">
          <SignalPanel
            signals={signals}
            onConfirm={handleConfirmTrade}
            onDismiss={dismissSignal}
            riskLimitReached={riskLimitReached}
          />
        </div>
      </div>

      {/* Bottom - Positions */}
      <div className="px-4 pb-3 h-[200px] flex-shrink-0">
        <PositionsPanel
          positions={positions}
          dailyPnL={dailyPnL}
          tradesToday={tradesToday}
        />
      </div>
    </div>
  );
};

export default Dashboard;
