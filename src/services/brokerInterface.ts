/**
 * Broker Abstraction Layer
 * Every broker integration must implement IBroker.
 * This makes adding Zerodha, Groww, Upstox etc. plug-and-play.
 */

export type BrokerType = 'kotak' | 'zerodha' | 'upstox' | 'angel' | 'groww';

export interface BrokerProfile {
  id: BrokerType;
  name: string;
  description: string;
  available: boolean;
  color: string;
  authType: 'otp_mpin' | 'oauth' | 'api_key';
}

export const BROKER_PROFILES: BrokerProfile[] = [
  { id: 'kotak',   name: 'Kotak Neo',    description: 'Trade API — OTP + MPIN', available: true,  color: '#FF4B00', authType: 'otp_mpin' },
  { id: 'zerodha', name: 'Zerodha Kite', description: 'Kite Connect API',       available: false, color: '#387ED1', authType: 'oauth'   },
  { id: 'upstox',  name: 'Upstox',       description: 'Upstox API v2',          available: false, color: '#6C4AF5', authType: 'oauth'   },
  { id: 'angel',   name: 'Angel One',    description: 'SmartAPI',               available: false, color: '#E6007E', authType: 'api_key' },
  { id: 'groww',   name: 'Groww',        description: 'Groww API',              available: false, color: '#00D09C', authType: 'api_key' },
];

export interface BrokerAuthParams {
  // Kotak
  consumerKey?: string;
  mobileNumber?: string;
  ucc?: string;
  totp?: string;
  mpin?: string;
  // Zerodha / OAuth
  apiKey?: string;
  apiSecret?: string;
  requestToken?: string;
  // Generic
  accessToken?: string;
}

export interface BrokerConnectResult {
  success: boolean;
  error?: string;
  sessionId?: string;
  expiresAt?: string;
}

export interface IBroker {
  readonly type: BrokerType;
  connect(params: BrokerAuthParams): Promise<BrokerConnectResult>;
  disconnect(): Promise<void>;
  getStatus(): Promise<{ auth: 'connected' | 'disconnected'; trading: 'connected' | 'disconnected'; expiresAt?: string }>;
}

/**
 * Kotak Neo broker implementation (delegates to existing edge functions)
 */
export class KotakBroker implements IBroker {
  readonly type: BrokerType = 'kotak';
  private supabase: any;

  constructor(supabaseClient: any) {
    this.supabase = supabaseClient;
  }

  async connect(params: BrokerAuthParams): Promise<BrokerConnectResult> {
    const { data, error } = await this.supabase.functions.invoke('kotak-neo-auth', {
      body: {
        action: 'login',
        consumerKey: params.consumerKey,
        mobileNumber: params.mobileNumber,
        ucc: params.ucc,
        mpin: params.mpin,
        totp: params.totp,
      },
    });
    if (error) return { success: false, error: error.message };
    if (!data?.success) return { success: false, error: data?.error || 'Login failed' };
    return { success: true, expiresAt: data?.expiresAt };
  }

  async disconnect(): Promise<void> {
    await this.supabase.functions.invoke('kotak-neo-auth', { body: { action: 'disconnect' } });
  }

  async getStatus() {
    const { data, error } = await this.supabase.functions.invoke('kotak-neo-auth', { body: { action: 'status' } });
    if (error || !data) return { auth: 'disconnected' as const, trading: 'disconnected' as const };
    return {
      auth: data.auth === 'connected' ? 'connected' as const : 'disconnected' as const,
      trading: data.trading === 'connected' ? 'connected' as const : 'disconnected' as const,
      expiresAt: data.expiresAt,
    };
  }
}

/**
 * Zerodha Kite broker — stub, ready for implementation
 */
export class ZerodhaBroker implements IBroker {
  readonly type: BrokerType = 'zerodha';
  private supabase: any;

  constructor(supabaseClient: any) {
    this.supabase = supabaseClient;
  }

  async connect(_params: BrokerAuthParams): Promise<BrokerConnectResult> {
    // TODO: implement zerodha-kite-auth edge function
    return { success: false, error: 'Zerodha integration coming soon' };
  }

  async disconnect(): Promise<void> {
    // TODO: implement
  }

  async getStatus() {
    // TODO: implement
    return { auth: 'disconnected' as const, trading: 'disconnected' as const };
  }
}

/**
 * Factory — returns the right broker implementation for a given type
 */
export function createBroker(type: BrokerType, supabaseClient: any): IBroker {
  switch (type) {
    case 'kotak':   return new KotakBroker(supabaseClient);
    case 'zerodha': return new ZerodhaBroker(supabaseClient);
    default:        throw new Error(`Broker '${type}' not yet implemented`);
  }
}
