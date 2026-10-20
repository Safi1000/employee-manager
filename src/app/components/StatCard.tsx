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
  /** Tone drives the icon chip and, for status tones, the figure itself. */
  tone?: Tone;
  /** Makes the whole tile a button (open the figure's detail). */
  onClick?: () => void;
}

// Status tones colour the figure (a red overdue total should read red); brand,
// info and neutral keep the figure in ink so a row of tiles stays calm.
const FIGURE_TONED: Tone[] = ["success", "danger", "warning"];

export default function StatCard({ title, value, icon: Icon, trend, tone: toneProp = "brand", onClick }: StatCardProps) {
  const t = tone[toneProp];
  const figure = FIGURE_TONED.includes(toneProp) ? t.text : "text-foreground";
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="lbl min-w-0">{title}</p>
        <span className={`w-8 h-8 rounded-lg ${t.softBg} flex items-center justify-center flex-shrink-0 -mt-1`}>
          <Icon className={`w-4 h-4 ${t.icon}`} strokeWidth={2} />
        </span>
      </div>
      <p className={`font-ledger text-2xl md:text-[28px] font-semibold tracking-tight leading-none mt-2 md:mt-3 ${figure}`}>{value}</p>
      {trend && (
        <p
          className={`text-xs font-medium mt-2 ${
            trend.positive ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"
          }`}
        >
          {trend.value}
        </p>
      )}
    </>
  );
  const cls = "block w-full text-left bg-card border border-border rounded-2xl p-4 md:p-5 transition-colors";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:border-brand-500/70`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
