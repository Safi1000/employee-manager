import { useState } from "react";
import { Search, FileText, Download } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";

const documents = [
  { id: 1, employee: "Muhammad Usman", type: "CNIC", fileName: "usman_cnic.pdf", uploadDate: "2026-04-10" },
  { id: 2, employee: "Muhammad Usman", type: "Passport", fileName: "usman_passport.pdf", uploadDate: "2026-04-10" },
  { id: 3, employee: "Ayesha Malik", type: "CNIC", fileName: "ayesha_cnic.pdf", uploadDate: "2026-04-11" },
  { id: 4, employee: "Ayesha Malik", type: "Passport", fileName: "ayesha_passport.pdf", uploadDate: "2026-04-11" },
  { id: 5, employee: "Bilal Ahmed", type: "CNIC", fileName: "bilal_cnic.pdf", uploadDate: "2026-04-12" },
];

export default function HRDocuments() {
  const [selectedEmployee, setSelectedEmployee] = useState("All Employees");
  const [searchQuery, setSearchQuery] = useState("");
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<any>(null);

  const filteredDocuments = documents.filter((doc) => {
    const matchEmp = selectedEmployee === "All Employees" || doc.employee === selectedEmployee;
    const matchSearch = doc.fileName.toLowerCase().includes(searchQuery.toLowerCase()) || doc.employee.toLowerCase().includes(searchQuery.toLowerCase());
    return matchEmp && matchSearch;
  });

  const previewDocument = (doc: any) => {
    setSelectedDocument(doc);
    setIsPreviewModalOpen(true);
  };

  const downloadDocument = (doc: any) => {
    console.log("Downloading:", doc.fileName);
  };

  return (
    <>
      <Header title="Documents" />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <select
                value={selectedEmployee}
                onChange={(e) => setSelectedEmployee(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option>All Employees</option>
                <option>Muhammad Usman</option>
                <option>Ayesha Malik</option>
                <option>Bilal Ahmed</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Employee</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Document Type</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">File Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Upload Date</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredDocuments.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-slate-900">{doc.employee}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                        <span className="text-sm text-slate-600">{doc.type}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{doc.fileName}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{doc.uploadDate}</td>
                    <td className="px-6 py-4 flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => downloadDocument(doc)}>
                        <Download className="w-4 h-4" strokeWidth={1.5} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => previewDocument(doc)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal isOpen={isPreviewModalOpen} onClose={() => setIsPreviewModalOpen(false)} title="Document Preview" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 pb-4 border-b border-slate-200">
            <div>
              <p className="text-sm text-slate-500 mb-1">Employee</p>
              <p className="text-sm text-slate-900">{selectedDocument?.employee}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Document Type</p>
              <p className="text-sm text-slate-900">{selectedDocument?.type}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">File Name</p>
              <p className="text-sm text-slate-900">{selectedDocument?.fileName}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Upload Date</p>
              <p className="text-sm text-slate-900">{selectedDocument?.uploadDate}</p>
            </div>
          </div>

          <div className="border border-slate-200 rounded-lg p-8 bg-slate-50 text-center min-h-[300px] flex items-center justify-center">
            <div>
              <FileText className="w-16 h-16 text-slate-400 mx-auto mb-4" strokeWidth={1.5} />
              <p className="text-sm text-slate-500">Document preview would appear here</p>
              <p className="text-xs text-slate-400 mt-2">{selectedDocument?.fileName}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="primary" size="md" className="flex-1" onClick={() => downloadDocument(selectedDocument)}>
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsPreviewModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
