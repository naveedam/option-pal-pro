import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface QuickTradeFABProps {
  signalCount: number;
  onClick: () => void;
}

export function QuickTradeFAB({ signalCount, onClick }: QuickTradeFABProps) {
  return (
    <Button
      onClick={onClick}
      className="fixed bottom-6 right-6 z-50 rounded-full w-14 h-14 shadow-lg bg-signal hover:bg-signal/90 text-primary-foreground"
      title="Open Trade Signals (T)"
    >
      <div className="relative">
        <Zap className="w-6 h-6" />
        {signalCount > 0 && (
          <span className="absolute -top-2 -right-2 bg-loss text-destructive-foreground text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {signalCount}
          </span>
        )}
      </div>
    </Button>
  );
}
