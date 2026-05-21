import { ReactNode } from "react";

interface HeaderProps {
  title: string;
  /** Optional small subtitle rendered under the title (slate-500). */
  subtitle?: string;
  actions?: ReactNode;
}

export default function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <div className="bg-white border-b border-slate-200 px-4 md:px-8 py-3 md:py-2 md:min-h-16 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg md:text-xl text-slate-900 truncate">{title}</h2>
        {subtitle && (
          <p className="text-xs text-slate-500 truncate">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 md:gap-3 flex-wrap">{actions}</div>
      )}
    </div>
  );
}
