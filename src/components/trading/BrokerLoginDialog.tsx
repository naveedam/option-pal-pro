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
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Loader2, Shield, CheckCircle2, AlertCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface BrokerLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

type Step = 'credentials' | 'otp' | 'connected';

export function BrokerLoginDialog({ open, onOpenChange, onConnected }: BrokerLoginDialogProps) {
  const [step, setStep] = useState<Step>('credentials');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState('');

  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [neoUserId, setNeoUserId] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');

  const resetForm = () => {
    setStep('credentials');
    setError('');
    setSessionId('');
    setConsumerKey('');
    setConsumerSecret('');
    setNeoUserId('');
    setPassword('');
    setOtp('');
  };

  const handleLogin = async () => {
    if (!consumerKey || !consumerSecret || !neoUserId || !password) {
      setError('All fields are required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data, error: fnError } = await supabase.functions.invoke('kotak-neo-auth', {
        body: {
          action: 'login',
          consumerKey,
          consumerSecret,
          userId: neoUserId,
          password,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (!data?.success) throw new Error(data?.error || 'Login failed');

      setSessionId(data.sessionId);
      setStep('otp');
      toast.info('OTP sent to your registered mobile number');
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) {
      setError('Enter 6-digit OTP');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data, error: fnError } = await supabase.functions.invoke('kotak-neo-auth', {
        body: {
          action: 'verify_otp',
          otp,
          sessionId,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (!data?.success) throw new Error(data?.error || 'Verification failed');

      setStep('connected');
      toast.success('Kotak Neo connected successfully');
      onConnected();
    } catch (err: any) {
      setError(err.message || 'OTP verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="bg-card border-border font-mono sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-primary terminal-glow flex items-center gap-2">
            <Shield className="w-5 h-5" />
            KOTAK NEO — CONNECT
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {step === 'credentials' && 'Enter your Kotak Neo API credentials securely.'}
            {step === 'otp' && 'Enter the OTP sent to your registered mobile.'}
            {step === 'connected' && 'Broker connected and ready for trading.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {step === 'credentials' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">CONSUMER KEY</Label>
              <Input
                value={consumerKey}
                onChange={(e) => setConsumerKey(e.target.value)}
                placeholder="Enter consumer key"
                className="bg-secondary border-border font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">CONSUMER SECRET</Label>
              <Input
                type="password"
                value={consumerSecret}
                onChange={(e) => setConsumerSecret(e.target.value)}
                placeholder="Enter consumer secret"
                className="bg-secondary border-border font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">USER ID</Label>
              <Input
                value={neoUserId}
                onChange={(e) => setNeoUserId(e.target.value)}
                placeholder="Enter Kotak Neo user ID"
                className="bg-secondary border-border font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">PASSWORD</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="bg-secondary border-border font-mono text-xs"
              />
            </div>
            <Button
              onClick={handleLogin}
              disabled={loading}
              className="w-full"
              variant="terminal"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> AUTHENTICATING...</>
              ) : (
                'GENERATE OTP →'
              )}
            </Button>
            <p className="text-[10px] text-muted-foreground text-center">
              Credentials are sent securely to backend — never stored in browser.
            </p>
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-4">
              <p className="text-xs text-muted-foreground">6-digit OTP</p>
              <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button
              onClick={handleVerifyOTP}
              disabled={loading || otp.length !== 6}
              className="w-full"
              variant="buy"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> VERIFYING...</>
              ) : (
                'VERIFY & CONNECT'
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={() => { setStep('credentials'); setOtp(''); setError(''); }}
              className="w-full text-xs"
            >
              ← Back to credentials
            </Button>
          </div>
        )}

        {step === 'connected' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <CheckCircle2 className="w-12 h-12 text-profit" />
            <p className="text-sm text-profit font-semibold">BROKER CONNECTED</p>
            <p className="text-xs text-muted-foreground text-center">
              Session active for 8 hours. You can now execute live trades through Kotak Neo.
            </p>
            <Button
              variant="terminal"
              onClick={() => onOpenChange(false)}
              className="w-full"
            >
              START TRADING
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
