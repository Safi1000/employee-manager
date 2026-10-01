import { Check, ChevronDown, X } from "lucide-react-native";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Animated, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { registerToastSink, shouldSwallowToast } from "../data/store";
import { useTheme } from "../theme/ThemeProvider";
import { fonts, radius, Tone } from "../theme/tokens";
import { T } from "./Text";
import { Button, SearchBar, tap } from "./ui";

// ---------------------------------------------------------------- Sheet
// Replaces the web Modal. Body is the only scroller, footer is pinned (handoff A8),
// and it rises from the thumb zone instead of centring.
export function Sheet({
  open, onClose, title, subtitle, children, footer, error, full,
}: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode; error?: string | null; full?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: "flex-end" }}>
          <Pressable onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.overlay }} />
          <View
            style={{
              backgroundColor: t.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "92%",
              height: full ? "92%" : undefined, borderWidth: 1, borderColor: t.border, overflow: "hidden",
            }}
          >
            <View style={{ alignItems: "center", paddingTop: 8 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: t.borderStrong }} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <View style={{ flex: 1 }}>
                <T v="title" numberOfLines={2}>{title}</T>
                {subtitle ? <T v="small" muted style={{ marginTop: 2 }}>{subtitle}</T> : null}
              </View>
              <Pressable onPress={onClose} hitSlop={10} style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.muted, alignItems: "center", justifyContent: "center" }}>
                <X size={18} color={t.fg} />
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: footer ? 18 : 18 + insets.bottom }} style={{ flexGrow: full ? 1 : 0 }}>
              {error ? (
                <View style={{ backgroundColor: t.tone("danger").tint, borderColor: t.tone("danger").line, borderWidth: 1, borderRadius: radius.lg, padding: 12, marginBottom: 14 }}>
                  <T v="smallStrong" color={t.tone("danger").text}>{error}</T>
                </View>
              ) : null}
              {children}
            </ScrollView>
            {footer ? (
              <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12 + insets.bottom, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.card }}>
                {footer}
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------- Select (ThemedSelect)
export type Option = { value: string; label: string; sub?: string };

export function Select({
  label, value, options, onChange, placeholder = "Select…", required, searchable, compact, clearable, sheetTitle,
}: { sheetTitle?: string; label?: string; value: string | null; options: Option[]; onChange: (v: string) => void; placeholder?: string; required?: boolean; searchable?: boolean; compact?: boolean; clearable?: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const current = options.find((o) => o.value === value);
  const shown = q ? options.filter((o) => (o.label + " " + (o.sub ?? "")).toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <View style={{ marginBottom: compact ? 0 : 14, flexGrow: compact ? 1 : undefined }}>
      {label && !compact ? (
        <T v="smallStrong" soft style={{ marginBottom: 6 }}>
          {label}
          {required ? <T v="smallStrong" color={t.tone("danger").text}> *</T> : null}
        </T>
      ) : null}
      <Pressable
        onPress={() => { tap(); setOpen(true); }}
        style={{
          height: compact ? 38 : 48, borderRadius: radius.lg, backgroundColor: compact ? t.card : t.input, borderWidth: 1,
          borderColor: current && compact ? t.tone("brand").line : t.border, paddingHorizontal: compact ? 11 : 14, flexDirection: "row", alignItems: "center", gap: 6,
        }}
      >
        {compact && label ? <T v="small" muted>{label}:</T> : null}
        <T v={compact ? "smallStrong" : "body"} numberOfLines={1} style={{ flex: compact ? undefined : 1, flexShrink: 1 }} color={current ? t.fg : t.mutedFg}>
          {current ? current.label : placeholder}
        </T>
        {compact ? <View style={{ flex: 1 }} /> : null}
        <ChevronDown size={16} color={t.mutedFg} />
      </Pressable>
      <Sheet open={open} onClose={() => { setOpen(false); setQ(""); }} title={sheetTitle || label || "Select"}>
        {(searchable || options.length > 8) && (
          <View style={{ marginBottom: 12 }}>
            <SearchBar value={q} onChange={setQ} placeholder="Filter…" />
          </View>
        )}
        {clearable && value ? (
          <Pressable onPress={() => { onChange(""); setOpen(false); setQ(""); }} style={{ paddingVertical: 12 }}>
            <T v="smallStrong" color={t.tone("danger").text}>Clear selection</T>
          </Pressable>
        ) : null}
        {shown.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => { tap(); onChange(o.value); setOpen(false); setQ(""); }}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 13, paddingHorizontal: 12, borderRadius: radius.lg,
                backgroundColor: on ? t.tone("brand").tint : pressed ? t.muted : "transparent", marginBottom: 2,
              })}
            >
              <View style={{ flex: 1 }}>
                <T v={on ? "bodyStrong" : "body"}>{o.label}</T>
                {o.sub ? <T v="mono" muted style={{ fontSize: 12 }}>{o.sub}</T> : null}
              </View>
              {on && <Check size={18} color={t.tone("brand").text} />}
            </Pressable>
          );
        })}
        {shown.length === 0 && <T v="small" muted center style={{ paddingVertical: 20 }}>No matches</T>}
      </Sheet>
    </View>
  );
}

