import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { type Severity } from '@safedrive/core';

export const SEVERITY_COLORS: Record<Severity, string> = {
  SAFE: '#16a34a',
  ATTENTION: '#eab308',
  WARNING: '#f97316',
  CRITICAL: '#dc2626',
};

export const colors = {
  bg: '#f4f6fb',
  card: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  primary: '#2563eb',
  danger: '#dc2626',
  border: '#e2e8f0',
};

export function Button(props: {
  title: string;
  onPress?: () => void;
  onLongPress?: () => void;
  kind?: 'primary' | 'danger' | 'ghost';
  big?: boolean;
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const kind = props.kind ?? 'primary';
  const bg =
    kind === 'primary' ? colors.primary : kind === 'danger' ? colors.danger : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={800}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: bg,
          opacity: pressed || props.disabled ? 0.7 : 1,
          borderWidth: kind === 'ghost' ? 1 : 0,
        },
        props.big && styles.big,
        props.style,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={kind === 'ghost' ? colors.primary : '#fff'} />
      ) : (
        <Text
          style={[
            styles.btnText,
            { color: kind === 'ghost' ? colors.primary : '#fff' },
            props.big && { fontSize: 24 },
          ]}
        >
          {props.title}
        </Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field(props: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput {...props} style={styles.input} placeholderTextColor={colors.muted} />
    </View>
  );
}

export function Banner({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.banner, { backgroundColor: color }]} accessibilityLiveRegion="polite">
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 16, gap: 12 },
  h1: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'left' },
  h2: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'left' },
  p: { fontSize: 15, color: colors.text, textAlign: 'left', lineHeight: 22 },
  muted: { fontSize: 13, color: colors.muted, textAlign: 'left' },
  error: { color: colors.danger, textAlign: 'left' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  btn: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderColor: colors.primary,
  },
  big: { paddingVertical: 26, borderRadius: 20 },
  btnText: { fontSize: 17, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: { fontSize: 14, color: colors.muted, marginBottom: 4, textAlign: 'left' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
    color: colors.text,
  },
  banner: { padding: 10, borderRadius: 10 },
  bannerText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
});
