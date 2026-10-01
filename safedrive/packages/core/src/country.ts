/**
 * Country / market configuration. Adding a country = adding a profile (plus
 * provider configuration), not changing application code.
 */
import { type SpeedUnit } from './units.js';

export interface EmergencyNumber {
  number: string;
  /** i18n key, e.g. "emergency.police". */
  labelKey: string;
  kind: 'police' | 'ambulance' | 'fire' | 'general';
}

export interface CountryProfile {
  code: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  timezone: string;
  speedUnit: SpeedUnit;
  emergencyNumbers: EmergencyNumber[];
  /** Ordered provider ids to try for speed limits in this country. */
  speedLimitProviders: string[];
  /** Default data retention (days) - see PRIVACY.md. Legal review required per country. */
  retention: { rawTelemetryDays: number; tripSummaryDays: number; auditLogDays: number };
  /** Minimum age to create an account without a guardian (legal review required). */
  minAccountAge: number;
}

export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  IL: {
    code: 'IL',
    defaultLanguage: 'he',
    supportedLanguages: ['he', 'en'],
    timezone: 'Asia/Jerusalem',
    speedUnit: 'kmh',
    emergencyNumbers: [
      { number: '100', labelKey: 'emergency.police', kind: 'police' },
      { number: '101', labelKey: 'emergency.ambulance', kind: 'ambulance' },
      { number: '102', labelKey: 'emergency.fire', kind: 'fire' },
    ],
    speedLimitProviders: ['here', 'tomtom', 'osm'],
    retention: { rawTelemetryDays: 30, tripSummaryDays: 365, auditLogDays: 730 },
    minAccountAge: 16,
  },
};

export const DEFAULT_COUNTRY = 'IL';

export function countryProfile(code: string | null | undefined): CountryProfile {
  const p = code ? COUNTRY_PROFILES[code.toUpperCase()] : undefined;
  return p ?? (COUNTRY_PROFILES[DEFAULT_COUNTRY] as CountryProfile);
}
