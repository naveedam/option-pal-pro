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
  const [mobileNumber, setMobileNumber] = useState('');
  const [ucc, setUcc] = useState('');
  const [totp, setTotp] = useState('');
  const [mpin, setMpin] = useState('');

  const resetForm = () => {
    setError('');
    setSuccess(false);
    setConsumerKey('');
    setMobileNumber('');
    setUcc('');
    setTotp('');
    setMpin('');
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
      console.log('SENDING PAYLOAD:', {
        consumerKey: loginPayload.consumerKey ? '[provided]' : '',
        mobileNumber: loginPayload.mobileNumber,
        ucc: loginPayload.ucc,
        mpin: loginPayload.mpin ? '[provided]' : '',
        totp: loginPayload.totp ? '[provided]' : '',
      });

      const { data, error: fnError } = await supabase.functions.invoke('kotak-neo-auth', {
        body: {
          action: 'login',
          ...loginPayload,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (!data?.success) {
        setError(data?.error || 'Login failed');
        return;
      }

      setSuccess(true);
      toast.success('Kotak Neo connected successfully');
      onConnected();

      setTimeout(() => {
        onOpenChange(false);
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
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
            <span className="break-all">{error}</span>
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
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">CONSUMER KEY</Label>
              <Input
                value={consumerKey}
                onChange={(e) => setConsumerKey(e.target.value)}
                placeholder="From Trade API dashboard"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">MOBILE NUMBER</Label>
              <Input
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                placeholder="Registered mobile (e.g. +919999999999)"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">UCC (UNIQUE CLIENT CODE)</Label>
              <Input
                value={ucc}
                onChange={(e) => setUcc(e.target.value.toUpperCase())}
                placeholder="Your client code (e.g. ABC12)"
                className="bg-secondary border-border font-mono text-xs"
                disabled={loading}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">TOTP</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit TOTP"
                  className="bg-secondary border-border font-mono text-xs"
                  disabled={loading}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">MPIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={mpin}
                  onChange={(e) => setMpin(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit MPIN"
                  className="bg-secondary border-border font-mono text-xs"
                  disabled={loading}
                />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              TOTP from your authenticator app. MPIN is your 6-digit trading PIN.
            </p>
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
