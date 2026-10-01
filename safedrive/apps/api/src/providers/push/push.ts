/**
 * Push delivery providers. In-app notifications (DB + WebSocket) always work;
 * push is best effort - delivery and sound are never guaranteed by iOS/Android.
 */
import { fetchJson, type FetchFn } from '../../lib/http.js';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: boolean;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export type PushOutcome = { ok: true } | { ok: false; error: string; permanent: boolean };

export interface PushNotificationProvider {
  readonly id: string;
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
}

export class LogPushProvider implements PushNotificationProvider {
  readonly id = 'log';
  readonly sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    for (const m of messages) this.sent.push(m);
    return messages.map(() => ({ ok: true }));
  }
}

export class NoPushProvider implements PushNotificationProvider {
  readonly id = 'none';
  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    return messages.map(() => ({ ok: false, error: 'push disabled', permanent: true }));
  }
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/** Expo Push Service (works for apps built with Expo; FCM/APNs credentials live in Expo/EAS). */
export class ExpoPushProvider implements PushNotificationProvider {
  readonly id = 'expo';
  constructor(
    private readonly accessToken: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchFn?: FetchFn,
  ) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const out: PushOutcome[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const body = chunk.map((m) => ({
        to: m.token,
        title: m.title,
        body: m.body,
        data: m.data,
        sound: m.sound ? 'default' : undefined,
        priority: m.priority === 'low' ? 'normal' : 'high',
        channelId: m.priority === 'critical' ? 'critical' : m.sound ? 'alerts' : 'default',
        interruptionLevel: m.priority === 'critical' ? 'time-sensitive' : 'active',
      }));
      try {
        const res = await fetchJson<{ data?: ExpoTicket[] }>(
          'https://exp.host/--/api/v2/push/send',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
            },
            body: JSON.stringify(body),
            timeoutMs: this.timeoutMs,
            fetchFn: this.fetchFn,
          },
        );
        const tickets = res.data ?? [];
        chunk.forEach((_m, k) => {
          const t = tickets[k];
          if (t?.status === 'ok') out.push({ ok: true });
          else
            out.push({
              ok: false,
              error: t?.details?.error ?? t?.message ?? 'unknown',
              permanent: t?.details?.error === 'DeviceNotRegistered',
            });
        });
      } catch (e) {
        chunk.forEach(() => out.push({ ok: false, error: (e as Error).message, permanent: false }));
      }
    }
    return out;
  }
}
