import { ReactNode } from "react";

interface HeaderProps {
  title: string;
  actions?: ReactNode;
}

export default function Header({ title, actions }: HeaderProps) {
  return (
    <div className="h-16 bg-white border-b border-slate-200 px-8 flex items-center justify-between">
      <h2 className="text-xl text-slate-900">{title}</h2>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
