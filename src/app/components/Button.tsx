import { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `ink` is the solid dark button (the final "do it" action on paper). */
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success" | "ink";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

export default function Button({
  variant = "primary",
  size = "md",
  children,
  className = "",
  ...props
}: ButtonProps) {
  const baseStyles =
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

  const variantStyles = {
    primary: "bg-brand-500 text-[#241a06] hover:bg-brand-600 shadow-sm",
    secondary: "bg-card text-foreground border border-border hover:border-brand-500/60 hover:bg-accent",
    ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
    danger: "bg-danger-600 text-[#fff] hover:bg-danger-700",
    success: "bg-success-600 text-[#fff] hover:bg-success-700",
    ink: "bg-foreground text-background hover:opacity-90",
  };

  const sizeStyles = {
    sm: "px-3 py-1.5 text-sm min-h-8",
    md: "px-4 py-2 text-sm min-h-10",
    lg: "px-6 py-2.5 text-base min-h-11",
  };

  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
