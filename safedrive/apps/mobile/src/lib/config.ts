import Constants from 'expo-constants';

/** API base URL from app.json "extra.apiUrl" (10.0.2.2 = host machine from the Android emulator). */
export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://localhost:4000';
