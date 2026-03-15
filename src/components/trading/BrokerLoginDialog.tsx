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
import { Loader2, Shield, CheckCircle2, AlertCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface BrokerLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function BrokerLoginDialog({ open, onOpenChange, onConnected }: BrokerLoginDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const [consumerKey, setConsumerKey] = useState('');
  const [neoUserId, setNeoUserId] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');

  const resetForm = () => {
    setError('');
    setSuccess(false);
    setConsumerKey('');
    setNeoUserId('');
    setPassword('');
    setOtp('');
  };

  const handleLogin = async () => {
    if (!consumerKey || !neoUserId || !password || !otp) {
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
          userId: neoUserId,
          password,
          otp,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (!data?.success) throw new Error(data?.error || 'Login failed');

      setSuccess(true);
      toast.success('Kotak Neo connected successfully');
      onConnected();

      // Auto-close after brief success display
      setTimeout(() => {
        onOpenChange(false);
      }, 1500);
    } catch (err: any) {
      const msg = err.message || 'Connection failed';
      if (msg.toLowerCase().includes('otp')) {
        setError('Invalid OTP. Please check and try again.');
      } else if (msg.toLowerCase().includes('credential') || msg.toLowerCase().includes('password')) {
        setError('Invalid credentials. Please verify your User ID and password.');
      } else {
        setError(msg);
      }
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
            {success
              ? 'Broker connected and ready for trading.'
              : 'Enter your Kotak Neo API credentials to connect.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {success ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <CheckCircle2 className="w-12 h-12 text-profit" />
            <p className="text-sm text-profit font-semibold">KOTAK NEO CONNECTED</p>
            <p className="text-xs text-muted-foreground text-center">
              Session active. You can now execute live trades through Kotak Neo.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">CONSUMER KEY</Label>
              <Input
                value={consumerKey}
                onChange={(e) => setConsumerKey(e.target.value)}
                placeholder="Enter Kotak Neo Consumer Key"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">USER ID</Label>
              <Input
                value={neoUserId}
                onChange={(e) => setNeoUserId(e.target.value)}
                placeholder="Enter Kotak Neo User ID"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">PASSWORD</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter Kotak Neo password"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">OTP</Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter OTP from authenticator"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
              <p className="text-[10px] text-muted-foreground">
                Enter the OTP from your Kotak Neo authenticator or SMS.
              </p>
            </div>
            <Button
              onClick={handleLogin}
              disabled={loading}
              className="w-full"
              variant="buy"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> AUTHENTICATING...</>
              ) : (
                'LOGIN & GENERATE SESSION'
              )}
            </Button>
            <p className="text-[10px] text-muted-foreground text-center">
              Credentials are sent securely to backend and discarded after session generation.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
