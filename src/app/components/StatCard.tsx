import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: string;
    positive: boolean;
  };
}

export default function StatCard({ title, value, icon: Icon, trend }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 hover:border-blue-200 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-slate-500 mb-1">{title}</p>
          <p className="text-3xl text-slate-900 mb-2">{value}</p>
          {trend && (
            <p className={`text-sm ${trend.positive ? "text-green-600" : "text-red-600"}`}>
              {trend.value}
            </p>
          )}
        </div>
        <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center">
          <Icon className="w-6 h-6 text-blue-600" strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
}
