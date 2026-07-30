import TabHub from "./_TabHub";
import Incidents from "./Incidents";
import ClientComplaints from "./ClientComplaints";

// Operations ▸ Incidents now also absorbs client complaints (from the dissolved
// Client Relationships panel), per the consolidation map.
export default function IncidentsHub() {
  return (
    <TabHub
      tabs={[
        { key: "incidents", label: "Incidents", render: () => <Incidents /> },
        { key: "complaints", label: "Client Complaints", render: () => <ClientComplaints /> },
      ]}
    />
  );
}
