/**
 * Navigation providers: SafeDrive only hands off to the user's navigation app via
 * official public deep links. It never reads data from Waze or Google Maps (no
 * scraping, no private APIs) - speed limits come from the backend providers.
 */
import { Linking, Platform } from 'react-native';

export interface NavigationProvider {
  id: 'waze' | 'google' | 'apple';
  label: string;
  url(lat: number, lon: number): string;
}

export const NAVIGATION_PROVIDERS: NavigationProvider[] = [
  {
    id: 'waze',
    label: 'Waze',
    url: (lat, lon) => `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`,
  },
  {
    id: 'google',
    label: 'Google Maps',
    url: (lat, lon) =>
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`,
  },
  ...(Platform.OS === 'ios'
    ? [
        {
          id: 'apple' as const,
          label: 'Apple Maps',
          url: (lat: number, lon: number) => `http://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`,
        },
      ]
    : []),
];

/** Opens a navigation app. Monitoring continues in the background (needs "Always" location). */
export async function openNavigation(
  p: NavigationProvider,
  lat: number,
  lon: number,
): Promise<void> {
  await Linking.openURL(p.url(lat, lon));
}

/** Opens a navigation app without a destination (user picks one there). */
export async function openNavigationApp(id: NavigationProvider['id']): Promise<void> {
  const url =
    id === 'waze'
      ? 'https://waze.com/ul'
      : id === 'google'
        ? 'https://www.google.com/maps'
        : 'http://maps.apple.com/';
  await Linking.openURL(url);
}
