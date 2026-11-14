-- Stock screener / stock signals removed from the app (replaced by closing-auction aware index signals).
drop table if exists public.stock_signals;
drop table if exists public.screener_cache;
