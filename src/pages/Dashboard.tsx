import { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { BrokerStatus } from '@/components/trading/BrokerStatus';
import { BrokerLoginDialog } from '@/components/trading/BrokerLoginDialog';
import { SpotTicker } from '@/components/trading/SpotTicker';
import { OptionChainTable } from '@/components/trading/OptionChainTable';
import { SignalPanel } from '@/components/trading/SignalPanel';
import { PositionsPanel } from '@/components/trading/PositionsPanel';
import { RiskControls } from '@/components/trading/RiskControls';
import { useMarketData } from '@/hooks/useMarketData';
import { useBrokerConnection } from '@/hooks/useBrokerConnection';
import { supabase } from '@/integrations/supabase/client';
import { LogOut, Plug } from 'lucide-react';

const Dashboard = () => {
  const [isPaperTrading, setIsPaperTrading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<'NIFTY' | 'SENSEX'>('NIFTY');
  const [brokerDialogOpen, setBrokerDialogOpen] = useState(false);

  const broker = useBrokerConnection();

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

  const handleLogout = async () => {
    await supabase.auth.signOut();
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
          <BrokerStatus isConnected={broker.isConnected} isPaperTrading={isPaperTrading} />
          {!broker.isConnected && (
            <Button
              variant="terminal"
              size="sm"
              onClick={() => setBrokerDialogOpen(true)}
              className="text-xs gap-1"
            >
              <Plug className="w-3 h-3" />
              CONNECT BROKER
            </Button>
          )}
          {broker.isConnected && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await broker.disconnect();
                setIsPaperTrading(true);
                toast.info('Broker disconnected');
              }}
              className="text-xs text-muted-foreground"
            >
              DISCONNECT
            </Button>
          )}
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

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono ${isPaperTrading ? 'text-warning' : 'text-loss'}`}>
              {isPaperTrading ? '📝 PAPER' : '🔴 LIVE'}
            </span>
            <Switch
              checked={!isPaperTrading}
              onCheckedChange={(checked) => {
                if (checked && !broker.isConnected) {
                  toast.warning('Connect Kotak Neo broker first', {
                    description: 'Click CONNECT BROKER to link your account',
                  });
                  setBrokerDialogOpen(true);
                  return;
                }
                setIsPaperTrading(!checked);
              }}
            />
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} className="text-muted-foreground">
            <LogOut className="w-4 h-4" />
          </Button>
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

      {/* Broker Login Dialog */}
      <BrokerLoginDialog
        open={brokerDialogOpen}
        onOpenChange={setBrokerDialogOpen}
        onConnected={() => broker.refresh()}
      />
    </div>
  );
};

export default Dashboard;
