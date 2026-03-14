import { useMemo } from 'react';
import type { OptionData } from './useMarketData';

export type SmartMoneyLabel =
  | 'CALL_WRITING'
  | 'PUT_WRITING'
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING';

export interface SmartMoneyEvent {
  strike: number;
  label: SmartMoneyLabel;
  intensity: number; // 0-100
  side: 'call' | 'put';
}

export interface StrikeAnalysis {
  strike: number;
  callHeatIntensity: number; // 0-100 for heatmap coloring
  putHeatIntensity: number;
  events: SmartMoneyEvent[];
  isSupport: boolean;
  isResistance: boolean;
  isGammaWall: boolean;
}

export interface SmartMoneyAnalysis {
  strikeAnalysis: Map<number, StrikeAnalysis>;
  supportLevel: number;
  resistanceLevel: number;
  gammaWall: number;
  maxCallOIStrike: number;
  maxPutOIStrike: number;
}

function classifyActivity(row: OptionData): SmartMoneyEvent[] {
  const events: SmartMoneyEvent[] = [];
  const OI_THRESHOLD = 20000;
  const VOLUME_THRESHOLD = 5000;
  const OI_CHANGE_THRESHOLD = 2000;

  // Call writing: High call OI increase + price not rising significantly
  if (row.callOIChange > OI_CHANGE_THRESHOLD && row.callOI > OI_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'CALL_WRITING',
      intensity: Math.min(100, Math.round((row.callOIChange / 5000) * 100)),
      side: 'call',
    });
  }

  // Put writing: High put OI increase
  if (row.putOIChange > OI_CHANGE_THRESHOLD && row.putOI > OI_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'PUT_WRITING',
      intensity: Math.min(100, Math.round((row.putOIChange / 5000) * 100)),
      side: 'put',
    });
  }

  // Long buildup: Call OI increase + volume spike
  if (row.callOIChange > OI_CHANGE_THRESHOLD && row.callVolume > VOLUME_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'LONG_BUILDUP',
      intensity: Math.min(100, Math.round((row.callVolume / 10000) * 100)),
      side: 'call',
    });
  }

  // Short buildup: Put OI increase + volume spike
  if (row.putOIChange > OI_CHANGE_THRESHOLD && row.putVolume > VOLUME_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'SHORT_BUILDUP',
      intensity: Math.min(100, Math.round((row.putVolume / 10000) * 100)),
      side: 'put',
    });
  }

  // Short covering: Call OI decrease + price increase
  if (row.callOIChange < -OI_CHANGE_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'SHORT_COVERING',
      intensity: Math.min(100, Math.round((Math.abs(row.callOIChange) / 5000) * 100)),
      side: 'call',
    });
  }

  // Long unwinding: Put OI decrease
  if (row.putOIChange < -OI_CHANGE_THRESHOLD) {
    events.push({
      strike: row.strike,
      label: 'LONG_UNWINDING',
      intensity: Math.min(100, Math.round((Math.abs(row.putOIChange) / 5000) * 100)),
      side: 'put',
    });
  }

  return events;
}

export function useSmartMoney(chain: OptionData[]): SmartMoneyAnalysis {
  return useMemo(() => {
    const strikeAnalysis = new Map<number, StrikeAnalysis>();

    let maxCallOI = 0, maxPutOI = 0;
    let maxCallOIStrike = 0, maxPutOIStrike = 0;

    // First pass: find max OI strikes for support/resistance
    for (const row of chain) {
      if (row.callOI > maxCallOI) { maxCallOI = row.callOI; maxCallOIStrike = row.strike; }
      if (row.putOI > maxPutOI) { maxPutOI = row.putOI; maxPutOIStrike = row.strike; }
    }

    // Second pass: classify each strike
    for (const row of chain) {
      const events = classifyActivity(row);
      const callHeatIntensity = maxCallOI > 0 ? Math.round((row.callOI / maxCallOI) * 100) : 0;
      const putHeatIntensity = maxPutOI > 0 ? Math.round((row.putOI / maxPutOI) * 100) : 0;

      // Gamma wall: highest combined OI
      const isGammaWall = row.callOI + row.putOI > (maxCallOI + maxPutOI) * 0.8;

      strikeAnalysis.set(row.strike, {
        strike: row.strike,
        callHeatIntensity,
        putHeatIntensity,
        events,
        isSupport: row.strike === maxPutOIStrike,
        isResistance: row.strike === maxCallOIStrike,
        isGammaWall,
      });
    }

    return {
      strikeAnalysis,
      supportLevel: maxPutOIStrike,
      resistanceLevel: maxCallOIStrike,
      gammaWall: maxCallOIStrike, // simplified
      maxCallOIStrike,
      maxPutOIStrike,
    };
  }, [chain]);
}

export const LABEL_COLORS: Record<SmartMoneyLabel, string> = {
  CALL_WRITING: 'text-loss',
  PUT_WRITING: 'text-profit',
  LONG_BUILDUP: 'text-profit',
  SHORT_BUILDUP: 'text-loss',
  SHORT_COVERING: 'text-warning',
  LONG_UNWINDING: 'text-warning',
};

export const LABEL_SHORT: Record<SmartMoneyLabel, string> = {
  CALL_WRITING: 'CW',
  PUT_WRITING: 'PW',
  LONG_BUILDUP: 'LB',
  SHORT_BUILDUP: 'SB',
  SHORT_COVERING: 'SC',
  LONG_UNWINDING: 'LU',
};
