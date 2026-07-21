import { LucideIcon } from "lucide-react";
import { tone, type Tone } from "../lib/tone";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: string;
    positive: boolean;
  };
  /** Tone drives the left-accent border + icon tint. Defaults to brand. */
  tone?: Tone;
}

export default function StatCard({ title, value, icon: Icon, trend, tone: toneProp = "brand" }: StatCardProps) {
  const t = tone[toneProp];
  return (
    <div className={`${t.statCard} p-5 md:p-6 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-2">{title}</p>
          <p className={`text-3xl font-semibold tabular-nums tracking-tight mb-1.5 ${t.text}`} style={{ fontFamily: "var(--font-display)" }}>{value}</p>
          {trend && (
            <p
              className={
                trend.positive
                  ? "text-sm text-success-600 dark:text-success-500"
                  : "text-sm text-danger-600 dark:text-danger-500"
              }
            >
              {trend.value}
            </p>
          )}
        </div>
        <div className={`w-11 h-11 rounded-xl ${t.softBg} border ${t.border} flex items-center justify-center flex-shrink-0`}>
          <Icon className={`w-5 h-5 ${t.icon}`} strokeWidth={1.75} />
        </div>
      </div>
    </div>
  );
}