// ---------------------------------------------------------------- Toasts + confirm
// The web shows inline banners at the top of the scroller, which phones never see
// after acting further down (handoff gap #10). Here, results surface as toasts,
// and destructive confirms are in-app sheets instead of window.confirm().

type ToastMsg = { id: number; text: string; tone: Tone };
type ConfirmReq = { title: string; message?: string; confirmLabel?: string; tone?: "danger" | "primary"; typed?: string; resolve: (ok: boolean) => void };

const OverlayCtx = createContext<{ toast: (text: string, tone?: Tone) => void; confirm: (o: Omit<ConfirmReq, "resolve">) => Promise<boolean> } | null>(null);

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const [typed, setTyped] = useState("");
  const idRef = useRef(0);

  const toast = useCallback((text: string, tone: Tone = "success") => {
    // Live mode: a screen's "saved" toast after a refused commit() is dropped.
    if (shouldSwallowToast(tone)) return;
    const id = ++idRef.current;
    setToasts((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((x) => x.filter((m) => m.id !== id)), 2800);
  }, []);
  useEffect(() => { registerToastSink(toast); return () => registerToastSink(null); }, [toast]);
  const confirm = useCallback((o: Omit<ConfirmReq, "resolve">) => new Promise<boolean>((resolve) => { setTyped(""); setReq({ ...o, resolve }); }), []);
  const done = (ok: boolean) => { req?.resolve(ok); setReq(null); };

  return (
    <OverlayCtx.Provider value={{ toast, confirm }}>
      {children}
      <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, top: insets.top + 8, gap: 8 }}>
        {toasts.map((m) => <ToastView key={m.id} m={m} />)}
      </View>
      <Sheet
        open={!!req}
        onClose={() => done(false)}
        title={req?.title ?? ""}
        footer={
          <>
            <Button label="Cancel" variant="secondary" full onPress={() => done(false)} />
            <Button
              label={req?.confirmLabel ?? "Confirm"}
              variant={req?.tone === "danger" ? "danger" : "primary"}
              full
              disabled={!!req?.typed && typed.trim() !== req.typed}
              onPress={() => done(true)}
            />
          </>
        }
      >
        {req?.message ? <T v="body" soft>{req.message}</T> : null}
        {req?.typed ? (
          <View style={{ marginTop: 14 }}>
            <T v="small" muted style={{ marginBottom: 6 }}>Type <T v="mono">{req.typed}</T> to confirm</T>
            <TypedInput value={typed} onChange={setTyped} />
          </View>
        ) : null}
      </Sheet>
    </OverlayCtx.Provider>
  );

}

function ToastView({ m }: { m: ToastMsg }) {
    const t = useTheme();
    const [a] = useState(() => new Animated.Value(0));
    useEffect(() => { Animated.spring(a, { toValue: 1, useNativeDriver: Platform.OS !== "web" }).start(); }, [a]);
    const tn = t.tone(m.tone);
    return (
      <Animated.View
        style={{
          opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }],
          backgroundColor: t.fg, borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10,
          shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6,
        }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tn.solid }} />
        <T v="smallStrong" color={t.bg} style={{ flex: 1, fontSize: 14 }}>{m.text}</T>
      </Animated.View>
    );
  }

function TypedInput({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const t = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      autoCapitalize="none"
      style={{ height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.input, color: t.fg, paddingHorizontal: 14, fontFamily: fonts.mono, fontSize: 16 }}
    />
  );
}

export function useOverlay() {
  const c = useContext(OverlayCtx);
  if (!c) throw new Error("OverlayProvider missing");
  return c;
}
