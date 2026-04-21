import { Download } from "lucide-react";
import Button from "./Button";

interface ExportButtonProps {
  onExport: () => void;
  label?: string;
}

export default function ExportButton({ onExport, label = "Export to Excel" }: ExportButtonProps) {
  return (
    <Button variant="secondary" size="md" onClick={onExport}>
      <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
      {label}
    </Button>
  );
}
