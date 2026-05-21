import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Loader2, Shield, CheckCircle2, AlertCircle, ChevronLeft } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { BrokerSessionState } from '@/services/brokerSession';

type BrokerChoice = 'kotak' | 'zerodha' | 'groww' | 'upstox' | 'angel';

interface BrokerOption {
  id: BrokerChoice;
  name: string;
  description: string;
  available: boolean;
  color: string;
}

const BROKERS: BrokerOption[] = [
  { id: 'kotak', name: 'Kotak Neo', description: 'Trade API — OTP + MPIN auth', available: true, color: 'text-[#FF4B00]' },
  { id: 'zerodha', name: 'Zerodha Kite', description: 'Kite Connect API', available: false, color: 'text-[#387ED1]' },
  { id: 'upstox', name: 'Upstox', description: 'Upstox API v2', available: false, color: 'text-[#6C4AF5]' },
  { id: 'angel', name: 'Angel One', description: 'SmartAPI', available: false, color: 'text-[#E6007E]' },
  { id: 'groww', name: 'Groww', description: 'Groww API', available: false, color: 'text-[#00D09C]' },
];

interface BrokerLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<BrokerSessionState>;
  onConnect?: (brokerType: any, params: any) => Promise<{ success: boolean; error?: string; brokerState?: BrokerSessionState }>;
}

export function BrokerLoginDialog({ open, onOpenChange, onConnected, onConnect }: BrokerLoginDialogProps) {
  const [step, setStep] = useState<'select' | 'form'>('select');
  const [selectedBroker, setSelectedBroker] = useState<BrokerChoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [consumerKey, setConsumerKey] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [ucc, setUcc] = useState('');
  const [totp, setTotp] = useState('');
  const [mpin, setMpin] = useState('');

  const resetForm = () => {
    setStep('select');
    setSelectedBroker(null);
    setError('');
    setSuccess(false);
    setConsumerKey('');
    setMobileNumber('');
    setUcc('');
    setTotp('');
    setMpin('');
  };

  const handleBrokerSelect = (broker: BrokerOption) => {
    if (!broker.available) return;
    setSelectedBroker(broker.id);
    setStep('form');
  };

  const handleLogin = async () => {
    const loginPayload = {
      consumerKey: consumerKey.trim(),
      mobileNumber: mobileNumber.trim(),
      ucc: ucc.trim().toUpperCase(),
      mpin: mpin.trim(),
      totp: totp.trim(),
    };
    if (!loginPayload.consumerKey || !loginPayload.mobileNumber || !loginPayload.ucc || !loginPayload.mpin || !loginPayload.totp) {
      setError('All fields are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      let marketReady = false;
      if (onConnect) {
        const result = await onConnect('kotak', loginPayload);
        if (!result.success) { setError(result.error || 'Login failed'); return; }
        marketReady = result.brokerState?.marketData === 'connected';
      } else {
        const { data, error: fnError } = await supabase.functions.invoke('kotak-neo-auth', {
          body: { action: 'login', ...loginPayload },
        });
        if (fnError) throw new Error(fnError.message);
        if (!data?.success) { setError(data?.error || 'Login failed'); return; }
        const brokerState = await onConnected();
        marketReady = brokerState.marketData === 'connected';
      }
      setSuccess(true);
      toast.success(marketReady ? 'Kotak Neo connected successfully' : 'Broker login succeeded — market feed connecting');
      setTimeout(() => onOpenChange(false), 1500);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) resetForm(); onOpenChange(isOpen); }}>
      <DialogContent className="bg-card border-border font-mono sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-primary terminal-glow flex items-center gap-2">
            <Shield className="w-5 h-5" />
            {step === 'select' ? 'SELECT BROKER' : `${BROKERS.find(b => b.id === selectedBroker)?.name.toUpperCase()} — CONNECT`}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {step === 'select' ? 'Choose your broker to connect live market data and trading.' : 'Enter your API credentials to connect.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' && (
          <div className="space-y-2 py-1">
            {BROKERS.map((broker) => (
              <button
                key={broker.id}
                onClick={() => handleBrokerSelect(broker)}
                disabled={!broker.available}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-md border transition-colors text-left
                  ${broker.available
                    ? 'border-border hover:border-primary hover:bg-secondary/50 cursor-pointer'
                    : 'border-border/40 opacity-40 cursor-not-allowed'}`}
              >
                <div>
                  <div className={`text-sm font-bold ${broker.available ? broker.color : 'text-muted-foreground'}`}>
                    {broker.name}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{broker.description}</div>
                </div>
                {broker.available ? (
                  <span className="text-[9px] font-bold text-profit border border-profit/30 rounded px-1.5 py-0.5">LIVE</span>
                ) : (
                  <span className="text-[9px] font-bold text-muted-foreground border border-border rounded px-1.5 py-0.5">SOON</span>
                )}
              </button>
            ))}
            <p className="text-[10px] text-muted-foreground text-center pt-1">
              More brokers coming soon. Request via feedback.
            </p>
          </div>
        )}

        {step === 'form' && selectedBroker === 'kotak' && (
          <>
            <button onClick={() => setStep('select')} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground -mt-1 mb-1">
              <ChevronLeft className="w-3 h-3" /> Back to broker selection
            </button>
            {error && (
              <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/20 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
            {success ? (
              <div className="flex flex-col items-center gap-4 py-4">
                <CheckCircle2 className="w-12 h-12 text-profit" />
                <p className="text-sm text-profit font-semibold">KOTAK NEO CONNECTED</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">CONSUMER KEY</Label>
                  <Input value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} placeholder="From Trade API dashboard" className="bg-secondary border-border font-mono text-xs" disabled={loading} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">MOBILE NUMBER</Label>
                  <Input value={mobileNumber} onChange={(e) => setMobileNumber(e.target.value)} placeholder="+919999999999" className="bg-secondary border-border font-mono text-xs" disabled={loading} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">UCC (CLIENT CODE)</Label>
                  <Input value={ucc} onChange={(e) => setUcc(e.target.value.toUpperCase())} placeholder="e.g. ABC12" className="bg-secondary border-border font-mono text-xs" disabled={loading} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">TOTP</Label>
                    <Input type="text" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} placeholder="6-digit TOTP" className="bg-secondary border-border font-mono text-xs" disabled={loading} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">MPIN</Label>
                    <Input type="password" inputMode="numeric" maxLength={6} value={mpin} onChange={(e) => setMpin(e.target.value.replace(/\D/g, ''))} placeholder="6-digit MPIN" className="bg-secondary border-border font-mono text-xs" disabled={loading} />
                  </div>
                </div>
                <Button onClick={handleLogin} disabled={loading} className="w-full" variant="buy">
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> AUTHENTICATING...</> : 'LOGIN & GENERATE SESSION'}
                </Button>
                <p className="text-[10px] text-muted-foreground text-center">
                  Credentials sent securely to backend and discarded after session generation.
                </p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
