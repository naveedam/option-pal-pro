ALTER TABLE public.trades 
ADD COLUMN IF NOT EXISTS signal_type text,
ADD COLUMN IF NOT EXISTS signal_strategy text,
ADD COLUMN IF NOT EXISTS signal_confidence integer,
ADD COLUMN IF NOT EXISTS stop_loss numeric,
ADD COLUMN IF NOT EXISTS notes text;