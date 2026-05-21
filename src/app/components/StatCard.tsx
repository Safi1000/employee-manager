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
    <div className={`${t.statCard} p-6 hover:shadow-sm transition-shadow`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">{title}</p>
          <p className={`text-3xl mb-2 ${t.text}`}>{value}</p>
          {trend && (
            <p
              className={
                trend.positive
                  ? "text-sm text-success-600"
                  : "text-sm text-danger-600"
              }
            >
              {trend.value}
            </p>
          )}
        </div>
        <div className={`w-12 h-12 rounded-lg ${t.softBg} flex items-center justify-center`}>
          <Icon className={`w-6 h-6 ${t.icon}`} strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
}
