import React from "react";
import { bankOptions, custodianOptions, useDB } from "../data/store";
import { useAuth } from "../lib/auth";
import { Select } from "./Sheet";
import { Input } from "./ui";

export type PayForm = { amount: string; date: string; mode: string; account: string; notes: string };

/** Amount (+ live words) · date · mode → the right account picker. Shared by every money form. */
export function PaymentFields({ f, set, modes = ["Bank", "Cash", "Cheque"], amountLabel = "Amount" }: { f: PayForm; set: (p: Partial<PayForm>) => void; modes?: string[]; amountLabel?: string }) {
  const { db } = useDB();
  const { can } = useAuth();
  const banking = can("banks.view");
  return (
    <>
      <Input label={amountLabel} required amount value={f.amount} onChangeText={(v) => set({ amount: v.replace(/[^\d.]/g, "") })} placeholder="0" />
      <Input label="Date" value={f.date} onChangeText={(v) => set({ date: v })} placeholder="YYYY-MM-DD" />
      <Select label="Mode" required value={f.mode} onChange={(v) => set({ mode: v, account: "" })} options={modes.map((m) => ({ value: m, label: m }))} />
      {f.mode === "Cash" && <Select label="Custodian" required value={f.account} onChange={(v) => set({ account: v })} options={custodianOptions(db, banking)} />}
      {(f.mode === "Bank" || f.mode === "Cheque") && <Select label={f.mode === "Cheque" ? "Cheque drawn on" : "Bank account"} required value={f.account} onChange={(v) => set({ account: v })} options={bankOptions(db, banking)} />}
      <Input label="Notes" value={f.notes} onChangeText={(v) => set({ notes: v })} />
    </>
  );
}
