// My expense and advance requests (0622) — only the caller's own, never anyone
// else's, and never the Expenses tab. A request is just that: it waits for the
// office to approve it on the web, and the office then records it in the books.
// Nothing here touches money.
import { useRouter } from "expo-router";
import { Plus, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Empty } from "../../components/ui";
import { useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { useTheme } from "../../theme/ThemeProvider";

type MoneyRow = {
  id: string; kind: "expense" | "advance"; amount: number; category: string | null; description: string; expense_date: string;
  status: "pending" | "approved" | "returned" | "rejected"; decision_note: string | null; decided_by_name: string | null; recorded: boolean; created_at: string;
};
const rupees = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

export default function MyRequests() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { call } = useField();
  const [rows, setRows] = useState<MoneyRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await call<MoneyRow[]>("field_my_requests", {})) ?? []); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const tone = (s: MoneyRow["status"]) => (s === "approved" ? "success" : s === "pending" ? "warning" : "danger") as "success" | "warning" | "danger";
  const word = (r: MoneyRow) => tr(r.status === "approved" ? (r.recorded ? "Approved · recorded" : "Approved") : r.status === "pending" ? "Waiting" : r.status === "returned" ? "Returned" : "Rejected");
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScreenHeader title={tr("My expenses")} sub={tr("Only what you sent. The office approves on the web.")} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label={tr("Expense")} icon={Plus} style={{ flex: 1 }} onPress={() => router.push({ pathname: "/money/new", params: { kind: "expense" } })} />
        <Button label={tr("Advance")} icon={Plus} variant="secondary" style={{ flex: 1 }} onPress={() => router.push({ pathname: "/money/new", params: { kind: "advance" } })} />
      </View>
      {rows && rows.length === 0 ? <Empty icon={Wallet} title={tr("Nothing sent yet")} /> : null}
      {(rows ?? []).map((r) => (
        <Card key={r.id} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <T v="bodyStrong" style={{ flex: 1 }}>{rupees(r.amount)} · {tr(r.kind === "advance" ? "Advance" : "Expense")}</T>
            <Badge label={word(r)} tone={tone(r.status)} />
          </View>
          <T v="body" soft>{[r.category, r.description].filter(Boolean).join(" — ")}</T>
          <T v="small" muted>{new Date(`${r.expense_date}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}
            {r.decided_by_name ? ` · ${r.decided_by_name}` : ""}{r.decision_note ? ` — ${r.decision_note}` : ""}</T>
        </Card>
      ))}
    </ScrollView>
  );
}
