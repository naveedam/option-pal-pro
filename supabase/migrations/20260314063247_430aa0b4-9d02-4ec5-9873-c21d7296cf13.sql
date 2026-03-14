
-- Trades table for persisting executed trades
CREATE TABLE public.trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id text NOT NULL,
  symbol text NOT NULL,
  strike integer NOT NULL,
  option_type text NOT NULL CHECK (option_type IN ('CE', 'PE')),
  quantity integer NOT NULL,
  entry_price numeric(10,2) NOT NULL,
  exit_price numeric(10,2),
  pnl numeric(10,2) DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  is_paper boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- Signals history table
CREATE TABLE public.signal_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  index_name text NOT NULL,
  strike integer NOT NULL,
  option_type text NOT NULL CHECK (option_type IN ('CE', 'PE')),
  confidence integer NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  reason text,
  price_at_signal numeric(10,2),
  action_taken text DEFAULT 'pending' CHECK (action_taken IN ('pending', 'confirmed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_history ENABLE ROW LEVEL SECURITY;

-- RLS for trades
CREATE POLICY "Users can read own trades" ON public.trades FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own trades" ON public.trades FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own trades" ON public.trades FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- RLS for signal_history
CREATE POLICY "Users can read own signals" ON public.signal_history FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own signals" ON public.signal_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own signals" ON public.signal_history FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- Enable realtime for trades
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
