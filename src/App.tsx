import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useNavigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { supabase } from '@/integrations/supabase/client';
import { Session } from '@supabase/supabase-js';
import Dashboard from "./pages/Dashboard";
import AuthPage from "./pages/AuthPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  return { session, isReady };
}

function AuthRedirect() {
  const { session, isReady } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isReady) return;
    if (session) {
      navigate('/dashboard', { replace: true });
    }
  }, [session, isReady, navigate]);

  if (!isReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-primary terminal-glow font-mono animate-pulse-glow">
          Restoring session...
        </div>
      </div>
    );
  }

  if (session) return null;
  return <AuthPage />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, isReady } = useAuth();

  if (!isReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-primary terminal-glow font-mono animate-pulse-glow">
          Restoring session...
        </div>
      </div>
    );
  }

  if (!session) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthRedirect />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/" element={<Navigate to="/auth" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
