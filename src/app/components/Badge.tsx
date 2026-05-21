import { tone, toneOfStatus, type Tone } from "../lib/tone";

type Props = {
  /** Pick a tone explicitly, or pass `status` to auto-map. */
  tone?: Tone;
  /** Auto-map known statuses ("Cleared", "Overdue", "Pending", ...) to a tone. */
  status?: string | null;
  className?: string;
  children?: React.ReactNode;
};

export default function Badge({ tone: toneProp, status, className = "", children }: Props) {
  const t: Tone = toneProp ?? toneOfStatus(status);
  return <span className={`${tone[t].badge} ${className}`}>{children ?? status ?? ""}</span>;
}
